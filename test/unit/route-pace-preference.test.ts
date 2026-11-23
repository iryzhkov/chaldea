import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { scoreSnapshot } from "../../src/route/scores.ts";
import { recommend } from "../../src/route/policy.ts";
import type { PolicyData } from "../../src/route/policy.ts";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { routeCatalog, collectRouteContext } from "../../src/route/runtime.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { HeadroomMonitor } from "../../src/quota/headroom.ts";
import type { Capacity } from "../../src/quota/capacity.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { fixture, now, iso } from "../fixtures/route/targets.ts";

// Mirrors the 2026-11-22 omarchy-pc route.json and the observed quota state.
const preference = ["antigravity", "codex", "claudeAgent"];
const bans = ["*sonnet*", "gemini-pro-orchestrator-*", "gpt-oss-*", "gemini-4-hydrogen*", "gemini-4-argon*", "gemini-3.8-flash*"];
const WEEK = 10080 * 60_000;
const weekly = (id: string, left: number, timeLeft: number) => ({ id, kind: "weekly", remainingPercent: left,
  windowDurationMins: 10080, resetsAt: iso(now + timeLeft * WEEK) });
const observed = (windows: ReturnType<typeof weekly>[]) => ({ observedAt: iso(now), windows, activeStop: false });
const unlimited: Capacity = { class: "unlimited", reasons: ["credit-funded lane"], remainingFraction: null, reserveWeeks: 0,
  observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: iso(now), creditFunded: true };
const { creditFunded: _, ...uncredited } = unlimited;
const unknown: Capacity = { ...uncredited, class: "unknown",
  reasons: ["missing, stale or expired weekly/longest included window; short windows never establish pacing"] };

function data(agLeft: number | null): PolicyData {
  const f = fixture();
  const scores = scoreSnapshot({ intelligence_index_version: 5, data: ([["low", 44.1], ["medium", 54.9], ["high", 59.6]] as const)
    .map(([effort, intelligence]) => ({ slug: "gemini-4-neon-" + effort,
      evaluations: { artificial_analysis_intelligence_index: intelligence, artificial_analysis_coding_index: 60 },
      pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
      artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: { low: .5, medium: 1, high: 2 }[effort] } } })) }, now, 2);
  return { ...f,
    scores: { ...scores, models: [...scores.models, ...f.scores.models.map(s => ({ ...s, benchmarkCostUSDPerTask: 5 }))] },
    catalog: [...f.catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)).map(p => ({
      ...p, models: p.models.filter(m => ["claude-opus-5-5", "gpt-6.1-sol"].includes(m.id)) })),
    { providerInstanceId: "antigravity", driverKind: "antigravity", canRunChildTask: true,
      models: [{ id: "gemini-4-neon", options: [{ id: "thought_level", type: "select",
        options: ["low", "medium", "high"].map(id => ({ id })) }] }] }],
    quota: { codex: observed([weekly("weekly", 96, .1)]),
      ...(agLeft === null ? {} : { antigravity: observed([weekly("gemini-weekly", agLeft, .8)]) }) },
    capacity: { codex: unlimited, antigravity: unknown },
    config: { benchmark: { indexVersion: "5" }, bans, providerPreference: preference } };
}

