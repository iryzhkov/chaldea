import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { emptyHistory, historyModelKey } from "../../src/route/targets.ts";
import { emptyHeadroom, HeadroomMonitor, newProvider, validateHeadroom } from "../../src/quota/headroom.ts";
import { emptyState, loadState, saveState } from "../../src/quota/state.ts";
import { observeThread } from "../../src/quota/observer.ts";
import { collectRouteContext } from "../../src/route/runtime.ts";
import { classifyCapacities } from "../../src/quota/capacity.ts";
import { capacityKey } from "../../src/quota/account.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { fixture, now, iso, stats } from "../fixtures/route/targets.ts";
import { limited } from "../helpers/threads.ts";
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

test("R3-1: stale old-login observations stay fenced across repeated updates and monitor restart", async () => {
  const d = routeScratch(), path = join(d.path, "headroom.json");
  let state = emptyHeadroom();
  const makeMonitor = () => new HeadroomMonitor({ state, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, save: () => {}, now: () => now });
  let monitor = makeMonitor();
  const remaining = () => state.providers[0]!.included.value?.[0]?.remainingPercent;
  try {
    const a: SwitchProvider = { instanceId: "ag", driver: "antigravity", enabled: true, installed: true,
      auth: { status: "authenticated" }, status: "ready", models: [], quotaAccountKey: "a".repeat(64),
      usageLimits: { checkedAt: iso(now), credentialFingerprint: "fixture-a", windows: [window(10)] } };
    monitor.update([a]); assert.equal(remaining(), 10);
    const b = { ...a, quotaAccountKey: "b".repeat(64) };
    monitor.update([b]); monitor.update([b]);
    assert.equal(state.providers[0]!.included.value, null);
    assert.equal(state.providers[0]!.antigravityObservationFloor, iso(now));
    await monitor.close();
    writeFileSync(path, JSON.stringify(state));
    state = validateHeadroom(JSON.parse(readFileSync(path, "utf8")));
    monitor = makeMonitor(); monitor.update([b]); monitor.update([b]);
    assert.equal(state.providers[0]!.included.value, null);
    monitor.update([{ ...b, usageLimits: { ...b.usageLimits!, checkedAt: iso(now + 1), windows: [window(80)] } }]);
    assert.equal(remaining(), 80);
    monitor.update([b]);
    assert.equal(remaining(), 80);
    assert.throws(() => validateHeadroom({ ...state, providers: [{ ...state.providers[0], antigravityObservationFloor: "bad" }] }));
  } finally { await monitor.close(); d.remove(); }
});

test("R3-2: legacy stops migrate from the original disk binding even after catalog removal", async () => {
  const d = routeScratch();
  try {
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json"), accountKey = "a".repeat(64);
    const state = emptyState(), original = newProvider("a", "antigravity");
    original.accountKey = accountKey;
    original.included = { value: [window(80)], state: "fresh", source: "t3", observedAt: iso(now - 1000), error: null };
    state.headroom.providers.push(original);
    state.parked.set("legacy", { provider: "a", runId: "run", resetAt: null, stopAt: now, seenAt: now });
    saveState(stateFile, state, now);
    const loaded = loadState(stateFile, now);
    assert.equal(loaded.parked.get("legacy")?.accountKey, accountKey);
    assert.equal(loaded.parked.get("legacy")?.identityChecked, true);
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache") }));
    const opts = { home: d.path, configPath, now,
      catalog: async () => [{ providerInstanceId: "b", driverKind: "antigravity", accountKey, canRunChildTask: true, models: [] }],
      fetcher: async () => { throw new Error("offline fixture"); } };
    assert.equal((await collectRouteContext(opts)).data.capacity?.b?.class, "stopped");

    // An observation newer than the stop cannot establish the old login's identity.
    original.included = { ...original.included, observedAt: iso(now + 1) };
    saveState(stateFile, state, now);
    const unknown = loadState(stateFile, now);
    assert.equal(unknown.parked.get("legacy")?.accountKey, undefined);
    unknown.headroom.providers[0]!.included = { ...original.included, observedAt: iso(now - 1000) };
    saveState(stateFile, unknown, now);
    assert.equal(loadState(stateFile, now).parked.get("legacy")?.accountKey, undefined);
  } finally { d.remove(); }
});

test("R3-2: a saved stop propagates only to its saved account after the source instance logs in again", async () => {
  const d = routeScratch();
  try {
    const aKey = "a".repeat(64), bKey = "b".repeat(64), state = emptyState();
    const source = newProvider("a", "antigravity"); source.accountKey = aKey;
    state.headroom.providers.push(source);
    observeThread(state, { ...limited("run", now, null), providerInstanceId: "a" }, now);
    source.accountKey = bKey;
    const oldPeer = newProvider("old-peer", "antigravity"); oldPeer.accountKey = aKey;
    const newPeer = newProvider("new-peer", "antigravity"); newPeer.accountKey = bKey;
    state.headroom.providers.push(oldPeer, newPeer);
    const capacities = classifyCapacities(state, now);
    assert.equal(capacities[capacityKey("antigravity", aKey)]?.class, "stopped");
    assert.equal(capacities[capacityKey("antigravity", bKey)]?.class, "unknown");
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
    saveState(stateFile, state, now);
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache") }));
    const context = await collectRouteContext({ home: d.path, configPath, now,
      catalog: async () => state.headroom.providers.map(p => ({ providerInstanceId: p.alias, driverKind: p.driver,
        accountKey: p.accountKey!, canRunChildTask: true, models: [] })),
      fetcher: async () => { throw new Error("offline fixture"); } });
    assert.equal(context.data.capacity?.["old-peer"]?.class, "stopped");
    assert.equal(context.data.capacity?.["new-peer"]?.class, "unknown");
  } finally { d.remove(); }
});

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
