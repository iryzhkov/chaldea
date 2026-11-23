import { benchmarkCoverage, benchmarkEfforts, compareBenchmark, targetEffort } from "./benchmark.ts";
import { RouteError } from "./errors.ts";
import { modelWindowPolicy, antigravityExhaustion } from "../quota/window-policy.ts";
import type { Capacity } from "../quota/capacity.ts";
import { banned, compareScores, emptyHistory, inProbation, driverPickKey, roleKey, scoreFor, targetEligible, trialAvailable } from "./targets.ts";
import type { RoutingHistory } from "./targets.ts";
import { validateScores } from "./scores.ts";
import type { ScoreSnapshot } from "./scores.ts";
import { ageSeconds, DEFAULT_POLICY, EFFORT_OPTION_IDS, PAIRS, PRIMARY_DRIVERS, routeInput } from "./types.ts";
import type { Analytics, CatalogProvider, PolicyConfig, Provider, Quota, RouteInput, RouteResult, Target } from "./types.ts";

export interface PolicyData {
  catalog: ReadonlyArray<CatalogProvider>;
  quota: Readonly<Record<string, Quota>>;
  analytics: Analytics | null;
  scores?: ScoreSnapshot | null;
  history?: RoutingHistory;
  capacity?: Readonly<Record<string, Capacity>>;
  /** Antigravity capacity per instance, then per model id. Kept apart from the provider-wide
   * map so no instance or model id can collide with or overwrite another instance's entry. */
  modelCapacity?: ReadonlyMap<string, ReadonlyMap<string, Capacity>>;
  now: number;
  config?: Partial<PolicyConfig>;
}
/** Capacity for one routed model: Antigravity's per-model entry when the runtime supplied one,
 * otherwise the provider-wide entry. Claude/Codex have only the latter. */
