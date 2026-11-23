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
test("a review route names only the provider it may use", () => {
  const r = recommend({ role: "builder", authorProvider: "claudeAgent" }, { ...fixture(), quota: {} });
  assert.equal(r.providerInstanceId, "codex");
  assert.deepEqual(pacingLines(r.reasons), ["Only codex has an eligible primary candidate; quota pacing comparison does not apply"]);
});
