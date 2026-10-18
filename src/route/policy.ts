import type { Capacity } from "../quota/capacity.ts";
import { ageSeconds, DEFAULT_POLICY, PAIRS, routeInput } from "./types.ts";
import type { Analytics, CatalogProvider, PolicyConfig, Provider, Quota, RouteInput, RouteResult, Target } from "./types.ts";

export interface PolicyData {
  catalog: ReadonlyArray<CatalogProvider>;
  quota: Readonly<Record<string, Quota>>;
  analytics: Analytics | null;
  capacity?: Readonly<Record<string, Capacity>>;
  now: number;
  config?: Partial<PolicyConfig>;
}
/** Pure policy. No IO, provider launch, feed posting or quota redemption. */
export function recommend(input: RouteInput, data: PolicyData): RouteResult {
  routeInput(input);
  const config = { ...DEFAULT_POLICY, ...data.config };
  const reasons: string[] = [];
  const ages: Record<string, number | null> = {};
  const effort = input.effortOverride ?? (input.role === "builder" ? "high" : "medium");
  const pair = PAIRS[input.role];
  const candidates: Array<Target & { driver: Provider; pace: number | null }> = [];
  for (const p of [...data.catalog].sort((a, b) => a.providerInstanceId.localeCompare(b.providerInstanceId))) {
    if (p.driverKind !== "codex" && p.driverKind !== "claudeAgent") continue;
    if (input.role === "critical-review" && p.driverKind === input.authorProvider) continue;
    const model = pair[p.driverKind === "claudeAgent" ? 0 : 1];
    const option = p.driverKind === "codex" ? "reasoningEffort" : "effort";
    if (!p.canRunChildTask || !p.models.find(m => m.id === model)?.options?.some(o =>
      o.id === option && o.type === "select" && o.options?.some(v => v.id === effort))) {
      reasons.push(`${p.providerInstanceId}: role model or ${option}=${effort} unavailable in T3 catalog`);
      continue;
    }
    const q = data.quota[p.providerInstanceId];
    const age = ageSeconds(q?.observedAt, data.now);
    ages[p.providerInstanceId] = age;
    const capacity = data.capacity?.[p.providerInstanceId];
    if (capacity) reasons.push(`${p.providerInstanceId} capacity ${capacity.class}: ${capacity.reasons.join("; ")}`);
    if (capacity && ["tight", "stopped"].includes(capacity.class)) { reasons.push(`${p.providerInstanceId}: avoid ${capacity.class}`); continue; }
    if (q?.activeStop) { reasons.push(`${p.providerInstanceId}: active usage stop, avoid`); continue; }
    const fresh = age !== null && age * 1000 < (q?.operatorEstimate ? 7 * 86_400_000 : config.quotaMaxAgeMs);
    const windows = fresh ? (q?.windows ?? []).filter(w => Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 &&
      w.remainingPercent <= 100 && (w.resetsAt === null || Date.parse(w.resetsAt) > data.now)) : [];
    if ((!capacity || capacity.reserveWeeks === 0 && !["unlimited", "use-it"].includes(capacity.class)) && windows.some(w => w.remainingPercent / 100 < config.minimumRemaining)) {
      reasons.push(`${p.providerInstanceId}: under ${config.minimumRemaining * 100}% remaining, avoid`); continue;
    }
    // Pace the longest known window, normally weekly, while every window gates admission.
    const weekly = [...windows].filter(w => w.resetsAt !== null && w.windowDurationMins !== null && w.windowDurationMins > 0 &&
      Date.parse(w.resetsAt!) - data.now <= w.windowDurationMins * 60_000)
      .sort((a, b) => b.windowDurationMins! - a.windowDurationMins!)[0];
    const timeLeft = weekly ? (Date.parse(weekly.resetsAt!) - data.now) / (weekly.windowDurationMins! * 60_000) : null;
    const pace = weekly && timeLeft !== null ? weekly.remainingPercent / 100 - timeLeft : null;
    if (weekly && timeLeft !== null) reasons.push(`${p.providerInstanceId} ${Math.round(weekly.remainingPercent)}% left with ${Math.round(timeLeft * 100)}% of ${weekly.kind} window left: ${pace! >= config.paceMargin ? "under-paced" : "on/ahead of pace"}`);
    else reasons.push(`${p.providerInstanceId}: quota pacing unknown${p.driverKind === "codex" ? ", not assumed unlimited" : ""}${age !== null && age * 1000 >= config.quotaMaxAgeMs ? " (stale cache)" : ""}`);
    candidates.push({ ...(p.accountKey ? { accountKey: p.accountKey } : {}), providerInstanceId: p.providerInstanceId, model, options: { [option]: effort }, driver: p.driverKind, pace });
  }
  const a = data.analytics;
  const analyticsAge = ageSeconds(a?.fetchedAt, data.now);
  const windowAge = ageSeconds(a?.endExclusive, data.now);
  const sourceAge = ageSeconds(a?.sourceFetchedAt, data.now);
  const usable = a !== null && analyticsAge !== null && sourceAge !== null && windowAge !== null &&
    windowAge * 1000 < config.analyticsMaxAgeMs;
  if (!usable) reasons.push("Slopalytics stale or unavailable; use quota policy and role defaults");
  let eligible = candidates;
  if (usable) {
    eligible = candidates.filter(c => {
      const s = a.models[c.model];
      const peer = a.models[pair[c.driver === "claudeAgent" ? 1 : 0]];
      const hasEligiblePeer = candidates.some(other => other.driver !== c.driver);
      const drop = hasEligiblePeer && s && peer && s.turns >= config.minimumTurns && peer.turns >= config.minimumTurns &&
        s.failedRate + s.interruptedRate - peer.failedRate - peer.interruptedRate > config.failureMargin;
      if (drop) reasons.push(`${c.model}: Slopalytics failure+interrupt rate exceeds peer by more than ${Math.round(config.failureMargin * 100)} points, avoid`);
      return !drop;
    });
    reasons.push("Slopalytics compares only the role pair; minimum sample applies to both models");
  }
  const claude = eligible.filter(c => c.driver === "claudeAgent");
  const pacedClaude = claude.filter(c => c.pace !== null);
  const preferred: Provider = pacedClaude.some(c => c.pace! >= config.paceMargin) ? "claudeAgent"
    : pacedClaude.length ? "codex" : "claudeAgent";
  const hasPace = pacedClaude.length > 0;
  reasons.push(hasPace ? `Quota pacing prefers ${preferred}` : "Claude pacing unknown; role default prefers Claude");
  eligible.sort((x, y) => {
    const rank = (id: string) => {
      const kind = data.capacity?.[id]?.class;
      return kind === "use-it" ? 0 : kind === "unlimited" ? 1 : data.capacity ? 2 : null;
    };
    const xr = rank(x.providerInstanceId), yr = rank(y.providerInstanceId);
    if (xr !== null && yr !== null && xr !== yr) return xr - yr;
    // Unknown and paced tie, preserving the role default when Claude pacing is unknown.
    // Known quota preference takes precedence over a statistical tie-break.
    if (hasPace && x.driver !== y.driver) return x.driver === preferred ? -1 : 1;
    if (x.driver === y.driver && x.pace !== y.pace) return (y.pace ?? -Infinity) - (x.pace ?? -Infinity);
    if (usable) {
      const s = a.models[x.model], t = a.models[y.model];
      if (s && t && s.turns >= config.minimumTurns && t.turns >= config.minimumTurns) {
        const reliability = t.completionRate - s.completionRate;
        if (reliability) return reliability;
        if (s.minutesPerTurn !== null && t.minutesPerTurn !== null && s.minutesPerTurn !== t.minutesPerTurn)
          return s.minutesPerTurn - t.minutesPerTurn;
      }
    }
    if (x.driver !== y.driver) return x.driver === preferred ? -1 : 1;
    return x.providerInstanceId.localeCompare(y.providerInstanceId);
  });
  const target = (c: Target): Target => ({ ...(c.accountKey ? { accountKey: c.accountKey } : {}), providerInstanceId: c.providerInstanceId, model: c.model, options: c.options });
  if (!eligible[0]) throw new Error("No eligible routing candidate: " + reasons.join("; "));
  if (input.role === "critical-review" && input.authorProvider) reasons.push(`Review must use the other provider from ${input.authorProvider}`);
  return { ...target(eligible[0]), alternatives: eligible.slice(1).map(target), reasons,
    dataAges: { quota: ages, slopalytics: analyticsAge, slopalyticsWindow: windowAge } };
}
