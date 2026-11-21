import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODEL_MAP, scoreSnapshot, validateScores } from "../../src/route/scores.ts";
import { recommend } from "../../src/route/policy.ts";
import type { PolicyData } from "../../src/route/policy.ts";
import { benchmarkCoverage } from "../../src/route/benchmark.ts";
import { recommendReviewPair, reviewPairInput } from "../../src/route/pair.ts";
import { banned } from "../../src/route/targets.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { fixture, now, iso } from "../fixtures/route/targets.ts";

const expected = [
  ["gemini-4-neon", "low", "gemini-4-neon-low", 44.1],
  ["gemini-4-neon", "medium", "gemini-4-neon-medium", 54.9],
  ["gemini-4-neon", "high", "gemini-4-neon-high", 59.6],
  ["gemini-4-neon", "xhigh", "gemini-4-neon", 61.4],
  ["gemini-4-hydrogen", "low", "gemini-4-hydrogen-low", 26.9],
  ["gemini-4-hydrogen", "medium", "gemini-4-hydrogen-medium", 41.2],
  ["gemini-4-hydrogen", "high", "gemini-4-hydrogen-high", 50.8],
  ["gemini-4-argon", "medium", "gemini-4-argon-medium", 47.6],
  ["gemini-4-argon", "high", "gemini-4-argon", 50.4],
  ["gemini-3.8-flash", "low", "gemini-3-8-flash-low", 22.5],
  ["gemini-3.8-flash", "medium", "gemini-3-8-flash-medium", 30.1],
  ["gemini-3.8-flash", "high", "gemini-3-8-flash", 30.8],
] as const;
const bans = ["*sonnet*", "gemini-pro-orchestrator-*", "gpt-oss-*",
  "gemini-4-hydrogen*", "gemini-4-argon*", "gemini-3.8-flash*"];
