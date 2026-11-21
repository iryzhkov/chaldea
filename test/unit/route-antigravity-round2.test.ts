import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { RouteState } from "../../src/route/state.ts";
import { driverPickKey, historyModelKey, roleKey } from "../../src/route/targets.ts";

import { loadRouteConfig } from "../../src/route/config.ts";





import { modelWindowPolicy } from "../../src/quota/window-policy.ts";
import { fixture, stats, now, iso } from "../fixtures/route/targets.ts";
import { catalog } from "../fixtures/route/catalog.ts";

import { routeScratch } from "../fixtures/route/scratch.ts";

const google = (models = ["gemini-4-neon"]) => ({
  providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true,
  models: models.map(id => ({ id, options: [{ id: "thought_level", type: "select",
    options: ["low", "medium", "high", "xhigh"].map(id => ({ id })) }] })),
});
const window = (id: string, left: number) => ({ id, kind: "weekly", remainingPercent: left,
  windowDurationMins: 10080, resetsAt: iso(now + 86400000) });
const exhausted = { observedAt: iso(now), activeStop: false, windows: [window("seven_day", 0)] };
const score = (model: string, cost = 1) => ({ model, effort: "medium" as const, aaSlug: model,
  intelligence: 55, coding: 55, inputPrice: 1, outputPrice: 1, benchmarkCostUSDPerTask: cost });
