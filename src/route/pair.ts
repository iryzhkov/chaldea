import { capacityFor, recommend, type PolicyData } from "./policy.ts";
import { benchmarkCoverage } from "./benchmark.ts";
import { RouteError } from "./errors.ts";
import { ageSeconds, DEFAULT_POLICY, ROUTED_DRIVERS, routeInput } from "./types.ts";
import type { Effort, Role, RouteInput, Target } from "./types.ts";
import { modelWindowPolicy, antigravityExhaustion } from "../quota/window-policy.ts";

export interface ReviewPairInput {
  authorProvider: "codex" | "claudeAgent" | "antigravity";
  mainRole?: Role; peerRole?: Role;
  mainEffort?: Effort; peerEffort?: Effort;
  allowQuotaException?: boolean;
}
export interface ReviewPairResult {
  status: "complete" | "partial" | "unavailable";
  code: "review_pair" | "quota_exception" | "pair_unavailable" | "pin_conflict";
  main: Target | null; peer: Target | null;
  quotaException: boolean; reasons: string[];
}
export function reviewPairInput(value: unknown): ReviewPairInput {
  const v = value as ReviewPairInput;
  if (!v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).some(k => !["authorProvider", "mainRole", "peerRole", "mainEffort", "peerEffort", "allowQuotaException"].includes(k)) ||
      !ROUTED_DRIVERS.includes(v.authorProvider) ||
      v.allowQuotaException !== undefined && typeof v.allowQuotaException !== "boolean")
    throw new RouteError("usage", "Invalid review-pair input");
  routeInput({ role: v.mainRole ?? "builder", ...(v.mainEffort ? { effortOverride: v.mainEffort } : {}) });
  routeInput({ role: v.peerRole ?? "builder", ...(v.peerEffort ? { effortOverride: v.peerEffort } : {}) });
  return v;
}
export const pairTarget = (r: Target): Target => ({ providerInstanceId: r.providerInstanceId,
  model: r.model, options: r.options, ...(r.accountKey ? { accountKey: r.accountKey } : {}) });