export function capacityFor(data: Pick<PolicyData, "capacity" | "modelCapacity">, instance: string, model: string): Capacity | undefined {
  return data.modelCapacity?.get(instance)?.get(model) ?? data.capacity?.[instance];
}
/** Pure policy. No IO, provider launch, feed posting or quota redemption. */
export function recommend(input: RouteInput, data: PolicyData): RouteResult {
  return recommendPolicy(input, data);
}
function recommendPolicy(input: RouteInput, data: PolicyData, retainOverrideScores = false): RouteResult {
  routeInput(input);
  const config = { ...DEFAULT_POLICY, ...data.config };
  const reasons: string[] = [];
  const ages: Record<string, number | null> = {};
  const diagnostics: NonNullable<RouteResult["diagnostics"]> = { quality_source: "fixed_policy", quota: {} };
  const effort = input.effortOverride ?? (input.role === "builder" ? "high" : "medium");
  const pair = PAIRS[input.role];
  const history = data.history ?? emptyHistory();
  const pin = config.pins[input.role];
  // An allowlisted driver exposes only its operator-chosen models to coverage and selection.
  const catalog = data.catalog.map(p => {
    const allowed = config.driverModels?.[p.driverKind];
    return allowed ? { ...p, models: p.models.filter(m => allowed.includes(m.id)) } : p;
  });
  let scores: ScoreSnapshot | null = null;
  try { if (data.scores && ageSeconds(data.scores.fetchedAt, data.now) !== null) scores = validateScores(data.scores); } catch {}
  const scoreAge = ageSeconds(scores?.fetchedAt, data.now);
  let overrideFallback = false;
  const benchmark = !!config.benchmark && !pin;
  if (benchmark && (!scores || scores.version !== 2 || scores.indexVersion !== config.benchmark!.indexVersion))
    throw new RouteError("no_candidate", "Benchmark routing requires a version 2 snapshot with configured index " + config.benchmark!.indexVersion);
  if (!retainOverrideScores && !benchmark && scores && input.effortOverride && !pair.some(model => scoreFor(scores, model, effort))) {
    // Probe the extra driver's actual admission, not just its catalog presence.
    // If it is stopped, banned, separated or otherwise held, keep main's primary fallback.
    let additionalCandidate = false;
    const extraCatalog = catalog.filter(p => p.driverKind === "antigravity" && p.canRunChildTask);
    if (extraCatalog.length) {
      try { recommendPolicy(input, { ...data, catalog: extraCatalog }, true); additionalCandidate = true; }
      catch (error) { if (!(error instanceof RouteError) || error.code !== "no_candidate") throw error; }
    }
    if (!additionalCandidate) {
      scores = null;
      overrideFallback = true;
      reasons.push("Explicit effort override has no mapped role anchors; use fixed role pairs without an AA quality claim");
    }
  }
  reasons.push(pin ? "Fleet pin overrides bans, scores, probation and quota preference; availability, effort, active stops and review separation still apply"
    : scores ? scoreAge! * 1000 >= config.scoreMaxAgeMs ? "AA snapshot stale; use last good snapshot" : "AA role target " + input.role + " with intelligence floor " + config.floors[input.role]
    : overrideFallback ? "AA has no role anchors at requested effort; use fixed role pairs with Sonnet removed"
    : "AA unavailable; no last good snapshot; use fixed role pairs with Sonnet removed");
  if (scores?.unmapped.length) reasons.push("AA models unmapped, held: " + scores.unmapped.join(", "));
  diagnostics.quality_source = scores && !pin ? "AA" : "fixed_policy";
  if (benchmark) {
    diagnostics.benchmarkCoverage = benchmarkCoverage(catalog, scores, config.bans, input.effortOverride);
    reasons.push("Benchmark selection uses minimum measured USD per task above the role floor within each provider; quota admission and provider pacing still apply");
  }
  const policyReasons = [...reasons];
  const providerReasons = new Map<Provider, string[]>();
  const candidates: Array<Target & { driver: Provider; pace: number | null; scopeKnown: boolean }> = [];
  for (const p of [...catalog].sort((a, b) => a.providerInstanceId.localeCompare(b.providerInstanceId))) {
    const scoped = providerReasons.get(p.driverKind) ?? [];
    providerReasons.set(p.driverKind, scoped);
    const reject = (reason: string) => { scoped.push(reason); reasons.push(reason); };
    if (p.driverKind === "antigravity" && p.admissionHold) { reject(p.admissionHold); continue; }
    if (config.roleProviderExclusions?.[input.role]?.includes(p.driverKind)) {
      reject(p.providerInstanceId + ": roleProviderExclusions excludes " + p.driverKind + " for role " + input.role); continue;
    }
    if (input.authorProvider !== undefined && p.driverKind === input.authorProvider) {
      reject(p.providerInstanceId + ": review requires the other provider from " + input.authorProvider); continue;
    }
    if (pin?.providerInstanceId && pin.providerInstanceId !== p.providerInstanceId) {
      reject(p.providerInstanceId + ": fleet pin requires instance " + pin.providerInstanceId); continue;
    }
    if (benchmark && !diagnostics.benchmarkCoverage?.[p.driverKind]?.complete) {
      reject(p.providerInstanceId + ": incomplete benchmark coverage: " + (diagnostics.benchmarkCoverage?.[p.driverKind]?.missing.join(", ") || "no measured models")); continue;
    }
    const start = reasons.length;
    if (!p.models.length) reasons.push(p.providerInstanceId + ": no catalog models");

    for (const m of p.models) {
    const model = m.id;
    if (p.driverKind === "antigravity" &&
        (input.authorProvider === "claudeAgent" && model.startsWith("claude-") ||
         input.authorProvider === "codex" && model.startsWith("gpt-"))) {
      reasons.push(model + ": review excludes the author's model family"); continue;
    }
    if (pin ? model !== pin.model : banned(model, config.bans)) {
      reasons.push(model + (pin ? ": fleet pin requires " + pin.model : ": banned"));
      continue;
    }
    if (!pin && !scores && model !== (p.driverKind === "claudeAgent" ? pair[0] : p.driverKind === "codex" ? pair[1] : undefined)) {
      reasons.push(model + ": outside fixed role pair while AA unavailable"); continue;
    }
    for (const effort of benchmark ? benchmarkEfforts(model, input.effortOverride) : [input.effortOverride ?? (input.role === "builder" ? "high" : "medium")]) {
    const key = roleKey(input.role, input.authorProvider, input.effortOverride, config.benchmark?.indexVersion);
    // Preserve main's shared primary incumbent. Fallbacks have separate driver slots.
    const prior = history.picks[PRIMARY_DRIVERS.includes(p.driverKind) ? key : driverPickKey(key, p.driverKind)];
    const incumbent = prior?.model ?? config.driverModels?.[p.driverKind]?.[0] ??
      (p.driverKind === "antigravity" ? "gemini-4-neon" : pair[p.driverKind === "claudeAgent" ? 0 : 1]);
    if (!pin && scores && !targetEligible(model, effort, input.role, scores, data.analytics, config, data.now, incumbent, reasons, p.driverKind)) continue;
    const option = m.options?.find(o => EFFORT_OPTION_IDS.includes(o.id) &&
      o.type === "select" && o.options?.some(v => v.id === effort))?.id;
    if (!option) { reasons.push(model + ": required effort unavailable"); continue; }
    if (!p.canRunChildTask || !p.models.find(m => m.id === model)?.options?.some(o =>
      o.id === option && o.type === "select" && o.options?.some(v => v.id === effort))) {
      reasons.push(`${p.providerInstanceId}: role model or ${option}=${effort} unavailable in T3 catalog`);
      continue;
    }
    const q = data.quota[p.providerInstanceId];
    const age = ageSeconds(q?.observedAt, data.now);
    ages[p.providerInstanceId] = age;
    const capacity = capacityFor(data, p.providerInstanceId, model);
    if (capacity) reasons.push(`${p.providerInstanceId} capacity ${capacity.class}: ${capacity.reasons.join("; ")}`);
    if (capacity && ["tight", "stopped"].includes(capacity.class)) { reasons.push(`${p.providerInstanceId}: avoid ${capacity.class}`); continue; }
    if (q?.activeStop) { reasons.push(`${p.providerInstanceId}: active usage stop, avoid`); continue; }
    const exhausted = p.driverKind === "antigravity" && antigravityExhaustion([...(q?.knownWindows ?? []), ...(q?.windows ?? [])], model, data.now, config.minimumRemaining);
    if (exhausted) { reasons.push(p.providerInstanceId + ": known " + (exhausted.id ?? exhausted.kind) + " exhausted until " + exhausted.resetsAt); continue; }
    const fresh = age !== null && age * 1000 < (q?.operatorEstimate ? 7 * 86_400_000 : config.quotaMaxAgeMs);
    const windows = fresh ? (q?.windows ?? []).filter(w => Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 &&
      w.remainingPercent <= 100 && (w.resetsAt === null || Date.parse(w.resetsAt) > data.now)) : [];
    const advice = modelWindowPolicy(windows, ["claudeAgent", "antigravity"].includes(p.driverKind) ? model : "", data.now, config.minimumRemaining, config.paceMargin, p.driverKind);
    diagnostics.quota[p.providerInstanceId + ":" + model] = { accountKey: p.accountKey ?? null,
      bindingSource: p.accountKey ? "catalog" : "unbound", source: q?.operatorEstimate ? "operator_estimate" : "observation",
      ageSeconds: age, freshness: fresh ? "fresh" : age === null ? "unknown" : "stale",
      bindingWindow: advice.binding?.id ?? advice.binding?.kind ?? null, scopedKnown: advice.scopeKnown && !q?.incomplete,
      pace: q?.incomplete ? null : advice.pace };
    reasons.push(...advice.reasons.map(reason => p.providerInstanceId + " " + reason));
    // Short windows gate included usage only. The classifier sets creditFunded solely for fresh,
    // account-bound credits with spend control not reached; active stops were excluded above.
    if (advice.gate && capacity?.creditFunded) reasons.push(p.providerInstanceId + ": included short window " + advice.gate + " does not gate the credit-funded lane");
    else if (advice.gate) { reasons.push(p.providerInstanceId + ": short window " + advice.gate + ", avoid until reset"); continue; }
    if ((!capacity || capacity.reserveWeeks === 0 && !["unlimited", "use-it"].includes(capacity.class)) &&
        advice.limit) {
      reasons.push(`${p.providerInstanceId}: under ${config.minimumRemaining * 100}% remaining, avoid`); continue;
    }
    if (advice.scopedLimit) { reasons.push(model + ": seven_day_fable under minimum remaining, avoid"); continue; }
    const pace = q?.incomplete ? null : advice.pace;
    if (!advice.pacing) reasons.push(`${p.providerInstanceId}: quota pacing unknown${p.driverKind === "codex" ? ", not assumed unlimited" : ""}${age !== null && age * 1000 >= config.quotaMaxAgeMs ? " (stale cache)" : ""}`);
    candidates.push({ ...(p.accountKey ? { accountKey: p.accountKey } : {}), providerInstanceId: p.providerInstanceId, model, options: { [option]: effort }, driver: p.driverKind, pace, scopeKnown: advice.scopeKnown && !q?.incomplete });
    }
    }
    scoped.push(...reasons.slice(start));
  }
  const a = data.analytics;
  const analyticsAge = ageSeconds(a?.fetchedAt, data.now);
  const windowAge = ageSeconds(a?.endExclusive, data.now);
  const sourceAge = ageSeconds(a?.sourceFetchedAt, data.now);
  const usable = a !== null && analyticsAge !== null && sourceAge !== null && windowAge !== null &&
    windowAge * 1000 < config.analyticsMaxAgeMs;
  if (!usable) reasons.push("Slopalytics stale or unavailable; use quota policy and role defaults");
  let eligible = candidates;
  if (usable && !scores && !pin) {
    eligible = candidates.filter(c => {
      const s = a.models[c.model];
      const peer = a.models[pair[c.driver === "claudeAgent" ? 1 : 0]];
      const hasEligiblePeer = candidates.some(other => other.driver !== c.driver);
      const drop = hasEligiblePeer && s && peer && s.turns >= config.minimumTurns && peer.turns >= config.minimumTurns &&
        s.failedRate + s.interruptedRate - peer.failedRate - peer.interruptedRate > config.failureMargin;
      if (drop) {
        const reason = `${c.model}: Slopalytics failure+interrupt rate exceeds peer by more than ${Math.round(config.failureMargin * 100)} points, avoid`;
        reasons.push(reason); providerReasons.get(c.driver)!.push(reason);
      }
      return !drop;
    });
    reasons.push("Slopalytics compares only the role pair; minimum sample applies to both models");
  }
  const preferCodex = input.role === "executor" && !pin;
  if (preferCodex) reasons.push("Executor prefers eligible Codex among equally preferred drivers for long-running work and large contexts");
  if (config.providerPreference.length) reasons.push("Provider preference: " + config.providerPreference.join(", ") +
    "; a candidate ahead of its weekly pace ranks after candidates whose pace is unknown or not ahead");
  const position = (driver: string) => {
    const index = config.providerPreference.indexOf(driver);
    return index < 0 ? config.providerPreference.length : index;
  };
  // Pace is remaining fraction minus time-left fraction; below zero burns faster than linear.
  const aheadOfPace = (c: typeof candidates[number]) => c.pace !== null && c.pace < 0;
  const rankCandidates = (pool: typeof candidates, explain: boolean) => {
    if (explain && config.providerPreference.length) {
      for (const driver of config.providerPreference) {
        const ahead = pool.filter(c => c.driver === driver && aheadOfPace(c));
        if (!ahead.length || !pool.some(c => c.driver !== driver && !aheadOfPace(c) && position(c.driver) > position(driver))) continue;
        const worst = ahead.reduce((m, c) => c.pace! < m.pace! ? c : m);
        const reason = `${worst.providerInstanceId}: preferred provider ${driver} demoted for pace: ${worst.model} weekly pace ${worst.pace!.toFixed(2)} is ahead of linear; ranked after providers whose pace is unknown or not ahead`;
        reasons.push(reason); providerReasons.get(driver)?.push(reason);
      }
    }
    const claude = pool.filter(c => c.driver === "claudeAgent");
    const pacedClaude = claude.filter(c => c.pace !== null);
    const preferred: Provider = pacedClaude.some(c => c.pace! >= config.paceMargin) ? "claudeAgent"
      : pacedClaude.length ? "codex" : "claudeAgent";
    const hasPace = pacedClaude.length > 0;
    if (explain && !preferCodex && !config.providerPreference.length) reasons.push(hasPace ? `Quota pacing prefers ${preferred}` : "Claude pacing unknown; role default prefers Claude");
    const quotaCompare = (x: typeof candidates[number], y: typeof candidates[number]) => {
      if (config.providerPreference.length) {
        // Pace demotion applies to every candidate, including same-driver pairs, so the
        // comparator stays transitive when one driver has both paced and unknown models.
        const pace = Number(aheadOfPace(x)) - Number(aheadOfPace(y));
        if (pace) return pace;
        const order = x.driver === y.driver ? 0 : position(x.driver) - position(y.driver);
        if (order) return order;
      }
      if (preferCodex && (x.driver === "codex") !== (y.driver === "codex"))
        return Number(y.driver === "codex") - Number(x.driver === "codex");
      // Fallback drivers such as Antigravity rank after every eligible primary driver.
      const fallback = (c: typeof x) => !PRIMARY_DRIVERS.includes(c.driver);
      if (fallback(x) !== fallback(y)) return Number(fallback(x)) - Number(fallback(y));
      const rank = (c: typeof x) => {
        if (!c.scopeKnown && !capacityFor(data, c.providerInstanceId, c.model)?.creditFunded) return data.capacity ? 2 : null;
        const kind = capacityFor(data, c.providerInstanceId, c.model)?.class;
        return kind === "use-it" ? 0 : kind === "unlimited" ? 1 : data.capacity ? 2 : null;
      };
      const xr = rank(x), yr = rank(y);
      if (xr !== null && yr !== null && xr !== yr && (xr === 0 || yr === 0)) return xr - yr;
      const underPaced = (c: typeof x) => c.driver === "claudeAgent" && c.pace !== null && c.pace >= config.paceMargin;
      if (underPaced(x) !== underPaced(y)) return Number(underPaced(y)) - Number(underPaced(x));
      if (xr !== null && yr !== null && xr !== yr) return xr - yr;
      // Unknown and paced tie, preserving the role default when Claude pacing is unknown.
      // Known quota preference takes precedence over a statistical tie-break.
      if (hasPace && x.driver !== y.driver && (x.driver === preferred || y.driver === preferred)) return Number(y.driver === preferred) - Number(x.driver === preferred);
      if (x.driver === y.driver && x.pace !== y.pace) return (y.pace ?? -Infinity) - (x.pace ?? -Infinity);
      if (scores && !pin && !benchmark) {
        const xs = scoreFor(scores, x.model, effort)!, ys = scoreFor(scores, y.model, effort)!;
        const objective = compareScores(input.role, xs, ys);
        if (objective) return objective;
      }
      if (usable) {
        const s = a.models[x.model], t = a.models[y.model];
        if (s && t && s.turns >= config.minimumTurns && t.turns >= config.minimumTurns) {
          const reliability = t.completionRate - s.completionRate;
          if (reliability) return reliability;
          if (s.minutesPerTurn !== null && t.minutesPerTurn !== null && s.minutesPerTurn !== t.minutesPerTurn)
            return s.minutesPerTurn - t.minutesPerTurn;
        }
      }
      if (x.driver !== y.driver && (x.driver === preferred || y.driver === preferred)) return Number(y.driver === preferred) - Number(x.driver === preferred);
      return x.providerInstanceId.localeCompare(y.providerInstanceId);
    };
    if (benchmark) {
      // Choose the cheapest pool model/effort per driver before comparing providers.
      // Representatives keep cross-provider quota ordering independent of model price.
      const localCompare = (x: typeof candidates[number], y: typeof candidates[number]) =>
        compareBenchmark(x, y, scores!) || quotaCompare(x, y) || x.model.localeCompare(y.model) ||
        targetEffort(x).localeCompare(targetEffort(y));
      // With a provider preference, a driver's ahead-of-pace and not-ahead candidates form
      // separate groups, so price never lifts an ahead-of-pace model over a not-ahead one
      // and a not-ahead model is never dragged down by its driver's ahead-of-pace model.
      // Without a preference the group is the driver, exactly as before.
      const group = (c: typeof candidates[number]) =>
        config.providerPreference.length && aheadOfPace(c) ? c.driver + "\u0000ahead" : c.driver;
      const representatives = new Map<string, typeof candidates[number]>();
      for (const c of pool) {
        const prior = representatives.get(group(c));
        if (!prior || localCompare(c, prior) < 0) representatives.set(group(c), c);
      }
      const groups = [...representatives.values()].sort(quotaCompare).map(group);
      pool.sort((x, y) => groups.indexOf(group(x)) - groups.indexOf(group(y)) || localCompare(x, y));
    } else pool.sort(quotaCompare);
  };
  rankCandidates(eligible, !benchmark);
  const target = (c: Target): Target => ({ ...(c.accountKey ? { accountKey: c.accountKey } : {}), providerInstanceId: c.providerInstanceId, model: c.model, options: c.options });
  if (!eligible[0]) throw new RouteError("no_candidate", "No eligible routing candidate; " + (input.authorProvider ? "review requires the other provider from " + input.authorProvider + "; " : "") + "availability, quota, pins or effort exclude the requested target" + (() => {
    const excluded = [...new Set(catalog.filter(p => config.roleProviderExclusions?.[input.role]?.includes(p.driverKind)).map(p => p.driverKind))].sort();
    return excluded.length ? "; roleProviderExclusions excludes " + excluded.join(", ") + " for role " + input.role : "";
  })() + catalog.filter(p => p.driverKind === "antigravity" && p.admissionHold).map(p => "; " + p.admissionHold).join("") + (benchmark ? "; " + Object.entries(diagnostics.benchmarkCoverage ?? {}).filter(([, c]) => !c.complete).map(([p, c]) => p + " missing benchmark coverage: " + c.missing.join(", ")).join("; ") : ""));
  if (input.authorProvider) reasons.push(`Review must use the other provider from ${input.authorProvider}`);
  const topPick = target(eligible[0]);
  // Every exposed provider pick is a recommendation and obeys its trial share.
  eligible = eligible.filter(c => {
    const held = scores && !pin && inProbation(c.model, input.role, history, config, data.now, c.driver) && !trialAvailable(history, config, c.model, c.driver);
    if (held) {
      const reason = c.model + ": probation recommendation share limited to " + config.probationShare;
      reasons.push(reason); providerReasons.get(c.driver)!.push(reason);
    }
    return !held;
  });
  if (!eligible[0]) throw new RouteError("no_candidate", "No settled candidate while probation share is exhausted");
  // Trial admission can replace a provider representative and its scoped quota.
  if (benchmark) rankCandidates(eligible, true);
  const byProvider: RouteResult["byProvider"] = Object.fromEntries([...providerReasons].map(([driver, details]) => {
    const best = eligible.find(c => c.driver === driver);
    return [driver, best ? { ...target(best), eligible: true, reasons: [...new Set([...policyReasons, ...details]),
      "Best eligible " + input.role + " pick for " + driver + ": " + best.model + " after quota and role objective"] }
      : { eligible: false, model: null, options: null, reasons: [...new Set([...policyReasons, ...details]), "No eligible " + input.role + " model for " + driver] }];
  }));
  if (scores && !pin) {
    const s = scoreFor(scores, topPick.model, benchmark ? targetEffort(topPick) : effort)!;
    if (benchmark) reasons.push("Role top pick " + topPick.model + " at " + targetEffort(topPick) + ": AA intelligence " + s.intelligence + ", benchmark cost $" + s.benchmarkCostUSDPerTask + "/task; index " + scores.indexVersion);
    else reasons.push("Role top pick " + topPick.model + ": AA intelligence " + s.intelligence + ", coding " + s.coding +
      ", 3:1 input/output price $" + (s.inputPrice === null || s.outputPrice === null ? "unknown" : (3 * s.inputPrice + s.outputPrice) / 4) + "/M; " + input.role + " objective after quota policy");
  }
  return { ...target(eligible[0]!), diagnostics, topPick, byProvider, alternatives: eligible.slice(1).filter(c =>
      c.driver !== "antigravity" || !scores || pin || !inProbation(c.model, input.role, history, config, data.now, c.driver) ||
      byProvider[c.driver]?.eligible && byProvider[c.driver]?.model === c.model).map(target), reasons,
    dataAges: { quota: ages, slopalytics: analyticsAge, slopalyticsWindow: windowAge, artificialAnalysis: scoreAge } };
}
