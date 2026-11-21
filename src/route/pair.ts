import { recommend, type PolicyData } from "./policy.ts";
import { RouteError } from "./errors.ts";
import { ageSeconds, DEFAULT_POLICY, ROUTED_DRIVERS, routeInput } from "./types.ts";
import type { Effort, Role, RouteInput, Target } from "./types.ts";
import { modelWindowPolicy } from "../quota/window-policy.ts";

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
  const order = (drivers: string[]) => [...drivers].sort((a, b) => {
    const rank = (d: string) => {
      const i = config.providerPreference.indexOf(d);
      return i < 0 ? config.providerPreference.length : i;
    };
    return rank(a) - rank(b);
  });
  const others = order([legacyOther, ...ROUTED_DRIVERS.filter(d => d !== legacyOther && d !== input.authorProvider)]);
  const driverOf = (t: Target) => data.catalog.find(p => p.providerInstanceId === t.providerInstanceId)!.driverKind;
  const mainRole = input.mainRole ?? "builder", peerRole = input.peerRole ?? "builder";
  const choose = (driver: string, role: Role, effort: Effort | undefined, main: boolean, excluded?: string, alternate = false) => {
    const pin = config.pins[role], benchmark = !!config.benchmark && !pin;
    const request = pairRequest(role, driver, effort, input.authorProvider, main, benchmark);
    const model = driver === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5";
    const catalog = data.catalog.filter(p => p.driverKind === driver).map(p => ({ ...p,
      models: p.models.filter(m => m.id !== excluded && (benchmark || pin || alternate || driver === "antigravity" || m.id === model)) }));
    try {
      const history = historyFor?.(request) ?? data.history;
      const result = recommend(request, { ...data, catalog, ...(history ? { history } : {}) });
      return pairTarget(result);
    } catch (error) {
      if (!(error instanceof RouteError) || error.code !== "no_candidate") throw error;
      return null;
    }
  };
  // A waiver requires live-catalog presence and fresh quota refusal on every
  // runnable instance. Missing catalog, unknown quota and HTTP 429 are insufficient.
  const pressure = (driver: string) => {
    const providers = data.catalog.filter(p => p.driverKind === driver && p.canRunChildTask && p.models.length);
    return providers.length > 0 && providers.every(p => {
      const q = data.quota[p.providerInstanceId], age = ageSeconds(q?.observedAt, data.now);
      if (age === null || age * 1000 >= config.quotaMaxAgeMs || q?.incomplete) return false;
      if (q?.activeStop) return true;
      const c = data.capacity?.[p.providerInstanceId];
      if (c?.creditFunded) return false;
      const advice = modelWindowPolicy(q!.windows, driver === "claudeAgent" ? "claude-opus-5-5" : "", data.now,
        config.minimumRemaining, config.paceMargin);
      return !!advice.gate || !!advice.limit;
    });
  };
  const first = (drivers: string[], role: Role, effort: Effort | undefined, main: boolean, excluded?: string) => {
    for (const driver of drivers) {
      const target = choose(driver, role, effort, main, excluded);
      if (target) return target;
    }
    return null;
  };
  let main = first(others, mainRole, input.mainEffort, true);
  let peer: Target | null = null, quotaException = false;
  if (main) peer = first(order([input.authorProvider, ...others.filter(d => d !== driverOf(main!))]),
    peerRole, input.peerEffort, false, main.model);
  const pressured = (drivers: string[]) => {
    const present = drivers.filter(d => data.catalog.some(p => p.driverKind === d && p.canRunChildTask && p.models.length));
    return present.length > 0 && present.every(pressure);
  };
  if (input.allowQuotaException && (!main && pressured(others) ||
      main && !peer && pressured(ROUTED_DRIVERS.filter(d => d !== driverOf(main!))))) {
    const driver = main ? driverOf(main) : input.authorProvider;
    main ??= choose(driver, mainRole, input.mainEffort, true);
    if (main) {
      peer = choose(driver, peerRole, input.peerEffort, false, main.model, true);
      quotaException = !!main && (!!peer || driver === input.authorProvider);
    }
  }
  const status = main && peer ? "complete" : main ? "partial" : "unavailable";
  const pinConflict = status !== "complete" && !!(config.pins[mainRole] || config.pins[peerRole]);
  return { status, code: pinConflict ? "pin_conflict" : quotaException ? "quota_exception" : status === "complete" ? "review_pair" : "pair_unavailable",
    main, peer, quotaException, reasons: [quotaException ? peer ? "Fresh quota pressure permits two different models on the same provider" : "Fresh quota pressure permits the returned same-provider main reviewer"
      : status === "complete" ? "Main reviewer uses the other provider; peer uses an independent model"
      : pinConflict ? "Explicit role pin conflicts with an available independent pair; authority required to change it"
      : "Independent pair unavailable; unknown quota or missing catalog never waives separation"] };
}
