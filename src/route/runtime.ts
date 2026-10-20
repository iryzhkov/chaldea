import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { loadState, emptyState } from "../quota/state.ts";
import { loadHeadroomConfig } from "../quota/codex-balance.ts";
import { capacitySnapshot, mergeSnapshots, readSnapshotsDetailed, snapshotProvider } from "../quota/fleet.ts";
import { capacityKey } from "../quota/account.ts";
import { classifyCapacity } from "../quota/capacity.ts";
import { loadCapacityConfig } from "../quota/capacity-config.ts";
import { metricNow, newProvider } from "../quota/headroom.ts";
import { discoverServerUrl, switchPort } from "../t3/adapter.ts";
import type { SwitchProvider } from "../t3/adapter.ts";
import { readToken } from "../quota/run.ts";
import { loadRouteConfig } from "./config.ts";
import { collectClaudeUsage, claudeCacheFile, claudeSourceId } from "./claude-usage.ts";
import { collectAnalytics } from "./analytics.ts";
import { collectScores } from "./snapshot.ts";
import { RouteState } from "./state.ts";
import { reviewPairInput, type ReviewPairResult } from "./pair.ts";
import { RouteError, routeFailure } from "./errors.ts";
import type { PolicyData } from "./policy.ts";
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
export interface RouteOptions {
  home?: string; configPath?: string; now?: number;
  catalog?: () => Promise<ReadonlyArray<CatalogProvider>>; fetcher?: typeof fetch;
}
export async function collectRouteContext(options: RouteOptions = {}) {
  try { return await collectContext(options); } catch (error) { throw routeFailure(error); }
}
async function collectContext(options: RouteOptions) {
  const now = options.now ?? Date.now();
  const config = (() => { try { return loadRouteConfig(options.home ?? homedir(), options.configPath ?? process.env.CHALDEA_ROUTE_CONFIG); }
    catch { throw new RouteError("config", "Route configuration unreadable or invalid"); } })();
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
  } catch { throw new RouteError("usage_unavailable", "Quota observer state unreadable; refusing to ignore possible active stops"); }
  let catalog: ReadonlyArray<CatalogProvider>;
  if (options.catalog) { try { catalog = await options.catalog(); } catch { throw new RouteError("catalog_unavailable", "T3 catalog unavailable"); } }
  else {
    try {
      const url = discoverServerUrl(config.t3BaseDir);
      if (!url) throw new Error();
      catalog = routeCatalog((await switchPort({ serverUrl: url, token: readToken(config.tokenFile) }).catalog()).providers);
    } catch { throw new RouteError("catalog_unavailable", "T3 catalog unavailable; no routing recommendation"); }
  }
  const id = config.claudeUsage.providerInstanceId;
  const claudeBound = catalog.some(p => p.providerInstanceId === id && p.driverKind === "claudeAgent" && p.canRunChildTask);
  const usage = await collectClaudeUsage({ ...config.claudeUsage, enabled: config.claudeUsage.enabled && claudeBound, cacheFile: claudeCacheFile(options.home ?? homedir(), claudeSourceId(config.claudeUsage)), now,
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
  const scores = await collectScores(config.scores, join(config.cacheDir, "aa-scores.json"), now, options.fetcher);
  if (scores.reason) reasons.push("AA " + scores.reason);
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
  const reporting = (() => { try { return loadHeadroomConfig(options.home ?? homedir(), config.quotaConfigFile); }
    catch { throw new RouteError("config", "Quota configuration unreadable or invalid"); } })();
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
  const stoppedAccounts = new Set(capacityState.headroom.providers.filter(p => p.accountKey && quota[p.alias]?.activeStop)
    .map(p => capacityKey(p.driver, p.accountKey!)));
  const localHost = reporting.fleet?.host ?? "local";
  const localStops = new Set(Object.entries(quota).filter(([, q]) => q.activeStop).map(([id]) => id));
  // Keep aliases separate until reconciliation so local conflicts survive the wire
  // snapshot's account deduplication. Conflict advice never enters the closed schema.
  const localSnapshots = capacityState.headroom.providers.map(p => capacitySnapshot(localHost, [p], localStops, now));
  const fleet = await readSnapshotsDetailed(reporting.fleet, now, options.fetcher);
  const merged = mergeSnapshots([...fleet.snapshots, ...localSnapshots], now);
  const capacity: Record<string, ReturnType<typeof classifyCapacity>> = {};
  const boundCatalog = catalog.map(p => {
    let row = capacityState.headroom.providers.find(r => r.alias === p.providerInstanceId);
    const key = mappings.get(p.providerInstanceId) ?? p.accountKey ?? row?.accountKey;
    const account = key ? merged.get(capacityKey(p.driverKind, key)) : undefined;
    const stop = !!quota[p.providerInstanceId]?.activeStop || !!key && stoppedAccounts.has(capacityKey(p.driverKind, key));
    if (account) {
      const observed = row;
      row = snapshotProvider(account, p.providerInstanceId);
      // All aliases use reconciled capacity. Spend-control admission remains local:
      // remote credits cannot create or refresh the proof of a funded lane.
      if (observed?.accountKey === account.accountKey && observed.driver === account.provider) {
        row.ordinaryUsageAllowed = observed.ordinaryUsageAllowed;
        if (observed.burnHistory) row.burnHistory = observed.burnHistory;
        if (observed.spendControlReached.value === true) row.spendControlReached = observed.spendControlReached;
        if (metricNow(observed.credits, now).state === "fresh" &&
            isDeepStrictEqual(observed.credits.value, account.credits) && observed.creditExpiresAt === account.creditExpiresAt) {
          row.credits = observed.credits;
          row.spendControlReached = observed.spendControlReached;
        }
      }
      quota[p.providerInstanceId] = { observedAt: account.observedAt, windows: account.windows, activeStop: account.activeStop || stop,
        incomplete: account.conflicts.some(c => c.includes("reset epoch") && !/^seven_day_/.test(c)) };
      reasons.push(p.providerInstanceId + " account " + key + " observed on " + account.host + "; age " + account.ageSeconds + "s");
    }
    if (row) {
      const classified = classifyCapacity(row, account?.activeStop || stop, now, capacityConfig);
      if (quota[p.providerInstanceId]?.incomplete) {
        classified.reasons.push("conflicting reset epoch; included capacity unknown");
        if (!classified.creditFunded && !["tight", "stopped"].includes(classified.class)) classified.class = "unknown";
      }
      capacity[p.providerInstanceId] = classified;
    }
    return { ...p, canRunChildTask: p.canRunChildTask && !blockedInstances.has(p.providerInstanceId), ...(key ? { accountKey: key } : {}) };
  });
  const data: PolicyData = { catalog: boundCatalog, quota, analytics: analytics.value, scores: scores.value, now, config, capacity };
  return { data, config, reasons, fleet: { readiness: fleet.readiness, freshAccounts: mergeSnapshots(fleet.snapshots, now).size },
    provenance: Object.fromEntries(boundCatalog.map(p => {
      const row = capacityState.headroom.providers.find(r => r.alias === p.providerInstanceId);
      const account = p.accountKey ? merged.get(capacityKey(p.driverKind, p.accountKey)) : undefined;
      return [p.providerInstanceId, { source: account && account.host !== localHost ? "fleet:" + account.host : row?.included.source ?? "unknown",
        bindingSource: mappings.has(p.providerInstanceId) ? "configured" : catalog.find(c => c.providerInstanceId === p.providerInstanceId)?.accountKey ? "catalog" : row?.accountKey ? "observer" : "unbound",
        conflicts: account?.conflicts ?? [] }];
    })) };
}
export async function routeReviewPair(value: unknown, options: RouteOptions = {}): Promise<ReviewPairResult> {
  const input = reviewPairInput(value);
  const context = await collectRouteContext(options);
  const routing = new RouteState(context.config.routeStateFile);
  try { return routing.reviewPair(input, context.data); } finally { routing.close(); }
}
export async function route(value: unknown, options: RouteOptions = {}): Promise<RouteResult> {
  const input = routeInput(value);
  const context = await collectRouteContext(options);
  const { config, reasons, data } = context;
  const routing = new RouteState(config.routeStateFile);
  try {
    const result = routing.recommend(input, data, config.scores.host,
      config.scores.host === config.announceHost && !input.effortOverride);
    if (config.scores.enabled && config.scores.host === config.announceHost) {
      try { await routing.flush({ url: config.scores.url, helper: config.scores.tokenHelper, ...(options.fetcher ? { fetch: options.fetcher } : {}) }); }
      catch { reasons.push("Route-change publication deferred; routing continues"); }
      if (routing.pending()) reasons.push("Route-change event retained in durable outbox for retry");
    }
    if (!config.scores.enabled && routing.pending()) reasons.push("Route-change event queued; snapshot transport not configured");
    if (result.diagnostics) {
      result.diagnostics.fleet = context.fleet;
      for (const [key, q] of Object.entries(result.diagnostics.quota)) {
        const id = data.catalog.find(p => key.startsWith(p.providerInstanceId + ":"))?.providerInstanceId;
        if (id) Object.assign(q, context.provenance[id]);
      }
    }
    result.reasons.unshift(...reasons);
    return result;
  } finally { routing.close(); }
}