export type PairHistory = (input: RouteInput) => PolicyData["history"];
/** Automatic benchmark efforts and exact overrides need the same selection/reservation key. */
export function pairRequest(role: Role, driver: string, effort: Effort | undefined,
  author: ReviewPairInput["authorProvider"], main: boolean, benchmark: boolean): RouteInput {
  return { role, ...(effort !== undefined || !benchmark
    ? { effortOverride: effort ?? (driver === "codex" ? "high" : "medium") } : {}),
    ...(main && driver !== author ? { authorProvider: author } : {}) };
}
/** Pure selection over one snapshot. No launches, refreshes, quota grants or reservations. */
export function recommendReviewPair(value: ReviewPairInput, data: PolicyData, historyFor?: PairHistory): ReviewPairResult {
  const input = reviewPairInput(value), config = { ...DEFAULT_POLICY, ...data.config };
  const legacyOther = input.authorProvider === "claudeAgent" ? "codex" : "claudeAgent";
  const driverOf = (t: Target) => data.catalog.find(p => p.providerInstanceId === t.providerInstanceId)!.driverKind;
  const mainRole = input.mainRole ?? "builder", peerRole = input.peerRole ?? "builder";
  const select = (driver: string, role: Role, effort: Effort | undefined, main: boolean,
    excluded: readonly string[] = [], alternate = false, withoutQuota = false) => {
    const pin = config.pins[role], benchmark = !!config.benchmark && !pin;
    const request = pairRequest(role, driver, effort, input.authorProvider, main, benchmark);
    if (driver === "antigravity" && benchmark) {
      const full = data.catalog.filter(p => p.driverKind === driver).map(p => ({ ...p,
        models: p.models.filter(m => !config.driverModels[driver] || config.driverModels[driver]!.includes(m.id)) }));
      if (!benchmarkCoverage(full, data.scores ?? null, config.bans, effort)[driver]?.complete) return null;
    }
    const model = driver === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5";
    const catalog = data.catalog.filter(p => p.driverKind === driver).map(p => ({ ...p,
      models: p.models.filter(m => !excluded.includes(m.id) &&
        !(driver === "antigravity" && (input.authorProvider === "codex" && m.id.startsWith("gpt-") ||
          input.authorProvider === "claudeAgent" && m.id.startsWith("claude-"))) &&
        (benchmark || pin || alternate || driver === "antigravity" || m.id === model)) }));
    try {
      const history = historyFor?.(request) ?? data.history;
      return recommend(request, { ...data, catalog, ...(history ? { history } : {}),
        ...(withoutQuota ? { quota: {}, capacity: {}, modelCapacity: new Map() } : {}) });
    } catch (error) {
      if (!(error instanceof RouteError) || error.code !== "no_candidate") throw error;
      return null;
    }
  };
  // Enumerate models only after the full catalog has passed coverage and admission.
  // Removing a previously considered model must never rescue incomplete coverage.
  function* choices(driver: string, role: Role, effort: Effort | undefined, main: boolean,
    excluded: readonly string[] = [], alternate = false, withoutQuota = false): Generator<Target> {
    const omitted = [...excluded];
    const bound = data.catalog.filter(p => p.driverKind === driver).reduce((n, p) => n + p.models.length, 0);
    for (let i = 0; i < bound; i++) {
      const next = select(driver, role, effort, main, omitted, alternate, withoutQuota);
      if (!next) break;
      yield* [next, ...next.alternatives].filter(t => t.model === next.model).map(pairTarget);
      omitted.push(next.model);
    }
  }
  const first = (drivers: string[], role: Role, effort: Effort | undefined, main: boolean, excluded: string[] = []) => {
    for (const driver of drivers) {
      const result = select(driver, role, effort, main, excluded);
      if (result) return pairTarget(result);
    }
    return null;
  };
  // Same rule as single routing: a preferred driver whose pick is ahead of its weekly pace
  // (known pace < 0) ranks after drivers whose pace is unknown or not ahead.
  const demoted = new Set<string>();
  const order = (drivers: string[], role: Role, effort: Effort | undefined, isMain: boolean, excluded: readonly string[] = []) => {
    if (!config.providerPreference.length) return [...drivers];
    const rank = (d: string) => {
      const i = config.providerPreference.indexOf(d);
      return i < 0 ? config.providerPreference.length : i;
    };
    const ahead = new Map(drivers.map(d => {
      const r = select(d, role, effort, isMain, excluded);
      const pace = r?.diagnostics?.quota[r.providerInstanceId + ":" + r.model]?.pace;
      return [d, pace !== undefined && pace !== null && pace < 0];
    }));
    const sorted = [...drivers].sort((a, b) => Number(ahead.get(a)) - Number(ahead.get(b)) || rank(a) - rank(b));
    for (const d of drivers) if (ahead.get(d) && sorted.indexOf(d) > [...drivers].sort((a, b) => rank(a) - rank(b)).indexOf(d)) demoted.add(d);
    return sorted;
  };
  const others = order([legacyOther, ...ROUTED_DRIVERS.filter(d => d !== legacyOther && d !== input.authorProvider)],
    mainRole, input.mainEffort, true);
  // Main candidates in choices() order, each with whether its own pace is ahead (known pace < 0).
  function* pacedChoices(driver: string): Generator<[Target, boolean]> {
    const omitted: string[] = [];
    const bound = data.catalog.filter(p => p.driverKind === driver).reduce((n, p) => n + p.models.length, 0);
    for (let i = 0; i < bound; i++) {
      const next = select(driver, mainRole, input.mainEffort, true, omitted);
      if (!next) break;
      for (const t of [next, ...next.alternatives].filter(t => t.model === next.model)) {
        const pace = next.diagnostics?.quota[t.providerInstanceId + ":" + t.model]?.pace;
        yield [pairTarget(t), pace !== undefined && pace !== null && pace < 0];
      }
      omitted.push(next.model);
    }
  }
  const preferred = config.providerPreference.length > 0;
  const preference = (d: string) => {
    const i = config.providerPreference.indexOf(d);
    return i < 0 ? config.providerPreference.length : i;
  };
  // With a preference, every not-ahead main candidate (in preference order) is tried before
  // any ahead-of-pace one, so backtracking within a driver cannot bypass pace ordering.
  // Without a preference this is the original single pass over others.
  const mainDrivers = preferred ? [...others].sort((a, b) => preference(a) - preference(b)) : others;
  const skipped = new Set<string>();
  let main: Target | null = null, peer: Target | null = null, quotaException = false;
  // Search for a complete independent pair before keeping a partial or considering a waiver.
  outer: for (const pass of preferred ? [false, true] : [null]) {
    for (const driver of mainDrivers) {
      for (const [candidate, ahead] of pacedChoices(driver)) {
        if (pass !== null && ahead !== pass) { if (!pass) skipped.add(driver); continue; }
        const partner = first(order([input.authorProvider, ...others.filter(d => d !== driver)],
          peerRole, input.peerEffort, false, [candidate.model]), peerRole, input.peerEffort, false, [candidate.model]);
        main ??= candidate;
        if (partner) { main = candidate; peer = partner; break outer; }
      }
    }
  }
  if (main && peer) for (const d of skipped)
    if (d !== driverOf(main) && preference(d) < preference(driverOf(main))) demoted.add(d);
  const primaryPressure = (driver: string) => {
    const providers = data.catalog.filter(p => p.driverKind === driver && p.canRunChildTask && p.models.length);
    return providers.length > 0 && providers.every(p => {
      const q = data.quota[p.providerInstanceId], age = ageSeconds(q?.observedAt, data.now);
      if (age === null || age * 1000 >= config.quotaMaxAgeMs || q?.incomplete) return false;
      if (q?.activeStop) return true;
      if (data.capacity?.[p.providerInstanceId]?.creditFunded) return false;
      const advice = modelWindowPolicy(q!.windows, driver === "claudeAgent" ? "claude-opus-5-5" : "",
        data.now, config.minimumRemaining, config.paceMargin);
      return !!advice.gate || !!advice.limit;
    });
  };
  const pressured = (drivers: string[], role: Role, effort: Effort | undefined, isMain: boolean, excluded: string[] = []) => {
    // Primary admission pressure is main's instance-wide rule, even for an instance that
    // cannot supply this role's anchor. Only Antigravity uses counterfactual model admission.
    const primaries = drivers.filter(d => d !== "antigravity" &&
      data.catalog.some(p => p.driverKind === d && p.canRunChildTask && p.models.length));
    if (!primaries.length || !primaries.every(primaryPressure)) return false;
    const targets = drivers.includes("antigravity") ? [...choices("antigravity", role, effort, isMain, excluded, !isMain, true)] : [];
    return primaries.length + targets.length > 0 && targets.every(target => {
      const q = data.quota[target.providerInstanceId], c = capacityFor(data, target.providerInstanceId, target.model);
      if (q?.activeStop || c?.class === "stopped" && c.reasons.some(r => r.startsWith("active usage stop"))) return true;
      if (antigravityExhaustion([...(q?.knownWindows ?? []), ...(q?.windows ?? [])], target.model, data.now, config.minimumRemaining)) return true;
      const age = ageSeconds(q?.observedAt, data.now);
      if (age === null || age * 1000 >= config.quotaMaxAgeMs || q?.incomplete || c?.creditFunded) return false;
      const advice = modelWindowPolicy(q!.windows, target.model, data.now, config.minimumRemaining, config.paceMargin, "antigravity");
      return !!advice.gate || !!advice.limit;
    });
  };
  if (input.allowQuotaException && (!main && pressured(others, mainRole, input.mainEffort, true) ||
      main && !peer && pressured(ROUTED_DRIVERS.filter(d => d !== driverOf(main!)),
        peerRole, input.peerEffort, false, [main.model]))) {
    const driver = main ? driverOf(main) : input.authorProvider;
    const chosen = main ?? first([driver], mainRole, input.mainEffort, true);
    main = chosen;
    if (main) {
      const alternate = select(driver, peerRole, input.peerEffort, false, [main.model], true);
      peer = alternate ? pairTarget(alternate) : null;
      quotaException = !!peer || driver === input.authorProvider;
    }
  }
  const status = main && peer ? "complete" : main ? "partial" : "unavailable";
  const pinConflict = status !== "complete" && !!(config.pins[mainRole] || config.pins[peerRole]);
  return { status, code: pinConflict ? "pin_conflict" : quotaException ? "quota_exception" : status === "complete" ? "review_pair" : "pair_unavailable",
    main, peer, quotaException, reasons: [quotaException ? peer ? "Fresh quota pressure permits two different models on the same provider" : "Fresh quota pressure permits the returned same-provider main reviewer"
      : status === "complete" ? "Main reviewer uses the other provider; peer uses an independent model"
      : pinConflict ? "Explicit role pin conflicts with an available independent pair; authority required to change it"
      : "Independent pair unavailable; unknown quota or missing catalog never waives separation",
      ...[...demoted].map(d => "Provider preference demoted " + d + " for pace: a candidate is ahead of its weekly pace")] };
}
