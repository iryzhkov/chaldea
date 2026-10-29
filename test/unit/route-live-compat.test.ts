import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadRouteConfig } from "../../src/route/config.ts";
import { DatabaseSync } from "node:sqlite";
import { routeCatalog } from "../../src/route/runtime.ts";
import { recommend } from "../../src/route/policy.ts";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { RouteState } from "../../src/route/state.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import type { PolicyData } from "../../src/route/policy.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { now, iso } from "../fixtures/route/catalog.ts";

const option = (id: string) => [{ id, type: "select", options: ["low", "medium", "high"].map(id => ({ id })) }];
const providers: SwitchProvider[] = ["codex", "claudeAgent"].map(id => ({
  instanceId: id, driver: id, enabled: true, installed: true, status: "ready", auth: { status: "authenticated" },
  models: (id === "codex" ? ["gpt-6.1-sol", "gpt-6-sol"] : ["claude-opus-5-5", "claude-opus-4-5"]).map(slug => ({
    slug, capabilities: { optionDescriptors: option(id === "codex" ? "reasoningEffort" : "effort") },
  })),
}));
const preferences = { codex: { hiddenModels: ["gpt-6-sol"] }, claudeAgent: { hiddenModels: ["claude-opus-4-5"] } };
const s = (model: string, effort: "low" | "medium" | "high", intelligence: number, cost: number) => ({
  model, effort, aaSlug: model + "-" + effort, intelligence, coding: null, inputPrice: null,
  outputPrice: null, benchmarkCostUSDPerTask: cost,
});
function data(): PolicyData {
  return { now, quota: {}, analytics: null,
    catalog: providers.map(p => ({ providerInstanceId: p.instanceId, driverKind: p.driver, canRunChildTask: true,
      models: p.models.slice(0, 1).map(m => ({ id: m.slug, options: m.capabilities!.optionDescriptors ?? [] })) })),
    // AA Free API capture, 2026-10-29, index 5. Precision is upstream's, not rounded here.
    scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(now), unmapped: [],
      models: [s("gpt-6.1-sol", "low", 34.5, .1615), s("gpt-6.1-sol", "medium", 46.1, .3594),
        s("gpt-6.1-sol", "high", 50.2, .591), s("claude-opus-5-5", "low", 34.5, .9755),
        s("claude-opus-5-5", "medium", 48.1, 2.4511), s("claude-opus-5-5", "high", 51.7, 3.4647)] },
    config: { benchmark: { indexVersion: "5", anchors: {
      "bulk-read": ["gpt-6.1-sol", "claude-opus-5-5"], "critical-review": ["gpt-6.1-sol", "claude-opus-5-5"],
    } } },
  };
}
test("FATE excludes environment-hidden models without changing the cached provider projection", () => {
  const before = JSON.stringify(providers);
  const catalog = routeCatalog(providers, preferences);
  assert.deepEqual(catalog[0]!.models.map(m => m.id), ["gpt-6.1-sol"]);
  assert.deepEqual(catalog[1]!.models.map(m => m.id), ["claude-opus-5-5"]);
  assert.equal(JSON.stringify(providers), before);
  assert.equal(routeCatalog(providers)[0]!.models.length, 2);
});
test("benchmark review pairs search qualifying efforts, and exact requested effort remains exact", () => {
  const d = data();
  for (const authorProvider of ["codex", "claudeAgent"] as const) {
    const pair = recommendReviewPair({ authorProvider }, d);
    assert.equal(pair.status, "complete");
    assert.deepEqual([pair.main!, pair.peer!].find(t => t.model === "claude-opus-5-5")!.options, { effort: "high" });
    assert.deepEqual([pair.main!, pair.peer!].find(t => t.model === "gpt-6.1-sol")!.options, { reasoningEffort: "high" });
  }
  assert.equal(recommendReviewPair({ authorProvider: "codex", mainEffort: "medium" }, d).status, "unavailable");
});
test("explicitly calibrated benchmark baselines bootstrap roles while preserving floors", () => {
  const d = data();
  const reader = recommend({ role: "bulk-read", authorProvider: "claudeAgent" }, d);
  assert.equal(reader.model, "gpt-6.1-sol"); assert.deepEqual(reader.options, { reasoningEffort: "low" });
  const critical = recommend({ role: "critical-review", authorProvider: "codex" }, d);
  assert.equal(critical.model, "claude-opus-5-5"); assert.deepEqual(critical.options, { effort: "high" });
  d.scores!.models = d.scores!.models.map(m => m.model === "gpt-6.1-sol" ? { ...m, intelligence: 1 } : m);
  assert.throws(() => recommend({ role: "bulk-read", authorProvider: "claudeAgent" }, d), /No eligible/);
});
test("baseline calibration is explicit, bounded and cannot introduce unknown policy fields", () => {
  const scratch = routeScratch(), path = join(scratch.path, "config.json");
  try {
    for (const anchors of [{ "unknown-role": ["gpt-6.1-sol"] }, { "bulk-read": ["bad*id"] },
      { "bulk-read": ["gpt-6.1-sol", "gpt-6.1-sol"] }, null, ["gpt-6.1-sol"]]) {
      writeFileSync(path, JSON.stringify({ benchmark: { indexVersion: "5", anchors } }));
      assert.throws(() => loadRouteConfig(scratch.path, path), /Invalid benchmark baseline/);
    }
    writeFileSync(path, JSON.stringify({ benchmark: data().config!.benchmark }));
    assert.deepEqual(loadRouteConfig(scratch.path, path).benchmark, data().config!.benchmark);
    const d = data(); d.config = { benchmark: { indexVersion: "5" } };
    assert.throws(() => recommend({ role: "bulk-read", authorProvider: "claudeAgent" }, d), /No eligible/);
  } finally { scratch.remove(); }
});
test("automatic pair selection reserves the same history contexts it evaluated", () => {
  const scratch = routeScratch(), path = join(scratch.path, "auto-pair.sqlite");
  const state = new RouteState(path), db = new DatabaseSync(path);
  try {
    const pair = state.reviewPair({ authorProvider: "codex" }, data());
    assert.equal(pair.status, "complete");
    assert.deepEqual(db.prepare("SELECT role FROM history ORDER BY role").all().map(r => r.role),
      ["builder:benchmark:5", "builder:codex:benchmark:5"]);
  } finally { state.close(); db.close(); scratch.remove(); }
});