function data(): PolicyData {
  const f = fixture();
  const scores = scoreSnapshot({ intelligence_index_version: 5, data: expected.map(([, effort, slug, intelligence]) => ({
    slug, evaluations: { artificial_analysis_intelligence_index: intelligence, artificial_analysis_coding_index: 60 },
    pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
    artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: { low: .5, medium: 1, high: 2, xhigh: 3 }[effort] } },
  })) }, now, 2);
  const models = [...new Set(expected.map(e => e[0])), "gemini-pro-orchestrator-neon",
    "gemini-pro-orchestrator-g1-pro", "gpt-oss-120b-medium", "claude-sonnet-5-5", "claude-opus-5-5"];
  return { ...f, scores: { ...scores, models: [...scores.models, ...f.scores.models.map(s => ({ ...s, benchmarkCostUSDPerTask: 5 }))] },
    catalog: [...f.catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)).map(p => ({
      ...p, models: p.models.filter(m => ["claude-opus-5-5", "gpt-6.1-sol"].includes(m.id)),
    })), { providerInstanceId: "aaa-google", driverKind: "antigravity", canRunChildTask: true,
      models: models.map(id => ({ id, options: [{ id: "thought_level", type: "select",
        options: (id === "gemini-4-neon" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"]).map(id => ({ id })) }] })) }],
    config: { benchmark: { indexVersion: "5" }, bans } };
}
test("reviewed Gemini map preserves exact AA names and efforts through snapshot validation", () => {
  for (const [model, effort, aaSlug, intelligence] of expected) {
    const rows = MODEL_MAP.filter(m => m.model === model && m.effort === effort);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.aaSlug, aaSlug); assert.equal(rows[0]!.harness, "antigravity");
    assert.ok(rows[0]!.analytics.startsWith("Gemini "));
    assert.equal(validateScores(data().scores).models.find(m => m.model === model && m.effort === effort)?.intelligence, intelligence);
  }
  assert.ok(!MODEL_MAP.some(m => m.model === "gemini-4-argon" && m.effort === "low"));
  assert.ok(!MODEL_MAP.some(m => m.aaSlug === "gemini-4-hydrogen"));
});
test("default provider ordering is independent of instance names and keeps Antigravity last", () => {
  const f = data(), result = recommend({ role: "general" }, f);
  assert.equal(result.providerInstanceId, "claudeAgent");
  const without = recommend({ role: "general" }, { ...f, catalog: f.catalog.filter(p => p.driverKind !== "antigravity") });
  assert.equal(result.model, without.model);
  assert.equal(recommend({ role: "executor" }, f).providerInstanceId, "codex");
  assert.equal(result.alternatives.at(-1)?.providerInstanceId, "aaa-google");
  assert.deepEqual(result.byProvider.antigravity?.options, { thought_level: "medium" });
});
test("provider preference overrides provider pacing and executor preference after admission", () => {
  const f = data();
  f.config = { ...f.config, providerPreference: ["antigravity", "codex", "claudeAgent"] };
  for (const role of ["general", "executor"] as const)
    assert.equal(recommend({ role }, f).providerInstanceId, "aaa-google");
  const stop = { observedAt: iso(now), windows: [], activeStop: true };
  assert.equal(recommend({ role: "general" }, { ...f, quota: { "aaa-google": stop } }).providerInstanceId, "codex");
  assert.notEqual(recommend({ role: "general", authorProvider: "antigravity" }, f).providerInstanceId, "aaa-google");
  assert.equal(recommend({ role: "general", effortOverride: "xhigh" }, f).model, "gemini-4-neon");
  assert.throws(() => recommend({ role: "general" }, { ...f,
    catalog: f.catalog.filter(p => p.driverKind === "antigravity"),
    config: { ...f.config, floors: { builder: 100, general: 100, executor: 100, "bulk-read": 100, "critical-review": 100 } } }), /No eligible/);
  assert.notEqual(recommend({ role: "general" }, { ...f, scores: null, config: { providerPreference: ["antigravity"] } }).providerInstanceId, "aaa-google");
});
test("recommended whole-ID bans complete coverage without hiding catalog models implicitly", () => {
  const f = data();
  const incomplete = benchmarkCoverage(f.catalog, f.scores!, ["*sonnet*"]);
  assert.deepEqual(incomplete.antigravity?.missing, ["gemini-pro-orchestrator-g1-pro", "gemini-pro-orchestrator-neon", "gpt-oss-120b-medium"]);
  const complete = benchmarkCoverage(f.catalog, f.scores!, bans);
  assert.deepEqual(complete.antigravity, { complete: true, models: 2, covered: 2, missing: [] });
  assert.equal(recommend({ role: "general" }, f).byProvider.antigravity?.model, "gemini-4-neon");
  for (const id of ["GEMINI-PRO-ORCHESTRATOR-neon", "gpt-oss-120b-medium", "gemini-3.8-flash", "gemini-4-hydrogen", "gemini-4-argon"]) assert.ok(banned(id, bans));
  assert.ok(!banned("gemini-3x8-flash", bans));
});
test("Antigravity authors and reviewers preserve pair separation and unknown quota grants no waiver", () => {
  const f = data();
  assert.equal(reviewPairInput({ authorProvider: "antigravity" }).authorProvider, "antigravity");
  const authored = recommendReviewPair({ authorProvider: "antigravity" }, f);
  assert.equal(authored.status, "complete");
  assert.notEqual(authored.main?.providerInstanceId, "aaa-google");
  assert.notEqual(authored.main?.model, authored.peer?.model);
  f.config = { ...f.config, providerPreference: ["antigravity", "claudeAgent", "codex"] };
  const reviewed = recommendReviewPair({ authorProvider: "codex" }, f);
  assert.equal(reviewed.status, "complete");
  assert.equal(reviewed.main?.providerInstanceId, "aaa-google");
  assert.notEqual(reviewed.peer?.providerInstanceId, "aaa-google");
  const only = { ...f, catalog: f.catalog.filter(p => p.driverKind === "antigravity") };
  assert.equal(recommendReviewPair({ authorProvider: "antigravity", allowQuotaException: true }, only).quotaException, false);
});
test("explicit preference retains bans, catalog effort checks, capacity and pins", () => {
  const f = data();
  f.config = { ...f.config, providerPreference: ["antigravity"] };
  const fallback = (d: PolicyData) => assert.notEqual(recommend({ role: "general" }, d).providerInstanceId, "aaa-google");
  fallback({ ...f, config: { ...f.config, bans: [...bans, "gemini-4-neon", "claude-opus-5-5"] } });
  fallback({ ...f, catalog: f.catalog.map(p => p.driverKind === "antigravity" ? { ...p, canRunChildTask: false } : p) });
  fallback({ ...f, catalog: f.catalog.map(p => p.driverKind === "antigravity" ? {
    ...p, models: p.models.map(m => ({ ...m, options: [] })),
  } : p) });
  for (const kind of ["tight", "stopped"] as const) {
    fallback({ ...f, capacity: { "aaa-google": { class: kind, reasons: ["fixture"], remainingFraction: 0,
      reserveWeeks: 0, observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: iso(now) } } });
  }
  const pinned = recommend({ role: "general" }, { ...f, config: { ...f.config,
    pins: { general: { providerInstanceId: "codex", model: "gpt-6.1-sol" } } } });
  assert.equal(pinned.providerInstanceId, "codex");
});

test("provider preference config validates ordered unique driver kinds", () => {
  const d = routeScratch();
  try {
    const path = join(d.path, "route.json");
    for (const value of [[], ["antigravity"], ["antigravity", "claudeAgent", "codex"]]) {
      writeFileSync(path, JSON.stringify({ providerPreference: value }));
      assert.deepEqual(loadRouteConfig(d.path, path).providerPreference, value);
    }
    for (const value of [null, "antigravity", ["codex", "codex"], [1], [""]]) {
      writeFileSync(path, JSON.stringify({ providerPreference: value }));
      assert.throws(() => loadRouteConfig(d.path, path), /Invalid provider preference/);
    }
  } finally { d.remove(); }
});
