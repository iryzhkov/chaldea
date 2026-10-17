import { homedir } from "node:os";
import { join } from "node:path";
import { loadState, emptyState } from "../quota/state.ts";
import { classifyCapacities } from "../quota/capacity.ts";
import { loadCapacityConfig } from "../quota/capacity-config.ts";
import { metricNow, newProvider } from "../quota/headroom.ts";
import { discoverServerUrl, switchPort } from "../t3/adapter.ts";
import type { SwitchProvider } from "../t3/adapter.ts";
import { readToken } from "../quota/run.ts";
import { loadRouteConfig } from "./config.ts";
import { collectClaudeUsage } from "./claude-usage.ts";
import { collectAnalytics } from "./analytics.ts";
import { recommend } from "./policy.ts";
import { routeInput } from "./types.ts";
import type { CatalogProvider, Quota, RouteResult } from "./types.ts";

/** The same cached provider/model descriptors used by orchestrator_capabilities.
 * Never starts a probe, refreshes a provider or launches a child.
 */
export function routeCatalog(providers: ReadonlyArray<SwitchProvider>): CatalogProvider[] {
  return providers.map(p => ({
    providerInstanceId: p.instanceId, driverKind: p.driver,
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
  const usage = await collectClaudeUsage({ ...config.claudeUsage, enabled: config.claudeUsage.enabled && claudeBound, cacheFile: join(config.cacheDir, "claude-usage.json"), now,
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
      const q = quota[p.providerInstanceId];
      if (q) row.included = { state: "fresh", error: null, source: q.operatorEstimate ? "operator-weekly-target" : row.included.source,
        observedAt: q.observedAt, value: q.windows.map(w => ({ ...w, id: (w as { id?: string }).id ?? w.kind, usedPercent: 100 - w.remainingPercent })) };
      return row;
    }) } };
  const capacityConfig = { ...loadCapacityConfig(options.home ?? homedir(), config.capacityConfigFile),
    paceMargin: config.paceMargin, minimumRemaining: config.minimumRemaining, maxAgeMs: config.quotaMaxAgeMs };
  const capacity = classifyCapacities(capacityState, now, capacityConfig);
  const result = recommend(input, { catalog, quota, analytics: analytics.value, now, config, capacity });
  result.reasons.unshift(...reasons);
  return result;
}
