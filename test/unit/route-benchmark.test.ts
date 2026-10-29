import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadRouteConfig } from "../../src/route/config.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { recommend } from "../../src/route/policy.ts";
import { roleKey } from "../../src/route/targets.ts";
import { benchmarkCoverage } from "../../src/route/benchmark.ts";
import { scoreSnapshot, validateScores, type ScoreSnapshot } from "../../src/route/scores.ts";
import { compactRoute } from "../../src/route/output.ts";
import { fixture, now, iso, stats } from "../fixtures/route/targets.ts";

const score = (model: string, effort: "low" | "medium" | "high", intelligence: number, cost: number | null) => ({
  model, effort, aaSlug: model + "-" + effort, intelligence, coding: null, inputPrice: null, outputPrice: null,
  benchmarkCostUSDPerTask: cost,
});
function data() {
  const f = fixture();
  const native = f.catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)).map(p => ({
    ...p, models: p.models.filter(m => !m.id.includes("haiku") && !m.id.includes("sonnet")),
  }));
  native[0]!.models.push({ ...native[0]!.models[0]!, id: "gpt-6.1-terra" });
  const scores: ScoreSnapshot = { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "4.3",
    fetchedAt: iso(now - 120 * 86400000), unmapped: [], models: [
      score("gpt-6.1-sol", "medium", 47.783, .3), score("gpt-6.1-sol", "high", 50.229, .6),
      score("gpt-6.1-terra", "low", 35, .05), score("gpt-6.1-terra", "medium", 49, .5),
      score("gpt-6-astra", "medium", 52, 6), score("gpt-6-astra", "high", 54, 10),
      score("gpt-6-luna", "medium", 30, .1), score("gpt-6-luna", "high", 33, .2),
      score("claude-opus-5-5", "medium", 50, 5), score("claude-opus-5-5", "high", 54, 7),
      score("claude-fable-5-1", "low", 39, 2), score("claude-fable-5-1", "medium", 49, 9),
    ] };
  const history = f.history;
  history.seen["gpt-6.1-terra"] = now - 8 * 86400000;
  history.seen["gpt-6-astra"] = now - 8 * 86400000;
  return { ...f, catalog: native, scores, history,
    analytics: { ...f.analytics, models: { ...f.analytics.models, "gpt-6.1-terra": stats() } },
    config: { benchmark: { indexVersion: "4.3" } } };
}
test("benchmark picks cheapest qualifying effort within each provider while quota chooses provider", () => {
  const f = data();
  const quota = { claudeAgent: { observedAt: iso(now), activeStop: false, windows: [
    { kind: "weekly", remainingPercent: 40, windowDurationMins: 10080, resetsAt: iso(now + 3600000) },
  ] } };
  const r = recommend({ role: "general" }, { ...f, quota });
  assert.equal(r.providerInstanceId, "claudeAgent");
  assert.equal(r.byProvider.claudeAgent?.model, "claude-opus-5-5");
  assert.deepEqual(r.byProvider.claudeAgent?.options, { effort: "medium" });
  assert.equal(r.byProvider.codex?.model, "gpt-6.1-terra");
  assert.deepEqual(r.byProvider.codex?.options, { reasoningEffort: "medium" });
  assert.match(r.reasons.join(" "), /AA snapshot stale; use last good/);
  assert.equal(r.dataAges.artificialAnalysis, 120 * 86400);
  const executor = recommend({ role: "executor" }, { ...f, quota });
  assert.equal(executor.providerInstanceId, "codex");
  assert.equal(executor.model, "gpt-6.1-terra");
  assert.equal(compactRoute(executor).benchmarkCoverage?.codex?.complete, true);
  assert.match(compactRoute(executor).reasons.join(" "), /Executor prefers/);
});
test("benchmark checks real unrounded floor and retains exact effort, stops and review separation", () => {
  const f = data();
  f.scores.models = f.scores.models.map(s => s.model === "gpt-6.1-terra" ? { ...s, intelligence: 40 } : s);
  const r = recommend({ role: "executor" }, f);
  assert.equal(r.model, "gpt-6.1-sol"); assert.deepEqual(r.options, { reasoningEffort: "high" });
  assert.equal(recommend({ role: "general", authorProvider: "codex" }, f).providerInstanceId, "claudeAgent");
  const stopped = { observedAt: iso(now), activeStop: true, windows: [] };
  assert.equal(recommend({ role: "executor" }, { ...f, quota: { codex: stopped } }).providerInstanceId, "claudeAgent");
  const exact = recommend({ role: "executor", effortOverride: "medium" }, f);
  assert.equal(exact.model, "gpt-6-astra"); assert.deepEqual(exact.options, { reasoningEffort: "medium" });
});
test("incomplete provider coverage is explicit; index mismatch and absent v2 do not fall back", () => {
  const f = data();
  f.scores.models = f.scores.models.filter(s => s.model !== "gpt-6.1-terra");
  const r = recommend({ role: "executor" }, f);
  assert.equal(r.providerInstanceId, "claudeAgent");
  assert.deepEqual(r.diagnostics?.benchmarkCoverage?.codex?.missing, ["gpt-6.1-terra"]);
  for (const scores of [null, fixture().scores, { ...data().scores, indexVersion: "5" }])
    assert.throws(() => recommend({ role: "executor" }, { ...data(), scores }), /version 2 snapshot with configured index/);
  const missing = benchmarkCoverage(data().catalog, null, ["*sonnet*"]);
  assert.equal(missing.codex?.covered, 0);
});
test("legacy history keys stay unchanged and exact xhigh skips prohibited heavy models", () => {
  assert.equal(roleKey("builder", "codex"), "builder");
  assert.equal(roleKey("critical-review", "codex"), "critical-review:codex");
  assert.equal(roleKey("builder", "codex", undefined, "4.3"), "builder:codex:benchmark:4.3");
  const f = data();
  f.scores.models.push({ ...score("gpt-6-luna", "high", 34, .15), effort: "xhigh" });
  f.history.seen["gpt-6-luna"] = now - 8 * 86400000;
  const r = recommend({ role: "bulk-read", effortOverride: "xhigh" }, f);
  assert.equal(r.model, "gpt-6-luna");
  assert.deepEqual(r.options, { reasoningEffort: "xhigh" });
  assert.equal(r.diagnostics?.benchmarkCoverage?.codex?.models, 1);
  const stopped = { observedAt: iso(now), activeStop: true, windows: [] };
  const fallback = recommend({ role: "executor" }, { ...data(), quota: { codex: stopped } });
  assert.match(compactRoute(fallback).reasons.join(" "), /available fallback/);
});
test("benchmark configuration and compact CLI preserve the selected native model and effort", () => {
  const scratch = routeScratch();
  try {
    const configPath = join(scratch.path, "route.json");
    for (const indexVersion of ["4.3", "5"]) {
      writeFileSync(configPath, JSON.stringify({ benchmark: { indexVersion }, scores: { formatVersion: 2 } }));
      const c = loadRouteConfig(scratch.path, configPath);
      assert.equal(c.benchmark?.indexVersion, indexVersion);
      assert.equal(c.scores.formatVersion, 2);
    }
    writeFileSync(configPath, JSON.stringify({ benchmark: { indexVersion: "unversioned" } }));
    assert.throws(() => loadRouteConfig(scratch.path, configPath), /Invalid benchmark/);
    const path = join(scratch.path, "fixture.json"); writeFileSync(path, JSON.stringify(data()));
    const p = spawnSync(process.execPath, ["bin/chaldea", "route", "--role", "executor", "--fixture", path],
      { encoding: "utf8", env: { ...process.env, HOME: scratch.path } });
    assert.equal(p.status, 0, p.stderr);
    const r = JSON.parse(p.stdout);
    assert.equal(r.model, "gpt-6.1-terra");
    assert.deepEqual(r.options, { reasoningEffort: "medium" });
    assert.equal(r.benchmarkCoverage.codex.complete, true);
  } finally { scratch.remove(); }
});
test("v2 cost and nullable coding round-trip without inventing cost, coding, date or a max effort", () => {
  const row = { slug: "gpt-6-1-terra-medium", evaluations: {
    artificial_analysis_intelligence_index: 38.115, artificial_analysis_coding_index: null },
    artificial_analysis_intelligence_index_cost: { total_cost: 100, cost_per_task: { total_cost: .16 } },
    pricing: {}, secret: "never publish" };
  const result = scoreSnapshot({ intelligence_index_version: 5, data: [row] }, now, 2);
  assert.equal(result.models[0]?.model, "gpt-6.1-terra");
  assert.equal(result.models[0]?.effort, "medium");
  assert.equal(result.models[0]?.benchmarkCostUSDPerTask, .16);
  assert.equal(result.models[0]?.coding, null);
  assert.deepEqual(validateScores(result), result);
  assert.doesNotMatch(JSON.stringify(result), /never publish|secret/);
  for (const cost of [null, 0]) {
    const s = structuredClone(result); s.models[0]!.benchmarkCostUSDPerTask = cost;
    assert.equal(validateScores(s).models[0]?.benchmarkCostUSDPerTask, cost);
  }
  for (const cost of [-1, NaN, Infinity, undefined]) {
    const s = structuredClone(result); if (cost === undefined) delete s.models[0]!.benchmarkCostUSDPerTask;
    else s.models[0]!.benchmarkCostUSDPerTask = cost;
    assert.throws(() => validateScores(s), /invalid_route_scores/);
  }
  assert.throws(() => validateScores({ ...result, models: [...result.models, ...result.models] }), /invalid_route_scores/);
  assert.throws(() => validateScores({ ...result, indexVersion: "unversioned" }), /invalid_route_scores/);
});
