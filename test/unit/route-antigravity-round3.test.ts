import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { emptyHistory, historyModelKey } from "../../src/route/targets.ts";






import { fixture, now, iso, stats } from "../fixtures/route/targets.ts";

import { routeScratch } from "../fixtures/route/scratch.ts";

const window = (left: number) => ({ id: "weekly", kind: "weekly", usedPercent: 100 - left,
  remainingPercent: left, windowDurationMins: 10080, resetsAt: iso(now + 86400000) });
const option = (id: string) => [{ id, type: "select", options: ["low", "medium", "high"].map(id => ({ id })) }];
const score = (model: string, cost: number) => ({ model, effort: "medium" as const, aaSlug: model,
  intelligence: 55, coding: 55, inputPrice: cost, outputPrice: cost, benchmarkCostUSDPerTask: cost });
function bench(models = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"]): PolicyData {
  const f = fixture();
  return { ...f, catalog: [{ providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
    models: models.map(id => ({ id, options: option("reasoningEffort") })) }],
    config: { benchmark: { indexVersion: "5" } },
    scores: { version: 2, metric: "aa-intelligence-cost-per-task", fetchedAt: iso(now), indexVersion: "5", unmapped: [],
      models: models.map((m, i) => score(m, i + 1)) },
    analytics: { ...f.analytics, models: Object.fromEntries(models.map(m => [m, stats()])) } };
}
const readHistory = (db: DatabaseSync, key: string) => JSON.parse(String(db.prepare("SELECT value FROM history WHERE role=?").get(key)!.value));
const writeHistory = (db: DatabaseSync, key: string, h: unknown) =>
  db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(h));

test("R3-3: alternating main-format and PR writers share the plain primary provider-pick budget", () => {
  for (const [share, calls] of [[.5, 5], [.1, 60]]) {
    const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path), db = new DatabaseSync(path);
    try {
      const f = bench(["gpt-6.1-sol", "gpt-6.1-terra"]); f.config = { ...f.config, probationShare: share! };
      f.scores!.models.find(m => m.model === "gpt-6.1-terra")!.benchmarkCostUSDPerTask = .1;
      const key = "general:benchmark:5", h = emptyHistory(), model = "gpt-6.1-terra";
      h.seen[model] = now; h.allocations[model] = { calls: 0, trials: 0 };
      writeHistory(db, key, h);
      let exposed = 0;
      for (let i = 0; i < calls!; i++) {
        if (i % 2 === 0) {
          const result = routing.recommend({ role: "general" }, f, "fixture", false);
          if (result.model === model || Object.values(result.byProvider).some(p => p.eligible && p.model === model)) exposed++;
        } else {
          // A main-format writer reads/writes only the plain model counter in the shared row.
          const legacy = readHistory(db, key), allocation = legacy.allocations[model];
          const trial = allocation.trials + 1 <= Math.floor((allocation.calls + 1) * share! + 1e-9);
          allocation.calls++; allocation.trials += Number(trial); exposed += Number(trial);
          writeHistory(db, key, legacy);
        }
        assert.ok(exposed <= Math.floor((i + 1) * share! + 1e-9));
      }
      const saved = readHistory(db, key);
      assert.deepEqual(saved.allocations[model], { calls, trials: exposed });
      assert.equal(saved.allocations["codex:" + model], undefined);
      assert.equal(historyModelKey("codex", model), model);
    } finally { db.close(); routing.close(); d.remove(); }
  }
});

test("R3-4a: an Antigravity-only preference preserves executor's primary tie-break when unavailable", () => {
  const f = fixture();
  const google = { providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true,
    models: [{ id: "gemini-4-neon", options: option("thought_level") }] };
  for (const extra of [[], [google], [{ ...google, canRunChildTask: false }]]) {
    const result = recommend({ role: "executor" }, { ...f, catalog: [...f.catalog, ...extra],
      quota: { ag: { observedAt: iso(now), windows: [], activeStop: true } },
      config: { providerPreference: ["antigravity"] } });
    assert.equal(result.providerInstanceId, "codex");
  }
  assert.equal(recommend({ role: "executor" }, { ...f,
    config: { providerPreference: ["claudeAgent", "codex"] } }).providerInstanceId, "claudeAgent");
});

test("R3-4b: primary alternatives remain visible and unreserved exactly as on main", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path), db = new DatabaseSync(path);
  try {
    const f = bench(), key = "general:benchmark:5", history = emptyHistory();
    for (const model of ["gpt-6.1-terra", "gpt-6-astra"]) {
      history.seen[model] = now;
      history.allocations[model] = { calls: 10, trials: 0 };
    }
    writeHistory(db, key, history);
    const pure = recommend({ role: "general" }, { ...f, history });
    assert.equal(pure.model, "gpt-6.1-sol");
    assert.deepEqual(pure.alternatives.map(t => t.model).sort(), ["gpt-6-astra", "gpt-6.1-terra"]);
    const result = routing.recommend({ role: "general" }, f, "fixture", false);
    assert.deepEqual(result.alternatives, pure.alternatives);
    const saved = readHistory(db, key);
    for (const model of ["gpt-6.1-terra", "gpt-6-astra"])
      assert.deepEqual(saved.allocations[model], { calls: 11, trials: 0 });
    assert.deepEqual(routing.recommend({ role: "general" }, f, "fixture", false).alternatives, pure.alternatives);
  } finally { db.close(); routing.close(); d.remove(); }
});

test("R3-5: unknown quota on a runnable Haiku-only Claude instance blocks the primary waiver", () => {
  const f = fixture(), claude = f.catalog.find(p => p.providerInstanceId === "claudeAgent")!;
  const haiku = { ...claude, providerInstanceId: "haiku-only",
    models: claude.models.filter(m => m.id === "claude-haiku-5-5") };
  const base = { catalog: [...f.catalog, haiku], now, analytics: null,
    quota: { claudeAgent: { observedAt: iso(now), windows: [window(0)], activeStop: false } } };
  const input = { authorProvider: "codex" as const, peerRole: "critical-review" as const,
    peerEffort: "medium" as const, allowQuotaException: true };
  const result = recommendReviewPair(input, base);
  assert.equal(result.status, "unavailable"); assert.equal(result.quotaException, false);
  const known = recommendReviewPair(input, { ...base, quota: { ...base.quota, "haiku-only": base.quota.claudeAgent } });
  assert.equal(known.code, "quota_exception");
});

test("R3-6: a refused Flash-only route persists first-seen without spending a trial and ages out", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path), db = new DatabaseSync(path);
  try {
    const f = bench(["gemini-3.8-flash", "gemini-4-neon"]);
    f.catalog = [{ providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true,
      models: [{ id: "gemini-3.8-flash", options: option("thought_level") }] }];
    assert.throws(() => routing.recommend({ role: "bulk-read" }, f, "fixture", false), /probation share/);
    const saved = readHistory(db, "bulk-read:benchmark:5"), key = "antigravity:gemini-3.8-flash";
    assert.equal(saved.seen[key], now);
    assert.deepEqual(saved.allocations[key], { calls: 0, trials: 0 });
    const later = now + 8 * 86400000;
    f.now = later;
    f.analytics = { ...f.analytics!, fetchedAt: iso(later), sourceFetchedAt: iso(later), endExclusive: iso(later) };
    assert.equal(routing.recommend({ role: "bulk-read" }, f, "fixture", false).model, "gemini-3.8-flash");
    assert.deepEqual(readHistory(db, "bulk-read:benchmark:5").allocations[key], { calls: 0, trials: 0 });
  } finally { db.close(); routing.close(); d.remove(); }
});
