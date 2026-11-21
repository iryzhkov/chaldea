import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { RouteState } from "../../src/route/state.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { emptyHistory } from "../../src/route/targets.ts";
import { collectRouteContext } from "../../src/route/runtime.ts";
import { newProvider } from "../../src/quota/headroom.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { observeThread } from "../../src/quota/observer.ts";
import { classifyCapacities } from "../../src/quota/capacity.ts";
import { capacityKey } from "../../src/quota/account.ts";
import { fixture, scores, analytics, stats, newcomer, now, iso } from "../fixtures/route/targets.ts";
import { limited } from "../helpers/threads.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const option = (id: string) => [{ id, type: "select", options: ["low", "medium", "high"].map(id => ({ id })) }];
const win = (left: number) => ({ id: "weekly", kind: "weekly", usedPercent: 100 - left, remainingPercent: left,
  windowDurationMins: 10080, resetsAt: iso(now + 86400000) });
const read = (db: DatabaseSync, role: string) => {
  const row = db.prepare("SELECT value FROM history WHERE role=?").get(role);
  return row ? JSON.parse(String(row.value)) : null;
};
const write = (db: DatabaseSync, role: string, history: unknown) =>
  db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value").run(role, JSON.stringify(history));
const google = { providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true,
  models: [{ id: "gemini-4-neon", options: option("thought_level") }] };

test("B1: repeated primary alternatives stay unreserved after the tenth call, matching main", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path), db = new DatabaseSync(path);
  try {
    const models = ["gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-astra"];
    const f = fixture();
    const data: PolicyData = { ...f, catalog: [{ providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
      models: models.map(id => ({ id, options: option("reasoningEffort") })) }],
      config: { benchmark: { indexVersion: "5" } },
      scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(now), unmapped: [],
        models: models.map((model, i) => ({ model, effort: "medium", aaSlug: model, intelligence: 55, coding: 55,
          inputPrice: i + 1, outputPrice: i + 1, benchmarkCostUSDPerTask: i + 1 })) },
      analytics: { ...f.analytics, models: Object.fromEntries(models.map(m => [m, stats()])) } };
    for (let i = 0; i < 12; i++) {
      const result = routing.recommend({ role: "general" }, data, "fixture", false);
      assert.equal(result.model, "gpt-6.1-sol");
      assert.deepEqual(result.alternatives.map(t => t.model), i < 9 ? [] : models.slice(1));
    }
    const h = read(db, "general:benchmark:5");
    for (const model of models.slice(1)) assert.deepEqual(h.allocations[model], { calls: 12, trials: 0 });
  } finally { db.close(); routing.close(); d.remove(); }
});

test("B2: primary stop identity and propagation use main's current-row behavior only", async () => {
  for (const driver of ["codex", "claudeAgent"]) {
    const d = routeScratch(), a = "a".repeat(64), b = "b".repeat(64), state = emptyState();
    try {
      const row = (alias: string, accountKey: string) => {
        const p = newProvider(alias, driver); p.accountKey = accountKey;
        p.included = { value: [win(50)], state: "fresh", source: "t3", observedAt: iso(now - 1000), error: null };
        return p;
      };
      const x = row("X", a); state.headroom.providers.push(x);
      const stopped = { ...limited("run", now - 500, null), providerInstanceId: "X" };
      observeThread(state, stopped, now - 400);
      const stop = state.parked.get(stopped.id)!;
      assert.equal(Object.hasOwn(stop, "driver"), false); assert.equal(Object.hasOwn(stop, "identityChecked"), false);
      // Also accept state written by older PR versions, but ignore its saved primary identity.
      const legacyStop = { ...stop, driver, accountKey: a };
      state.parked.set(stopped.id, legacyStop);
      x.accountKey = b; state.headroom.providers.push(row("Y", a), row("Z", b));
      const capacity = classifyCapacities(state, now);
      assert.notEqual(capacity[capacityKey(driver, a)]?.class, "stopped");
      assert.equal(capacity[capacityKey(driver, b)]?.class, "stopped");
      const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
      saveState(stateFile, state, now);
      writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache") }));
      const id = driver === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5";
      const context = await collectRouteContext({ home: d.path, configPath, now,
        catalog: async () => state.headroom.providers.map(p => ({ providerInstanceId: p.alias, driverKind: driver,
          accountKey: p.accountKey!, canRunChildTask: true, models: [{ id, options: option(driver === "codex" ? "reasoningEffort" : "effort") }] })),
        fetcher: async () => { throw new Error("fixture offline"); } });
      for (const role of ["builder", "general"] as const) assert.equal(recommend({ role }, context.data).providerInstanceId, "Y");
    } finally { d.remove(); }
  }
});

