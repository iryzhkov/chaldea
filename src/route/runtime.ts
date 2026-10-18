import { homedir } from "node:os";
import { join } from "node:path";
import { loadState, emptyState } from "../quota/state.ts";
import { loadHeadroomConfig } from "../quota/codex-balance.ts";
import { capacitySnapshot, mergeSnapshots, readSnapshots, snapshotProvider } from "../quota/fleet.ts";
import { capacityKey } from "../quota/account.ts";
import { classifyCapacity } from "../quota/capacity.ts";
import { loadCapacityConfig } from "../quota/capacity-config.ts";
import { metricNow, newProvider } from "../quota/headroom.ts";
import { discoverServerUrl, switchPort } from "../t3/adapter.ts";
import type { SwitchProvider } from "../t3/adapter.ts";
import { readToken } from "../quota/run.ts";
import { loadRouteConfig } from "./config.ts";
import { collectClaudeUsage, claudeCacheFile } from "./claude-usage.ts";
import { collectAnalytics } from "./analytics.ts";
import { recommend } from "./policy.ts";
import { routeInput } from "./types.ts";
import type { CatalogProvider, Quota, RouteResult } from "./types.ts";

/** The same cached provider/model descriptors used by orchestrator_capabilities.
 * Never starts a probe, refreshes a provider or launches a child.
 */
