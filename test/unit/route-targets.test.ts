import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { recommend } from "../../src/route/policy.ts";
import { RouteState } from "../../src/route/state.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import { newProvider } from "../../src/quota/headroom.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { fixture, now, iso, newcomer, stats } from "../fixtures/route/targets.ts";

test("a reviewed new cheaper Haiku passes probation and replaces bulk-read; Sonnet is banned", () => {
  const r = recommend({ role: "bulk-read" }, fixture());
  assert.equal(r.model, newcomer);
  assert.equal(r.options.effort, "medium");
  assert.match(r.reasons.join(" "), /unreviewed-aa-model/);
  assert.match(r.reasons.join(" "), /sonnet-5-5: banned/);
  assert.ok(!r.alternatives.some(t => t.model.includes("sonnet")));
});
test("new models need both sufficient turns and a normal failure rate, even after seven days", () => {
  for (const s of [stats(99), stats(100, .20)]) {
    const f = fixture(); f.analytics.models[newcomer] = s;
    const r = recommend({ role: "bulk-read" }, f);
    assert.equal(r.model, "claude-haiku-5-5");
    assert.match(r.reasons.join(" "), /probation held/);
  }
  const f = fixture(); f.analytics.models["claude-haiku-5-5"] = stats(1);
  assert.notEqual(recommend({ role: "bulk-read" }, f).model, newcomer);
});
test("AA floor, unmapped models, unavailable efforts and disabled providers remain hard gates", () => {
  const f = fixture(); f.scores = structuredClone(f.scores); f.scores.models.find(s => s.model === newcomer)!.intelligence = 29;
  assert.notEqual(recommend({ role: "bulk-read" }, f).model, newcomer);
  f.scores.models = f.scores.models.filter(s => s.model !== newcomer);
  assert.match(recommend({ role: "bulk-read" }, f).reasons.join(" "), /unmapped or missing AA/);
  assert.equal(recommend({ role: "builder" }, fixture()).model, "gpt-6.1-sol");
});
test("stale AA uses last good scores; absent and future snapshots use safe pairs", () => {
  const f = fixture(); f.scores = { ...f.scores, fetchedAt: iso(now - 4 * 86400000) };
  const stale = recommend({ role: "bulk-read" }, f);
  assert.equal(stale.model, newcomer); assert.match(stale.reasons.join(" "), /AA snapshot stale; use last good/);
  for (const scores of [null, { ...f.scores, fetchedAt: iso(now + 1000) }]) {
    const r = recommend({ role: "bulk-read" }, { ...f, scores });
    assert.equal(r.model, "claude-haiku-5-5"); assert.match(r.reasons.join(" "), /fixed role pairs/);
  }
});
test("pins override bans/floors/probation but retain review separation, effort support and active stops", () => {
  const f = fixture(), config = { pins: { "bulk-read": { model: "claude-sonnet-5-5" } } };
  assert.equal(recommend({ role: "bulk-read" }, { ...f, config }).model, "claude-sonnet-5-5");
  assert.throws(() => recommend({ role: "critical-review", authorProvider: "codex" }, {
    ...f, config: { pins: { "critical-review": { model: "gpt-6-astra" } } },
  }), /No eligible/);
  assert.throws(() => recommend({ role: "bulk-read" }, { ...f, config,
    quota: { claudeAgent: { observedAt: iso(now), windows: [], activeStop: true } } }), /No eligible/);
});
test("under-paced Claude precedes Codex credits, then unlimited credits win with no credit floor", () => {
  const f = fixture(), row = newProvider("codex", "codex");
  row.credits = { state: "fresh", observedAt: iso(now), value: { balance: "0.01", hasCredits: true, unlimited: false },
    source: "fixture", error: null };
  const credit = classifyCapacity(row, false, now);
  assert.equal(credit.class, "unlimited");
  const unknown = classifyCapacity(newProvider("claudeAgent", "claudeAgent"), false, now);
  const weekly = (remainingPercent: number) => ({ observedAt: iso(now), activeStop: false,
    windows: [{ kind: "weekly", remainingPercent, windowDurationMins: 10080, resetsAt: iso(now + .4 * 7 * 86400000) }] });
  const base = { ...f, capacity: { codex: credit, claudeAgent: unknown } };
  const claude = recommend({ role: "bulk-read" }, { ...base, quota: { claudeAgent: weekly(62) } });
  assert.equal(claude.providerInstanceId, "claudeAgent"); assert.equal(claude.model, newcomer); assert.equal(claude.topPick!.model, newcomer);
  const codex = recommend({ role: "bulk-read" }, { ...base, quota: { claudeAgent: weekly(49) } });
  assert.equal(codex.providerInstanceId, "codex"); assert.equal(codex.model, "gpt-6-luna"); assert.equal(codex.topPick!.model, "gpt-6-luna");
  const accounts = { ...f, catalog: f.catalog.filter(p => p.providerInstanceId === "claudeAgent").flatMap(p => [
    { ...p, providerInstanceId: "claude-a" }, { ...p, providerInstanceId: "claude-b" },
  ]), quota: { "claude-a": weekly(62), "claude-b": weekly(80) } };
  const account = recommend({ role: "bulk-read" }, accounts);
  assert.equal(account.providerInstanceId, "claude-b"); assert.equal(account.model, newcomer);
  for (const klass of ["tight", "stopped"] as const) assert.notEqual(recommend({ role: "bulk-read" }, {
    ...base, capacity: { ...base.capacity, codex: { ...credit, class: klass } },
  }).providerInstanceId, "codex");
  assert.equal(recommend({ role: "critical-review", authorProvider: "codex" }, base).providerInstanceId, "claudeAgent");
});
test("probation share survives process restart and produces one event per top change", async () => {
  const scratch = routeScratch();
  try {
    const path = join(scratch.path, "route.sqlite"), f = fixture();
    f.history.seen = {};
    let trials = 0;
    for (let i = 1; i <= 100; i++) {
      const state = new RouteState(path);
      const r = state.recommend({ role: "bulk-read" }, f, "omarchy-pc", true);
      if (r.model === newcomer) trials++;
      assert.ok(trials <= Math.floor(i * .10 + 1e-9), i + " calls");
      assert.equal(state.pending(), 1);
      state.close();
    }
    assert.equal(trials, 10);
    const state = new RouteState(path), keys: string[] = [];
    const opts = { url: "https://akasha.fixture", token: async () => "fixture-token", fetch: async (_: any, init: any) => {
      keys.push(init.headers["Idempotency-Key"]);
      return new Response(JSON.stringify({ event_id: "a".repeat(64), state: "visible" }), { status: 201 });
    } };
    await state.flush({ ...opts, fetch: async (url, init) => { await opts.fetch(url, init); throw new Error("lost receipt"); } });
    assert.equal(state.pending(), 1);
    await state.flush(opts);
    assert.equal(state.pending(), 0); assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    state.recommend({ role: "bulk-read" }, { ...f, now: now + 8 * 86400000,
      analytics: { ...f.analytics, fetchedAt: iso(now + 8 * 86400000), sourceFetchedAt: iso(now + 8 * 86400000), endExclusive: iso(now + 8 * 86400000) } }, "omarchy-pc", true);
    assert.equal(state.pending(), 0);
    state.close();
  } finally { scratch.remove(); }
});
test("explicit effort overrides use mapped anchors or safe pairs and keep their own incumbent", () => {
  const f = fixture();
  for (const effortOverride of ["low", "high", "xhigh"] as const) {
    const r = recommend({ role: "bulk-read", effortOverride }, f);
    assert.equal(r.model, "claude-haiku-5-5"); assert.equal(r.options.effort, effortOverride);
    assert.match(r.reasons.join(" "), /no mapped role anchors/);
  }
  f.history.picks["bulk-read:medium"] = { model: newcomer, providerInstanceId: "claudeAgent", options: { effort: "medium" } };
  f.analytics.models[newcomer] = stats(20);
  assert.equal(recommend({ role: "bulk-read", effortOverride: "medium" }, f).model, newcomer);
});

