import { PAIRS, ageSeconds } from "./types.ts";
import type { Analytics, Effort, PolicyConfig, Role, Target } from "./types.ts";
import type { Score, ScoreSnapshot } from "./scores.ts";

export interface RoutingHistory {
  seen: Record<string, number>;
  picks: Record<string, Target>;
  allocations: Record<string, { calls: number; trials: number }>;
}
export const emptyHistory = (): RoutingHistory => ({ seen: {}, picks: {}, allocations: {} });
export const roleKey = (role: Role, author?: string, effort?: Effort, benchmarkIndex?: string) => role +
  (author ? ":" + author : "") + (effort ? ":" + effort : "") + (benchmarkIndex ? ":benchmark:" + benchmarkIndex : "");
export const banned = (id: string, bans: readonly string[]) => bans.some(pattern =>
  new RegExp("^" + pattern.split("*").map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i").test(id));
export function usableAnalytics(a: Analytics | null, now: number, config: PolicyConfig): a is Analytics {
  return a !== null && [a.fetchedAt, a.sourceFetchedAt, a.endExclusive].every(t => ageSeconds(t, now) !== null) &&
    now - Date.parse(a.endExclusive) < config.analyticsMaxAgeMs;
}
export function scoreFor(snapshot: ScoreSnapshot | null | undefined, model: string, effort: Effort): Score | undefined {
  return snapshot?.models.find(m => m.model === model && m.effort === effort);
}
const price = (s: Score) => s.inputPrice === null || s.outputPrice === null ? Infinity : (3 * s.inputPrice + s.outputPrice) / 4;
const coding = (s: Score) => s.coding ?? -Infinity;
export function compareScores(role: Role, x: Score, y: Score): number {
  if (role === "builder") return coding(y) - coding(x) || y.intelligence - x.intelligence || price(x) - price(y);
  if (role === "bulk-read") return price(x) - price(y) || y.intelligence - x.intelligence;
  if (role === "critical-review") return y.intelligence - x.intelligence || coding(y) - coding(x) || price(x) - price(y);
  // An extra dollar per million tokens must buy two points of average quality.
  return ((y.intelligence + coding(y)) / 2 - 2 * price(y)) - ((x.intelligence + coding(x)) / 2 - 2 * price(x));
}
export function targetEligible(model: string, effort: Effort, role: Role, scores: ScoreSnapshot,
  analytics: Analytics | null, config: PolicyConfig, now: number,
  incumbent: string, reasons: string[]): boolean {
  const score = scoreFor(scores, model, effort);
  if (!score) { reasons.push(model + ": unmapped or missing AA data for " + effort + "; held"); return false; }
  if (config.benchmark ? score.benchmarkCostUSDPerTask === undefined || score.benchmarkCostUSDPerTask === null
      : score.coding === null || score.inputPrice === null || score.outputPrice === null) {
    reasons.push(model + ": missing " + (config.benchmark ? "benchmark cost per task" : "legacy coding or token prices")); return false;
  }
  if (score.intelligence < config.floors[role]) { reasons.push(model + ": below AA intelligence floor " + config.floors[role]); return false; }
  // The fixed defaults are the bootstrapping incumbents, not new launches.
  if (model === incumbent || (PAIRS[role] as readonly string[]).includes(model)) return true;
  const s = analytics?.models[model], peer = analytics?.models[incumbent];
  if (!usableAnalytics(analytics, now, config) || !s || !peer || s.turns < config.minimumTurns || peer.turns < config.minimumTurns) {
    reasons.push(model + ": probation held; needs fresh Slopalytics and at least " + config.minimumTurns + " turns for candidate and current pick"); return false;
  }
  if (s.failedRate + s.interruptedRate > peer.failedRate + peer.interruptedRate + config.failureMargin) {
    reasons.push(model + ": probation held; failure+interrupt rate exceeds current pick margin"); return false;
  }
  reasons.push(model + ": probation evidence passed");
  return true;
}
export function inProbation(model: string, role: Role, history: RoutingHistory, config: PolicyConfig, now: number): boolean {
  return !(PAIRS[role] as readonly string[]).includes(model) && now - (history.seen[model] ?? now) < config.probationMs;
}
export function trialAvailable(history: RoutingHistory, config: PolicyConfig, model: string): boolean {
  const a = history.allocations[model] ?? { calls: 0, trials: 0 };
  return a.trials + 1 <= Math.floor((a.calls + 1) * config.probationShare + 1e-9);
}