export function routeCatalog(providers: ReadonlyArray<SwitchProvider>): CatalogProvider[] {
  return providers.map(p => ({
    providerInstanceId: p.instanceId, ...(p.quotaAccountKey ? { accountKey: p.quotaAccountKey } : {}), driverKind: p.driver,
    canRunChildTask: p.enabled && p.installed && p.availability !== "unavailable" &&
      ["ready", "warning"].includes(p.status) && p.auth.status === "authenticated",
    models: p.models.map(m => ({ id: m.slug, options: m.capabilities?.optionDescriptors ?? [] })),
  }));
}
export async function route(value: unknown, options: {
  home?: string; configPath?: string; now?: number;
  catalog?: () => Promise<ReadonlyArray<CatalogProvider>>; fetcher?: typeof fetch;
} = {}): Promise<RouteResult> {
  const input = routeInput(value);
  const now = options.now ?? Date.now();
  const config = loadRouteConfig(options.home ?? homedir(), options.configPath ?? process.env.CHALDEA_ROUTE_CONFIG);
  const reasons: string[] = [];
  const quota: Record<string, Quota> = {};
  let state = emptyState();
  try {
    state = loadState(config.stateFile, now);
    for (const p of state.headroom.providers) {
      const windows = metricNow(p.included, now);
      quota[p.alias] = { observedAt: windows.observedAt, windows: ["fresh", "stale"].includes(windows.state) ? windows.value ?? [] : [],
        activeStop: false };
    }
    for (const stop of state.parked.values()) {
      // Unknown reset remains an active stop until the observer confirms recovery.
      if (stop.resetAt === null || !Number.isFinite(Date.parse(stop.resetAt)) || Date.parse(stop.resetAt) > now) {
        const q = quota[stop.provider] ?? { observedAt: null, windows: [], activeStop: false };
        quota[stop.provider] = { ...q, activeStop: true };
      }
    }
  } catch { throw new Error("Quota observer state unreadable; refusing to ignore possible active stops"); }
  let catalog: ReadonlyArray<CatalogProvider>;
  if (options.catalog) catalog = await options.catalog();
  else {
    try {
      const url = discoverServerUrl(config.t3BaseDir);
      if (!url) throw new Error();
      catalog = routeCatalog((await switchPort({ serverUrl: url, token: readToken(config.tokenFile) }).catalog()).providers);
    } catch { throw new Error("T3 catalog unavailable; no routing recommendation"); }
  }
  const id = config.claudeUsage.providerInstanceId;
  const claudeBound = catalog.some(p => p.providerInstanceId === id && p.driverKind === "claudeAgent" && p.canRunChildTask);
  const usage = await collectClaudeUsage({ ...config.claudeUsage, enabled: config.claudeUsage.enabled && claudeBound, cacheFile: claudeCacheFile(options.home ?? homedir(), config.claudeUsage.credentialFile), now,
    ...(options.fetcher ? { fetcher: options.fetcher } : {}) });
  if (usage.reason) reasons.push(!config.claudeUsage.enabled || claudeBound ? usage.reason : "Claude collector binding absent or unavailable; skipped");
  if (claudeBound) {
    const prior = quota[id] ?? { observedAt: null, windows: [], activeStop: false };
    if (usage.value && now - Date.parse(usage.value.observedAt) < config.quotaMaxAgeMs) {
      quota[id] = { ...usage.value, activeStop: prior.activeStop };
    } else if ((prior.windows.length === 0 || prior.observedAt === null || now - Date.parse(prior.observedAt) >= config.quotaMaxAgeMs) && config.claudeWeeklyTarget) {
      const t = config.claudeWeeklyTarget;
      const reset = Date.parse(t.window.resetsAt!);
      if (Date.parse(t.observedAt) <= now && reset > now && reset - now <= 7 * 86_400_000) {
        // Operator estimate lasts until the stated reset, with its real age reported.
        quota[id] = { observedAt: t.observedAt, windows: [t.window], activeStop: prior.activeStop, operatorEstimate: true };
        reasons.push("Claude pacing uses operator-set weekly target, an estimate valid until its reset");
      } else reasons.push("Claude operator weekly target expired or invalid for the current window");
    }
  }
  const analytics = await collectAnalytics(join(config.cacheDir, "slopalytics.json"), now, options.fetcher);
  if (analytics.reason) reasons.push("Slopalytics " + analytics.reason);
  const capacityState = { parked: state.parked, headroom: { ...state.headroom, providers: catalog
    .filter(p => p.driverKind === "codex" || p.driverKind === "claudeAgent").map(p => {
      const original = state.headroom.providers.find(r => r.alias === p.providerInstanceId);
      const row = { ...(original ?? newProvider(p.providerInstanceId, p.driverKind)) };
      if (p.providerInstanceId === id && usage.value?.accountKey) row.accountKey = usage.value.accountKey;
      const q = quota[p.providerInstanceId];
      if (q) row.included = { state: "fresh", error: null, source: q.operatorEstimate ? "operator-weekly-target" : row.included.source,
        observedAt: q.observedAt, value: q.windows.map(w => ({ ...w, id: (w as { id?: string }).id ?? w.kind, usedPercent: 100 - w.remainingPercent })) };
      return row;
    }) } };
  const capacityConfig = { ...loadCapacityConfig(options.home ?? homedir(), config.capacityConfigFile),
    paceMargin: config.paceMargin, minimumRemaining: config.minimumRemaining, maxAgeMs: config.quotaMaxAgeMs };
  const reporting = loadHeadroomConfig(options.home ?? homedir(), config.quotaConfigFile);
  // Bind a shared account only to a locally known T3 instance. A host alias is not
  // an account identity and a remote host's alias never selects a local login.
  const mappings = new Map<string, string>();
  const blockedInstances = new Set<string>();
  for (const ctx of reporting.contexts) if (ctx.accountKey)
    for (const alias of ctx.providers) mappings.set(alias, ctx.accountKey);
  for (const ctx of reporting.claudeContexts ?? []) if (ctx.accountKey) mappings.set(ctx.providerInstanceId, ctx.accountKey);
  for (const p of catalog) {
    const row = capacityState.headroom.providers.find(r => r.alias === p.providerInstanceId);
    if (!row) continue;
    const configured = mappings.get(p.providerInstanceId);
    const observer = state.headroom.providers.find(r => r.alias === p.providerInstanceId);
    const expected = configured ?? p.accountKey;
    if (observer?.included.error === "context_mismatch" || row.included.error === "context_mismatch" || row.credits.error === "context_mismatch" ||
        expected && (p.accountKey && expected !== p.accountKey || row.accountKey && expected !== row.accountKey)) {
      blockedInstances.add(p.providerInstanceId);
      reasons.push(p.providerInstanceId + ": configured account does not match the observed provider login; excluded");
    }
    const key = configured ?? p.accountKey ?? row.accountKey;
    if (key && row.accountKey !== key) {
      const clean = newProvider(row.alias, row.driver);
      clean.accountKey = key;
      capacityState.headroom.providers[capacityState.headroom.providers.indexOf(row)] = clean;
      quota[row.alias] = { observedAt: null, windows: [], activeStop: quota[row.alias]?.activeStop ?? false };
    } else if (key) row.accountKey = key;
  }
  const local = capacitySnapshot(reporting.fleet?.host ?? "local", capacityState.headroom.providers,
    new Set(Object.entries(quota).filter(([, q]) => q.activeStop).map(([id]) => id)), now);
  const shared = reporting.fleet ? await readSnapshots(reporting.fleet, now, options.fetcher) : [];
  const merged = mergeSnapshots([...shared, local], now);
  const capacity: Record<string, ReturnType<typeof classifyCapacity>> = {};
  const boundCatalog = catalog.map(p => {
    let row = capacityState.headroom.providers.find(r => r.alias === p.providerInstanceId);
    const key = mappings.get(p.providerInstanceId) ?? p.accountKey ?? row?.accountKey;
    const account = key ? merged.get(capacityKey(p.driverKind, key)) : undefined;
    const stop = quota[p.providerInstanceId]?.activeStop ?? false;
    if (account) {
      if (account.host !== local.host) row = snapshotProvider(account, p.providerInstanceId);
      quota[p.providerInstanceId] = { observedAt: account.observedAt, windows: account.windows, activeStop: account.activeStop || stop };
      reasons.push(p.providerInstanceId + " account " + key + " observed on " + account.host + "; age " + account.ageSeconds + "s");
    }
    if (row) capacity[p.providerInstanceId] = classifyCapacity(row, account?.activeStop || stop, now, capacityConfig);
    return { ...p, canRunChildTask: p.canRunChildTask && !blockedInstances.has(p.providerInstanceId), ...(key ? { accountKey: key } : {}) };
  });
  const result = recommend(input, { catalog: boundCatalog, quota, analytics: analytics.value, now, config, capacity });
  result.reasons.unshift(...reasons);
  return result;
}