test("B3: hidden primary models keep accumulating calls on saved plain keys", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path), db = new DatabaseSync(path);
  try {
    const f = fixture(), primary = f.catalog.filter(p => ["codex", "claudeAgent"].includes(p.driverKind));
    const h = emptyHistory();
    for (const p of primary) for (const m of p.models) h.seen[m.id] = now - 30 * 86400000;
    h.seen[newcomer] = now;
    write(db, "bulk-read", h);
    for (let i = 0; i < 40; i++) {
      const catalog = i < 2 ? primary : primary.map(p => ({ ...p, models: p.models.filter(m => m.id !== newcomer) }));
      routing.recommend({ role: "bulk-read" }, { ...f, catalog, now: now + i * 1000 }, "fixture", false);
    }
    assert.deepEqual(read(db, "bulk-read").allocations[newcomer], { calls: 40, trials: 0 });
    const result = routing.recommend({ role: "bulk-read" }, { ...f, catalog: primary, now: now + 40000 }, "fixture", false);
    assert.equal(result.byProvider.claudeAgent?.model, newcomer);
    assert.deepEqual(read(db, "bulk-read").allocations[newcomer], { calls: 41, trials: 1 });
  } finally { db.close(); routing.close(); d.remove(); }
});

test("B4: unused review probes persist only Antigravity seen entries over the original history", () => {
  for (const withAntigravity of [false, true]) {
    const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path), db = new DatabaseSync(path);
    try {
      const f = fixture(), primary = f.catalog.filter(p => ["codex", "claudeAgent"].includes(p.driverKind));
      const catalog = [...primary, ...(withAntigravity ? [google] : [])];
      const pair = routing.reviewPair({ authorProvider: "claudeAgent", mainRole: "general", peerRole: "bulk-read" },
        { ...f, catalog, quota: { claudeAgent: { observedAt: iso(now), windows: [], activeStop: true } } });
      assert.equal(pair.status, "partial");
      const probe = read(db, "bulk-read:medium");
      if (withAntigravity) {
        assert.deepEqual(Object.keys(probe.seen), ["antigravity:gemini-4-neon"]);
        assert.deepEqual(probe.allocations["antigravity:gemini-4-neon"], { calls: 0, trials: 0 });
      } else assert.equal(probe, null);
      const later = now + 8 * 86400000;
      const result = routing.recommend({ role: "bulk-read", effortOverride: "medium" },
        { ...f, catalog, now: later, scores: { ...scores, fetchedAt: iso(later) },
          analytics: { ...analytics, fetchedAt: iso(later), sourceFetchedAt: iso(later), endExclusive: iso(later - 3600000) } }, "fixture", false);
      assert.notEqual(result.model, newcomer);
      assert.equal(read(db, "bulk-read:medium").seen[newcomer], later);
    } finally { db.close(); routing.close(); d.remove(); }
  }
});

test("Sol 5: stopped Neon cannot authorize a primary waiver when Claude is absent", () => {
  const f = fixture(), catalog = f.catalog.filter(p => p.providerInstanceId === "codex");
  const input = { authorProvider: "codex" as const, allowQuotaException: true };
  const baseline = recommendReviewPair(input, { ...f, catalog });
  const result = recommendReviewPair(input, { ...f, catalog: [...catalog, google],
    scores: { ...f.scores, models: [...f.scores.models, { model: "gemini-4-neon", effort: "medium", aaSlug: "gemini-4-neon-medium",
      intelligence: 55, coding: 55, inputPrice: 1, outputPrice: 1 }] },
    quota: { ag: { observedAt: iso(now), windows: [], activeStop: true } } });
  assert.deepEqual(result, baseline);
  assert.equal(result.status, "unavailable"); assert.equal(result.quotaException, false);
});
