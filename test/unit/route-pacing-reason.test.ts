import assert from "node:assert/strict";
import { test } from "node:test";
import { recommend, recommendTraced } from "../../src/route/policy.ts";
import type { PolicyData } from "../../src/route/policy.ts";
import { fixture, now, iso, newcomer } from "../fixtures/route/targets.ts";

const model = (id: string, option: string) => ({ id, options: [{ id: option, type: "select", options: [{ id: "medium" }] }] });
const weekly = (id: string, left: number, timeLeft: number) => ({ id, kind: "weekly", remainingPercent: left,
  windowDurationMins: 10080, resetsAt: iso(now + timeLeft * 7 * 86400000) });
/** Legacy (AA, non-benchmark) routing where every Claude candidate is in probation with no trial share left. */
function heldClaude(claudeModels: string[]): PolicyData {
  const f = fixture();
  return { ...f, catalog: [
    { providerInstanceId: "claudeAgent", driverKind: "claudeAgent", canRunChildTask: true, models: claudeModels.map(m => model(m, "effort")) },
    { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true, models: [model("gpt-6.1-sol", "reasoningEffort")] }],
  // Claude is under-paced, so the pre-probation pool alone would "prefer" Claude.
  quota: { claudeAgent: { observedAt: iso(now), activeStop: false, windows: [weekly("weekly", 90, .3), weekly("seven_day_fable", 90, .3)] } } };
}
const pacingLines = (reasons: string[]) => reasons.filter(r => /Quota pacing|Claude pacing|primary candidate/.test(r));

test("a held Claude model cannot make the pacing reason name Claude while Codex is returned", () => {
  const r = recommend({ role: "general" }, heldClaude(["claude-fable-5-1"]));
  assert.equal(r.providerInstanceId, "codex");
  assert.ok(r.reasons.includes("claude-fable-5-1: probation recommendation share limited to 0.1"));
  assert.deepEqual(pacingLines(r.reasons), ["Only codex has an eligible primary candidate; quota pacing comparison does not apply"]);
  assert.equal(r.byProvider.claudeAgent?.eligible, false);
});
test("with every Claude candidate held, no reason names Claude as preferred", () => {
  const r = recommend({ role: "general" }, heldClaude(["claude-fable-5-1", newcomer]));
  assert.equal(r.providerInstanceId, "codex");
  assert.deepEqual(r.alternatives, []);
  assert.deepEqual(pacingLines(r.reasons), ["Only codex has an eligible primary candidate; quota pacing comparison does not apply"]);
  assert.ok(!r.reasons.some(x => /prefers claudeAgent|prefers Claude/.test(x)));
});
test("a settled Claude candidate keeps the ordinary pacing reason", () => {
  const r = recommend({ role: "general" }, heldClaude(["claude-fable-5-1", "claude-opus-5-5"]));
  assert.equal(r.providerInstanceId, "claudeAgent");
  assert.equal(r.model, "claude-opus-5-5");
  assert.deepEqual(pacingLines(r.reasons), ["Quota pacing prefers claudeAgent"]);
});
test("the pacing line cites the rule that ordered the final top pair, including held-model pacing", () => {
  // Reviewer repro: no capacity data; held Opus pace +0.60, Fable -0.60, Codex Astra +0.20.
  const f = fixture();
  f.catalog = f.catalog.filter(p => ["claudeAgent", "codex"].includes(p.providerInstanceId))
    .map(p => ({ ...p, models: p.models.filter(m => ["claude-opus-5-5", "claude-fable-5-1", "gpt-6-astra"].includes(m.id)) }));
  const d: PolicyData = { ...f, quota: {
    claudeAgent: { observedAt: iso(now), activeStop: false, windows: [weekly("weekly", 90, .3), weekly("seven_day_fable", 20, .8)] },
    codex: { observedAt: iso(now), activeStop: false, windows: [weekly("weekly", 50, .3)] } } };
  const { result: r, trace } = recommendTraced({ role: "critical-review" }, d);
  assert.equal(d.capacity, undefined);
  assert.equal(r.model, "claude-fable-5-1");
  assert.ok(r.reasons.includes("claude-opus-5-5: probation recommendation share limited to 0.1"));
  assert.deepEqual(pacingLines(r.reasons), ["Quota pacing including probation-held candidates prefers claudeAgent"]);
  assert.ok(!r.reasons.some(x => /capacity class ranks/i.test(x)));
  assert.equal(trace?.rule, "pacing");
  assert.equal(trace?.sign, -1); assert.equal(trace?.reverse, 1);
  assert.deepEqual([trace?.preferred, trace?.settledPreferred], ["claudeAgent", "codex"]);
  // The pacing line keeps its historical position, so the published headline does not change.
  assert.ok(r.reasons.indexOf(pacingLines(r.reasons)[0]!) < r.reasons.indexOf("claude-opus-5-5: probation recommendation share limited to 0.1"));
});
test("Slopalytics completion rate and speed decisions cite the metric that decided", () => {
  const stats = (completionRate: number, minutesPerTurn: number) => ({ turns: 100, completionRate, failedRate: .03, interruptedRate: .02, minutesPerTurn });
  const route = (claude: ReturnType<typeof stats>, codex: ReturnType<typeof stats>) => {
    const f = fixture();
    return recommendTraced({ role: "builder" }, { ...f, scores: null, quota: {},
      analytics: { ...f.analytics, models: { ...f.analytics.models, "claude-opus-5-5": claude, "gpt-6.1-sol": codex } } });
  };
  // Reviewer repro: equal completion rate, Claude 8 minutes per turn, Codex 1.
  const speed = route(stats(.95, 8), stats(.95, 1));
  assert.equal(speed.result.providerInstanceId, "codex");
  assert.equal(speed.trace?.rule, "speed");
  assert.deepEqual(pacingLines(speed.result.reasons), ["Quota pacing did not decide; Slopalytics speed ranks codex first (1.0 vs 8.0 minutes per turn)"]);
  const reliability = route(stats(.95, 1), stats(.97, 8));
  assert.equal(reliability.result.providerInstanceId, "codex");
  assert.equal(reliability.trace?.rule, "reliability");
  assert.deepEqual(pacingLines(reliability.result.reasons), ["Quota pacing did not decide; Slopalytics completion rate ranks codex first (0.97 vs 0.95)"]);
  // Close values that decide the order are printed with enough decimals to stay distinct.
  const closeRate = route(stats(.951, 1), stats(.954, 1));
  assert.equal(closeRate.result.providerInstanceId, "codex");
  assert.deepEqual(pacingLines(closeRate.result.reasons), ["Quota pacing did not decide; Slopalytics completion rate ranks codex first (0.954 vs 0.951)"]);
  const closeSpeed = route(stats(.95, 1.04), stats(.95, 1.01));
  assert.equal(closeSpeed.result.providerInstanceId, "codex");
  assert.deepEqual(pacingLines(closeSpeed.result.reasons), ["Quota pacing did not decide; Slopalytics speed ranks codex first (1.01 vs 1.04 minutes per turn)"]);
});
test("a review route names only the provider it may use", () => {
  const r = recommend({ role: "builder", authorProvider: "claudeAgent" }, { ...fixture(), quota: {} });
  assert.equal(r.providerInstanceId, "codex");
  assert.deepEqual(pacingLines(r.reasons), ["Only codex has an eligible primary candidate; quota pacing comparison does not apply"]);
});
