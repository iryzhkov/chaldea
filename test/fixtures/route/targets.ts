import { catalog as original, now, iso } from "./catalog.ts";
import type { Analytics } from "../../../src/route/types.ts";
import type { ScoreSnapshot } from "../../../src/route/scores.ts";
import type { RoutingHistory } from "../../../src/route/targets.ts";
import { emptyHistory } from "../../../src/route/targets.ts";
export { now, iso };
export const newcomer = "claude-haiku-6";
export const catalog = original.map(p => p.providerInstanceId === "claudeAgent" ? { ...p,
  models: [...p.models, { ...p.models[0]!, id: newcomer }] } : p);
const s = (model: string, intelligence: number, coding: number, inputPrice: number, outputPrice: number) =>
  ({ model, effort: "medium" as const, aaSlug: model + "-medium", intelligence, coding, inputPrice, outputPrice });
export const scores: ScoreSnapshot = { version: 1, fetchedAt: iso(now), indexVersion: "4.3",
  unmapped: ["unreviewed-aa-model"], models: [
    s("claude-haiku-5-5", 34, 30, .10, .50), s("gpt-6-luna", 30, 32, .10, .50),
    s(newcomer, 36, 35, .05, .20), s("claude-sonnet-5-5", 56, 60, 0, 0),
    s("claude-fable-5-1", 49, 55, 10, 50), s("gpt-6-astra", 50, 56, 5, 20),
    s("claude-opus-5-5", 52, 58, 5, 25), s("gpt-6.1-sol", 48, 60, 5, 20),
    { ...s("claude-opus-5-5", 54, 60, 5, 25), effort: "high" },
    { ...s("gpt-6.1-sol", 50, 62, 5, 20), effort: "high" },
  ] };
export const stats = (turns = 100, failedRate = .03) => ({
  turns, completionRate: 1 - failedRate - .02, failedRate, interruptedRate: .02, minutesPerTurn: 2,
});
export const analytics: Analytics = { fetchedAt: iso(now), sourceFetchedAt: iso(now), endExclusive: iso(now - 3600000),
  models: Object.fromEntries(scores.models.map(s => [s.model, stats()])) };
export const history = (): RoutingHistory => ({ ...emptyHistory(), seen: { [newcomer]: now - 8 * 86400000 } });
export const fixture = () => ({ catalog, scores, analytics: structuredClone(analytics), now, quota: {}, history: history() });