function bench(models = ["gemini-4-neon"]): PolicyData {
  const f = fixture();
  return { ...f, catalog: [...catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)).map(p => ({
    ...p, models: p.models.filter(m => ["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5"].includes(m.id)),
  })), google(models)], config: { benchmark: { indexVersion: "5" } },
    scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(now), unmapped: [],
      models: [...new Set(["gpt-6.1-sol", "gpt-6-astra", "claude-opus-5-5", ...models])].map(m => score(m)) },
    analytics: { ...f.analytics, models: { ...f.analytics.models,
      ...Object.fromEntries(models.map(m => [m, stats()])) } } };
}
test("O-B1 repro: an unroutable Antigravity cannot remove the original fixed-policy quota exception", () => {
  const input = { authorProvider: "codex" as const, peerRole: "critical-review" as const,
    peerEffort: "medium" as const, allowQuotaException: true };
  const base = { catalog, now, analytics: null, quota: { claudeAgent: exhausted } };
  const expected = recommendReviewPair(input, base);
  assert.equal(expected.code, "quota_exception"); assert.equal(expected.status, "complete");
  for (const ag of [google(), { ...google(), canRunChildTask: false }]) for (const agQuota of [
    undefined, { ...exhausted, windows: [window("gemini-weekly", 0), window("3p-weekly", 0)] },
  ]) {
    const result = recommendReviewPair(input, { ...base, catalog: [...catalog, ag],
      quota: { ...base.quota, ...(agQuota ? { ag: agQuota } : {}) } });
    assert.deepEqual(result, expected);
  }
});
test("O-B1: incomplete coverage is no alternative, and pressure checks each routable Antigravity model", () => {
  const input = { authorProvider: "codex" as const, allowQuotaException: true };
  const f = bench();
  const incomplete = { ...f, catalog: [...f.catalog.slice(0, 2), google(["gemini-4-neon", "unscored"])] };
  const quota = { claudeAgent: exhausted };
  assert.equal(recommendReviewPair(input, { ...incomplete, quota }).code, "quota_exception");
  assert.equal(recommendReviewPair(input, { ...incomplete,
    catalog: [...f.catalog.slice(0, 2), google(["gemini-4-neon", "gpt-unmeasured"])], quota }).code, "quota_exception");
  assert.equal(recommendReviewPair(input, { ...f, quota }).quotaException, false);
  for (const windows of [[window("gemini-weekly", 0)], [window("gemini-new-pool", 0), window("3p-weekly", 90)]]) {
    const result = recommendReviewPair(input, { ...f, quota: { ...quota, ag: { ...exhausted, windows } } });
    assert.equal(result.code, "quota_exception");
  }
  const proxy = bench(["gemini-4-neon", "claude-opus-5-5"]);
  proxy.config = { ...proxy.config, driverModels: { antigravity: ["gemini-4-neon", "claude-opus-5-5"] } };
  // Gemini is empty but the admissible third-party model still has quota.
  assert.equal(recommendReviewPair(input, { ...proxy, quota: { ...quota,
    ag: { ...exhausted, windows: [window("gemini-weekly", 0), window("3p-weekly", 90)] } } }).quotaException, false);
  assert.equal(recommendReviewPair(input, { ...proxy, quota: { ...quota,
    ag: { ...exhausted, windows: [window("gemini-weekly", 0), window("3p-weekly", 0)] } } }).code, "quota_exception");
});
test("O-B2 repro: a shared primary incumbent retains main's cross-driver analytics comparison", () => {
  const f = fixture();
  const data = { ...f, catalog: catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)),
    analytics: { ...f.analytics, models: { ...f.analytics.models, "gpt-6.1-sol": stats(10) } },
    history: { ...f.history, picks: { general: { providerInstanceId: "claudeAgent",
      model: "claude-fable-5-1", options: { effort: "medium" as const } } } } };
  const expected = recommend({ role: "general" }, data);
  assert.ok(expected.reasons.includes("gpt-6-astra: probation evidence passed"));
  const disabled = recommend({ role: "general" }, { ...data, catalog: [...data.catalog, { ...google(), canRunChildTask: false }] });
  assert.equal(disabled.model, expected.model);
  assert.deepEqual(disabled.alternatives, expected.alternatives);
});
test("S-3: a settled Antigravity incumbent has a persistent separate driver slot", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite");
  const routing = new RouteState(path);
  try {
    const f = bench(["gemini-4-neon", "gemini-3.8-flash"]);
    f.now = now + 8 * 86400000; // First record gets seeded explicitly as settled.
    f.config = { ...f.config, providerPreference: ["antigravity"] };
    f.scores!.models.find(s => s.model === "gemini-3.8-flash")!.benchmarkCostUSDPerTask = .1;
    const key = roleKey("general", undefined, undefined, "5"), db = new DatabaseSync(path);
    const h = fixture().history;
    h.seen[historyModelKey("antigravity", "gemini-3.8-flash")] = now;
    h.picks[key] = { providerInstanceId: "codex", model: "gpt-6.1-sol", options: { reasoningEffort: "medium" } };
    db.prepare("INSERT INTO history VALUES(?,?)").run(key, JSON.stringify(h)); db.close();
    f.analytics = { ...f.analytics!, fetchedAt: iso(f.now), sourceFetchedAt: iso(f.now), endExclusive: iso(f.now) };
    const native = recommend({ role: "general" }, { ...f, history: h, catalog: f.catalog.filter(p => p.driverKind !== "antigravity") });
    assert.equal(routing.recommend({ role: "general" }, f, "fixture", false).model, "gemini-3.8-flash");
    const inspect = new DatabaseSync(path);
    const saved = JSON.parse(String(inspect.prepare("SELECT value FROM history WHERE role=?").get(key)!.value));
    inspect.close();
    assert.equal(saved.picks[key].model, native.model);
    assert.equal(saved.picks[driverPickKey(key, "antigravity")].model, "gemini-3.8-flash");
    // Loss of Neon analytics cannot prevent the settled Flash incumbent from routing.
    f.analytics = null;
    assert.equal(routing.recommend({ role: "general" }, f, "fixture", false).model, "gemini-3.8-flash");
  } finally { routing.close(); d.remove(); }
});
test("S-4: probation alternatives are omitted unless reserved, with driver/model trial accounting", () => {
  const d = routeScratch(), path = join(d.path, "route.sqlite"), routing = new RouteState(path);
  try {
    const f = bench(["gemini-4-neon", "gemini-3.8-flash"]);
    f.scores!.models.find(s => s.model === "gemini-4-neon")!.benchmarkCostUSDPerTask = .1;
    for (let i = 0; i < 10; i++) {
      const result = routing.recommend({ role: "bulk-read" }, f, "fixture", false);
      assert.ok(!result.alternatives.some(t => t.model === "gemini-3.8-flash"));
    }
    f.scores!.models.find(s => s.model === "gemini-3.8-flash")!.benchmarkCostUSDPerTask = .01;
    let trials = 0;
    for (let i = 0; i < 20; i++) {
      const result = routing.recommend({ role: "bulk-read" }, f, "fixture", false);
      if (result.byProvider.antigravity?.model === "gemini-3.8-flash") trials++;
      assert.ok(!result.alternatives.some(t => t.model === "gemini-3.8-flash") ||
        result.byProvider.antigravity?.model === "gemini-3.8-flash");
    }
    const db = new DatabaseSync(path);
    const h = JSON.parse(String(db.prepare("SELECT value FROM history WHERE role=?").get("bulk-read:benchmark:5")!.value));
    db.close();
    const a = h.allocations[historyModelKey("antigravity", "gemini-3.8-flash")];
    assert.equal(a.calls, 30); assert.equal(a.trials, trials); assert.ok(trials <= 3 && trials > 0);
    assert.equal(h.seen[historyModelKey("antigravity", "gemini-3.8-flash")], now);
    assert.equal(h.seen["gemini-3.8-flash"], undefined);
  } finally { routing.close(); d.remove(); }
});
test("S-5: try another main when the preferred driver is required for the peer pin", () => {
  const f = bench();
  f.config = { ...f.config, providerPreference: ["antigravity"],
    pins: { general: { providerInstanceId: "ag", model: "gemini-4-neon" } } };
  const result = recommendReviewPair({ authorProvider: "codex", mainRole: "builder", peerRole: "general" }, f);
  assert.equal(result.status, "complete"); assert.equal(result.main?.providerInstanceId, "claudeAgent");
  assert.equal(result.peer?.providerInstanceId, "ag"); assert.equal(result.quotaException, false);
});
test("S-6: exact Neon xhigh survives legacy mode; absent or disabled Antigravity preserves main's fallback", () => {
  const f = fixture();
  f.scores.models.push({ model: "gemini-4-neon", effort: "xhigh", aaSlug: "gemini-4-neon",
    intelligence: 61.4, coding: 60, inputPrice: 1, outputPrice: 2 });
  const input = { role: "general" as const, effortOverride: "xhigh" as const };
  const r = recommend(input, { ...f, catalog: [...f.catalog, google()] });
  assert.equal(r.model, "gemini-4-neon"); assert.equal(r.diagnostics?.quality_source, "AA");
  const original = recommend(input, f);
  assert.equal(original.diagnostics?.quality_source, "fixed_policy");
  const disabled = recommend(input, { ...f, catalog: [...f.catalog, { ...google(), canRunChildTask: false }] });
  assert.equal(disabled.model, original.model);
  assert.equal(disabled.diagnostics?.quality_source, "fixed_policy");
  const stopped = recommend(input, { ...f, catalog: [...f.catalog, google()],
    quota: { ag: { observedAt: iso(now), windows: [], activeStop: true } } });
  assert.equal(stopped.model, original.model);
  assert.equal(stopped.diagnostics?.quality_source, "fixed_policy");
});
test("N-1: review model family separation applies even through explicit driver allowlists", () => {
  for (const [authorProvider, model] of [["claudeAgent", "claude-opus-5-5"], ["codex", "gpt-6.1-sol"]] as const) {
    const f = bench([model]);
    f.config = { ...f.config, providerPreference: ["antigravity"], driverModels: { antigravity: [model] } };
    const result = recommend({ role: "builder", authorProvider }, f);
    assert.equal(result.byProvider.antigravity?.eligible, false);
    assert.ok(result.alternatives.every(t => t.providerInstanceId !== "ag"));
  }
});
test("N-2: unknown IDs constrain only their own family; unrelated model families get no invented family quota", () => {
  const windows = [window("gemini-future", 0), window("3p-future", 0)];
  for (const model of ["gemini-4-neon", "claude-opus-5-5", "gpt-oss-120b-medium"])
    assert.ok(modelWindowPolicy(windows, model, now, .1, .1, "antigravity").limit);
  assert.equal(modelWindowPolicy(windows, "unclassified-model", now, .1, .1, "antigravity").limit, undefined);
});
test("N-3: provider preferences accept only routed driver kinds", () => {
  const d = routeScratch();
  try {
    const path = join(d.path, "route.json");
    for (const providerPreference of [["unknown"], ["gemini"], ["codex", "claudAgent"]]) {
      writeFileSync(path, JSON.stringify({ providerPreference }));
      assert.throws(() => loadRouteConfig(d.path, path), /Invalid provider preference/);
    }
  } finally { d.remove(); }
});