test("observed scenario: antigravity ahead of weekly pace is demoted below codex", () => {
  for (const role of ["general", "builder", "executor"] as const) {
    const r = recommend({ role }, data(66));
    assert.equal(r.providerInstanceId, "codex", role);
    assert.equal(r.alternatives.at(-1)?.providerInstanceId, "antigravity", role);
    assert.ok(r.reasons.some(x => /preferred provider antigravity demoted for pace: gemini-4-neon weekly pace -0\.14/.test(x)), role);
    assert.ok(r.byProvider.antigravity?.reasons.some(x => x.includes("demoted for pace")));
    assert.ok(r.diagnostics!.quota["antigravity:gemini-4-neon"]!.pace! < 0);
  }
});
test("antigravity keeps its preferred rank while under or at weekly pace", () => {
  for (const left of [90, 80]) {
    const r = recommend({ role: "general" }, data(left));
    assert.equal(r.providerInstanceId, "antigravity", String(left));
    assert.ok(!r.reasons.some(x => x.includes("demoted for pace")));
  }
});
test("unknown pace keeps provider preference order", () => {
  const r = recommend({ role: "general" }, data(null));
  assert.equal(r.providerInstanceId, "antigravity");
  assert.equal(r.diagnostics!.quota["antigravity:gemini-4-neon"]!.pace, null);
  // Codex ahead of pace drops below Claude, whose pace is unknown.
  const f = data(null);
  f.config = { ...f.config, providerPreference: ["codex", "claudeAgent", "antigravity"] };
  f.quota = { codex: observed([weekly("weekly", 20, .5)]) };
  f.capacity = {};
  const demoted = recommend({ role: "general" }, f);
  assert.equal(demoted.providerInstanceId, "claudeAgent");
  assert.deepEqual([...new Set(demoted.alternatives.map(t => t.providerInstanceId))], ["claudeAgent", "antigravity", "codex"]);
});
test("pace demotion only applies with an explicit provider preference", () => {
  const f = data(66);
  f.config = { ...f.config, providerPreference: [] };
  const r = recommend({ role: "general" }, f);
  assert.notEqual(r.providerInstanceId, "antigravity");
  assert.ok(!r.reasons.some(x => x.includes("demoted for pace")));
});
// Antigravity offers paced Gemini (ahead) and unpaced 3p Opus; Codex pace is unknown.
function mixed(opusCheapest: boolean): PolicyData {
  const f = data(66);
  f.catalog = f.catalog.map(p => p.driverKind !== "antigravity" ? p
    : { ...p, models: [...p.models, { ...p.models[0]!, id: "claude-opus-5-5" }] });
  f.quota = { antigravity: f.quota.antigravity! };
  f.capacity = {};
  if (opusCheapest) f.scores = { ...f.scores!, models: f.scores!.models.map(s =>
    s.model === "claude-opus-5-5" ? { ...s, benchmarkCostUSDPerTask: .1 }
    : s.model === "gemini-4-neon" ? { ...s, benchmarkCostUSDPerTask: 3 } : s) };
  f.config = { ...f.config, driverModels: { antigravity: ["gemini-4-neon", "claude-opus-5-5"] } };
  return f;
}
for (const opusCheapest of [true, false]) {
  test(`benchmark ranking keeps pace groups ahead of price and driver grouping (${opusCheapest ? "Opus" : "Gemini"} cheapest)`, () => {
    const r = recommend({ role: "general" }, mixed(opusCheapest));
    const order = [...new Set([r, ...r.alternatives].map(t => t.providerInstanceId + "/" + t.model))];
    assert.deepEqual(order, ["antigravity/claude-opus-5-5", "codex/gpt-6.1-sol", "claudeAgent/claude-opus-5-5", "antigravity/gemini-4-neon"]);
    assert.equal(r.byProvider.antigravity?.model, "claude-opus-5-5");
    assert.ok(r.reasons.some(x => x.includes("demoted for pace: gemini-4-neon")));
  });
}
test("review pair tries every not-ahead main candidate before an ahead-of-pace one", () => {
  // AG Opus finds no independent builder peer (codex excluded, native Claude offers the same
  // model); backtracking to ahead-of-pace AG Gemini must lose to native Claude Opus as main.
  const f = mixed(false);
  f.config = { ...f.config, roleProviderExclusions: { builder: ["codex"] } };
  const r = recommendReviewPair({ authorProvider: "codex", mainRole: "general", peerRole: "builder" }, f);
  assert.equal(r.status, "complete");
  assert.deepEqual([r.main?.providerInstanceId, r.main?.model], ["claudeAgent", "claude-opus-5-5"]);
  assert.deepEqual([r.peer?.providerInstanceId, r.peer?.model], ["antigravity", "gemini-4-neon"]);
  assert.ok(r.reasons.some(x => x.includes("demoted antigravity for pace")));
  // Without the ahead-of-pace window the preferred Gemini main is accepted as before.
  const paced = mixed(false);
  paced.quota = {};
  paced.config = { ...paced.config, roleProviderExclusions: { builder: ["codex"] } };
  const unchanged = recommendReviewPair({ authorProvider: "codex", mainRole: "general", peerRole: "builder" }, paced);
  assert.equal(unchanged.main?.providerInstanceId, "antigravity");
  assert.ok(!unchanged.reasons.some(x => x.includes("for pace")));
});
test("no_candidate names the role provider exclusions that removed drivers", () => {
  const f = { ...data(null), scores: null };
  f.config = { ...f.config, benchmark: null, roleProviderExclusions: { general: ["codex", "claudeAgent"] } };
  assert.throws(() => recommend({ role: "general" }, f), /roleProviderExclusions excludes claudeAgent, codex for role general/);
  assert.doesNotThrow(() => recommend({ role: "builder" }, f));
});
test("review pair ordering demotes a preferred driver that is ahead of pace", () => {
  const ahead = recommendReviewPair({ authorProvider: "codex" }, data(66));
  assert.equal(ahead.status, "complete");
  assert.equal(ahead.main?.providerInstanceId, "claudeAgent");
  assert.ok(ahead.reasons.some(x => x.includes("demoted antigravity for pace")));
  const paced = recommendReviewPair({ authorProvider: "codex" }, data(90));
  assert.equal(paced.main?.providerInstanceId, "antigravity");
  assert.ok(!paced.reasons.some(x => x.includes("for pace")));
});
test("roleProviderExclusions removes a driver for one role only", () => {
  const f = data(90);
  // As in the live route.json, the primary anchors are calibrated for these roles.
  const anchors = ["gpt-6.1-sol", "claude-opus-5-5"];
  f.config = { ...f.config, benchmark: { indexVersion: "5", anchors: { "bulk-read": anchors, "critical-review": anchors } } };
  assert.equal(recommend({ role: "bulk-read" }, f).providerInstanceId, "antigravity");
  f.config = { ...f.config, roleProviderExclusions: { "bulk-read": ["antigravity"] } };
  const bulk = recommend({ role: "bulk-read" }, f);
  assert.notEqual(bulk.providerInstanceId, "antigravity");
  assert.ok(!bulk.alternatives.some(t => t.providerInstanceId === "antigravity"));
  assert.equal(bulk.byProvider.antigravity?.eligible, false);
  assert.ok(bulk.reasons.includes("antigravity: roleProviderExclusions excludes antigravity for role bulk-read"));
  for (const role of ["general", "builder", "executor", "critical-review"] as const)
    assert.equal(recommend({ role }, f).providerInstanceId, "antigravity", role);
  // Review pairs apply the exclusion only to slots whose role is excluded.
  assert.equal(recommendReviewPair({ authorProvider: "codex" }, f).main?.providerInstanceId, "antigravity");
  const bulkPair = recommendReviewPair({ authorProvider: "codex", mainRole: "bulk-read", peerRole: "bulk-read" }, f);
  assert.notEqual(bulkPair.main?.providerInstanceId, "antigravity");
  assert.notEqual(bulkPair.peer?.providerInstanceId, "antigravity");
});
test("roleProviderExclusions config validates roles and routed driver kinds", () => {
  const d = routeScratch();
  try {
    const path = join(d.path, "route.json");
    assert.deepEqual(loadRouteConfig(d.path, path).roleProviderExclusions, {});
    for (const value of [{}, { "bulk-read": ["antigravity"] }, { "bulk-read": [], builder: ["codex", "antigravity"] }]) {
      writeFileSync(path, JSON.stringify({ roleProviderExclusions: value }));
      assert.deepEqual(loadRouteConfig(d.path, path).roleProviderExclusions, value);
    }
    for (const value of [null, "antigravity", ["antigravity"], { reader: ["codex"] }, { "bulk-read": "antigravity" },
      { "bulk-read": ["antigravity", "antigravity"] }, { "bulk-read": ["gemini"] }, { "bulk-read": [1] },
      { "bulk-read": Array.from({ length: 21 }, () => "codex") }]) {
      writeFileSync(path, JSON.stringify({ roleProviderExclusions: value }));
      assert.throws(() => loadRouteConfig(d.path, path), /Invalid role provider exclusions/, JSON.stringify(value));
    }
  } finally { d.remove(); }
});
test("live Antigravity weekly pacing reaches the ranked candidate through the route context", async () => {
  const d = routeScratch();
  try {
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
    const state = emptyState();
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache"), providerPreference: preference }));
    const used = (id: string, kind: string, mins: number, left: number, resetsAt: string | null) =>
      ({ id, kind, usedPercent: 100 - left, windowDurationMins: mins, ...(resetsAt ? { resetsAt } : {}) });
    const ag: SwitchProvider = { instanceId: "antigravity", driver: "antigravity", enabled: true, installed: true, status: "ready",
      auth: { status: "authenticated" }, models: [{ slug: "gemini-4-neon",
        capabilities: { optionDescriptors: [{ id: "thought_level", type: "select", options: [{ id: "medium" }] }] } }],
      usageLimits: { credentialFingerprint: "a".repeat(64), checkedAt: iso(now - 1), windows: [
        used("3p-5h", "session", 300, 100, null), used("gemini-5h", "session", 300, 90, iso(now + 3600_000)),
        used("3p-weekly", "weekly", 10080, 100, null), used("gemini-argon-wtu-weekly", "weekly", 10080, 100, null),
        used("gemini-weekly", "weekly", 10080, 66, iso(now + .8 * WEEK))] } };
    // Two attributed snapshots admit the live credential context, as in the observer.
    let clock = now - 20;
    const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
      local: true, now: () => clock, save: () => {} });
    monitor.update([{ ...ag, usageLimits: { ...ag.usageLimits!, checkedAt: iso(clock - 1) } }]);
    clock += 10; monitor.update([{ ...ag, usageLimits: { ...ag.usageLimits!, checkedAt: iso(clock - 1) } }]);
    saveState(stateFile, state, now);
    const { data: live } = await collectRouteContext({ home: d.path, configPath, now, catalog: async () => routeCatalog([ag]),
      fetcher: async () => { throw new Error("fixture offline"); } });
    const r = recommend({ role: "general" }, { ...live, config: { ...live.config, benchmark: { indexVersion: "5" } },
      scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(now), unmapped: [],
        models: [{ model: "gemini-4-neon", effort: "medium", aaSlug: "gemini-4-neon", intelligence: 60, coding: 60,
          inputPrice: 1, outputPrice: 1, benchmarkCostUSDPerTask: 1 }] } });
    assert.equal(r.providerInstanceId, "antigravity");
    // Capacity is classified from the same family-scoped windows as the model's pace.
    assert.ok(r.reasons.some(x => x.startsWith("antigravity capacity paced: ")));
    assert.ok(!r.reasons.some(x => x.includes("capacity unknown")));
    assert.ok(r.reasons.some(x => x === "antigravity weekly 66% left with 80% of window left: on/ahead of pace"));
    assert.ok(Math.abs(r.diagnostics!.quota["antigravity:gemini-4-neon"]!.pace! - (-.14)) < 1e-6);
  } finally { d.remove(); }
});
