import { join } from "node:path";
import { hostname } from "node:os";
import { capacityKey } from "./account.ts";
import { newProvider, STALE_AFTER_MS } from "./headroom.ts";
import type { ProviderHeadroom } from "./headroom.ts";
import { validateSnapshot } from "./capacity-snapshot.ts";
import type { AccountSnapshot, CapacitySnapshot } from "./capacity-snapshot.ts";
export { validateSnapshot } from "./capacity-snapshot.ts";
export type { AccountSnapshot, CapacitySnapshot } from "./capacity-snapshot.ts";
import { cached, getJson } from "../route/cache.ts";
import { helperToken, publish } from "../events/publisher.ts";
import type { PublisherOptions } from "../events/publisher.ts";

export const FLEET_BUCKET_MS = 15 * 60000;
export interface FleetConfig { enabled: boolean; url: string; tokenHelper: string; host: string; cacheFile: string }
export interface ClaudeContext { providerInstanceId: string; credentialFile: string; enabled: boolean; accountKey?: string }
const key = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const obj = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid_capacity_snapshot");
  return v as Record<string, any>;
};
const fields = (v: Record<string, any>, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error("invalid_capacity_snapshot");
};
export function fleetConfig(raw: unknown, home: string): FleetConfig {
  const v = obj(raw ?? {});
  fields(v, ["enabled", "url", "tokenHelper", "host", "cacheFile"]);
  const c = { enabled: false, url: "", tokenHelper: "", host: hostname(),
    cacheFile: join(home, ".cache/chaldea/quota-fleet.json"), ...v } as FleetConfig;
  if (typeof c.enabled !== "boolean" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(c.host) ||
      !c.cacheFile.startsWith("/") || c.tokenHelper !== "" && !c.tokenHelper.startsWith("/")) throw new Error("invalid_quota_fleet_config");
  if (c.enabled) {
    const url = new URL(c.url);
    if (url.protocol !== "https:" || url.username || url.password || !c.tokenHelper) throw new Error("invalid_quota_fleet_config");
  }
  return c;
}
export function claudeContexts(raw: unknown): ClaudeContext[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 16) throw new Error("invalid_claude_contexts");
  const seen = new Set<string>();
  return raw.map(value => {
    const v = obj(value);
    fields(v, ["providerInstanceId", "credentialFile", "enabled", "accountKey"]);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v.providerInstanceId) || seen.has(v.providerInstanceId) ||
        typeof v.credentialFile !== "string" || !v.credentialFile.startsWith("/") ||
        typeof v.enabled !== "boolean" || v.accountKey !== undefined && !key(v.accountKey)) throw new Error("invalid_claude_context");
    seen.add(v.providerInstanceId);
    return v as unknown as ClaudeContext;
  });
}
export function capacitySnapshot(host: string, providers: readonly ProviderHeadroom[], stops: ReadonlySet<string>, now: number): CapacitySnapshot {
  const accounts = new Map<string, AccountSnapshot>();
  for (const p of providers) {
    if (!p.accountKey || !["codex", "claudeAgent"].includes(p.driver)) continue;
    // Use the oldest included metric's observation time; packaging never rejuvenates data.
    const metrics = [p.included, p.credits, p.manualResets];
    const fresh = metrics.filter(m => m.state === "fresh" && m.value !== null && m.observedAt &&
      now >= Date.parse(m.observedAt) && now - Date.parse(m.observedAt) < STALE_AFTER_MS);
    if (!fresh.length) continue;
    const observedAt = fresh.map(m => m.observedAt!).sort((a, b) => Date.parse(a) - Date.parse(b))[0]!;
    const usable = (m: typeof metrics[number]) => fresh.includes(m);
    const a: AccountSnapshot = { provider: p.driver as AccountSnapshot["provider"], accountKey: p.accountKey,
      observedAt, maxAgeMs: STALE_AFTER_MS,
      windows: usable(p.included) ? (p.included.value ?? []).slice(0, 8).map(w => ({
        id: w.id, kind: w.kind, usedPercent: w.usedPercent, remainingPercent: w.remainingPercent,
        windowDurationMins: w.windowDurationMins, resetsAt: w.resetsAt,
      })) : [],
      credits: usable(p.credits) && p.credits.value ? { balance: p.credits.value.balance, hasCredits: p.credits.value.hasCredits, unlimited: p.credits.value.unlimited } : null,
      resets: usable(p.manualResets) && p.manualResets.value ? { availableCount: p.manualResets.value.availableCount, nextExpiresAt: p.manualResets.value.nextExpiresAt } : null,
      ...(p.creditExpiresAt ? { creditExpiresAt: p.creditExpiresAt } : {}), activeStop: stops.has(p.alias) };
    const id = capacityKey(a.provider, a.accountKey), prior = accounts.get(id);
    if (!prior || Date.parse(a.observedAt) > Date.parse(prior.observedAt)) accounts.set(id, a);
  }
  return validateSnapshot({ version: 1, host, generatedAt: new Date(now).toISOString(), accounts: [...accounts.values()].slice(0, 32) });
}
export function mergeSnapshots(snapshots: readonly CapacitySnapshot[], now: number): Map<string, AccountSnapshot & { host: string; ageSeconds: number }> {
  const result = new Map<string, AccountSnapshot & { host: string; ageSeconds: number }>();
  for (const s of snapshots) for (const a of validateSnapshot(s).accounts) {
    const age = now - Date.parse(a.observedAt);
    if (age < 0 || age >= a.maxAgeMs || Date.parse(s.generatedAt) > now) continue;
    const id = capacityKey(a.provider, a.accountKey), prior = result.get(id);
    if (!prior || Date.parse(a.observedAt) > Date.parse(prior.observedAt) ||
        a.observedAt === prior.observedAt && s.host < prior.host) result.set(id, { ...a, host: s.host, ageSeconds: Math.floor(age / 1000) });
  }
  return result;
}
export function snapshotProvider(a: AccountSnapshot, alias: string): ProviderHeadroom {
  const row = newProvider(alias, a.provider);
  row.accountKey = a.accountKey;
  if (a.creditExpiresAt) row.creditExpiresAt = a.creditExpiresAt;
  const metric = <T>(value: T) => ({ value, state: "fresh" as const, source: "fleet", observedAt: a.observedAt, error: null });
  row.included = metric(a.windows); row.credits = metric(a.credits); row.manualResets = metric(a.resets);
  return row;
}
export async function publishSnapshot(config: FleetConfig, snapshot: CapacitySnapshot, now: number, options: PublisherOptions = {}): Promise<void> {
  if (!config.enabled) return;
  const bucket = Math.floor(now / FLEET_BUCKET_MS);
  // Persistent reservation and lock survive process restart and concurrent callers.
  await cached(config.cacheFile, FLEET_BUCKET_MS, bucket * FLEET_BUCKET_MS, v => v === true, async () => {
    const ok = await publish({ key: "capacity:" + config.host + ":" + bucket, source: "quota", host: config.host,
      payload: { v: 1, kind: "quota_headroom_snapshot", title: "Quota account capacity", data: { capacity: validateSnapshot(snapshot) } } },
      { url: config.url, helper: config.tokenHelper, ...options });
    if (!ok) throw new Error("quota_snapshot_unavailable");
    return true;
  });
}
export async function readSnapshots(config: FleetConfig, now: number, fetcher: typeof fetch = fetch,
  tokenReader: typeof helperToken = helperToken): Promise<CapacitySnapshot[]> {
  if (!config.enabled) return [];
  try {
    const token = await tokenReader(config.tokenHelper, { key: "", source: "quota", host: config.host,
      payload: { kind: "quota_headroom_snapshot" } }, "read");
    const url = new URL("/api/v1/events", config.url);
    url.searchParams.set("source", "quota"); url.searchParams.set("kind", "quota_headroom_snapshot");
    url.searchParams.set("from", new Date(now - STALE_AFTER_MS).toISOString());
    url.searchParams.set("to", new Date(now).toISOString()); url.searchParams.set("limit", "1000");
    const snapshots: CapacitySnapshot[] = [];
    // Bounded pagination, never silently treat a partial fleet view as complete.
    for (let page = 0; page < 4; page++) {
      const response = obj(await getJson(url.toString(), { headers: { authorization: "Bearer " + token } }, fetcher, 2 * 1024 * 1024));
      if (!Array.isArray(response.events) || response.events.length > 1000) throw new Error();
      for (const event of response.events) {
        if (event.source !== "quota" || event.kind !== "quota_headroom_snapshot" || event.provenance?.type !== "verified") continue;
        try {
          const s = validateSnapshot(event.data?.capacity);
          if (s.host === event.host) snapshots.push(s);
        } catch { /* Older headroom records and malformed snapshots are not capacity. */ }
      }
      if (response.next_cursor === null) return snapshots;
      if (typeof response.next_cursor !== "string" || response.next_cursor.length > 1024) throw new Error();
      url.searchParams.set("cursor", response.next_cursor);
    }
  } catch { /* Missing helper, stale store and transport failure all keep local routing. */ }
  return [];
}