test("recreated route databases cannot reuse old transition publication keys", async () => {
  const scratch = routeScratch();
  try {
    const keys: string[] = [];
    for (const name of ["lost.sqlite", "recreated.sqlite"]) {
      const state = new RouteState(join(scratch.path, name));
      state.recommend({ role: "bulk-read" }, fixture(), "omarchy-pc", true);
      await state.flush({ url: "https://akasha.fixture", token: async () => "fixture-token", fetch: async (_, init) => {
        keys.push((init!.headers as Record<string,string>)["Idempotency-Key"]!);
        return new Response(JSON.stringify({ state: "visible", event_id: "a".repeat(64) }), { status: 201 });
      } });
      state.close();
    }
    assert.notEqual(keys[0], keys[1]);
  } finally { scratch.remove(); }
});

test("model selection is not limited to the old two drivers", () => {
  const f = fixture();
  const candidate = f.catalog.find(p => p.providerInstanceId === "claudeAgent")!;
  f.catalog = [{ ...candidate, providerInstanceId: "other-instance", driverKind: "opencode",
    models: candidate.models.filter(m => m.id === newcomer).map(m => ({ ...m,
      options: [{ id: "variant", type: "select", options: [{ id: "medium" }] }] })) }];
  assert.equal(recommend({ role: "bulk-read" }, f).providerInstanceId, "other-instance");
});
test("config validates probation, floors, pins and authenticated score transport", () => {
  const scratch = routeScratch();
  try {
    const path = join(scratch.path, "route.json");
    for (const value of [{ probationShare: 2 }, { probationMs: 0 }, { floors: { other: 30 } },
      { floors: { builder: NaN } }, { pins: { builder: { model: 2 } } }, { bans: ["("] },
      { scores: { enabled: true, url: "http://unsafe", tokenHelper: "/helper" } }]) {
      writeFileSync(path, JSON.stringify(value)); assert.throws(() => loadRouteConfig(scratch.path, path));
    }
    writeFileSync(path, JSON.stringify({ probationShare: .2, minimumTurns: 20, probationMs: 60000,
      failureMargin: .05, floors: { "bulk-read": 32 }, pins: { builder: { model: "new-model" } } }));
    const c = loadRouteConfig(scratch.path, path);
    assert.equal(c.floors["bulk-read"], 32); assert.equal(c.floors.builder, 50); assert.equal(c.probationShare, .2);
  } finally { scratch.remove(); }
});
