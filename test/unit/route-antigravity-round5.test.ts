import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { roleAnchors } from "../../src/route/targets.ts";
import { DEFAULT_POLICY } from "../../src/route/types.ts";
import { emptyState, loadState, saveState } from "../../src/quota/state.ts";
import { observeThread } from "../../src/quota/observer.ts";
import { classifyCapacities } from "../../src/quota/capacity.ts";
import { HeadroomMonitor, newProvider, validateHeadroom } from "../../src/quota/headroom.ts";
import { collectRouteContext } from "../../src/route/runtime.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { fixture, stats, newcomer, now, iso } from "../fixtures/route/targets.ts";
import { limited } from "../helpers/threads.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const A = "a".repeat(64), B = "b".repeat(64);
const option = (id: string) => [{ id, type: "select", options: [{ id: "medium" }] }];
const win = (left: number) => ({ id: "gemini-weekly", kind: "weekly", usedPercent: 100 - left, remainingPercent: left,
  windowDurationMins: 10080, resetsAt: iso(now + 86400000) });
const score = (model: string, cost: number) => ({ model, effort: "medium" as const, aaSlug: model,
  intelligence: 60, coding: 60, inputPrice: cost, outputPrice: cost, benchmarkCostUSDPerTask: cost });
const snapshot = (models: string[]) => ({ version: 2 as const, metric: "aa-intelligence-cost-per-task" as const,
  indexVersion: "5", fetchedAt: iso(now), unmapped: [], models: models.map((m, i) => score(m, i + 1)) });
const google = (alias = "ag", accountKey = A) => ({ providerInstanceId: alias, driverKind: "antigravity",
  accountKey, canRunChildTask: true, models: [{ id: "gemini-4-neon", options: option("thought_level") }] });
const provider = (accountKey: string, at: number, left: number): SwitchProvider => ({
  instanceId: "ag", driver: "antigravity", quotaAccountKey: accountKey, enabled: true, installed: true,
  status: "ready", auth: { status: "authenticated" }, models: [],
  usageLimits: { checkedAt: iso(at), credentialFingerprint: accountKey, windows: [win(left)] },
});
async function context(home: string, state: ReturnType<typeof emptyState>, at: number, catalog = [google()]) {
  const stateFile = join(home, "observer.json"), configPath = join(home, "route.json");
  saveState(stateFile, state, at);
  writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(home, "cache") }));
  const { data } = await collectRouteContext({ home, configPath, now: at, catalog: async () => catalog.map(p => {
    const row = state.headroom.providers.find(r => r.alias === p.providerInstanceId);
    return { ...p, usageLimits: { credentialFingerprint: p.accountKey, checkedAt: row?.included.observedAt ?? iso(at - 500),
      windows: (row?.included.value ?? [win(80)]).map(w => ({ id: w.id, kind: w.kind, usedPercent: w.usedPercent,
        ...(w.windowDurationMins !== null ? { windowDurationMins: w.windowDurationMins } : {}),
        ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) })) } };
  }),
    fetcher: async () => { throw new Error("fixture offline"); } });
  return { ...data, scores: snapshot(["gemini-4-neon"]), config: { ...data.config, benchmark: { indexVersion: "5" } } };
}

test("S5-3a: an operator's custom native benchmark anchor needs no MODEL_MAP entry", () => {
  const f = fixture();
  const data: PolicyData = { ...f, analytics: null,
    catalog: [
      { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
        models: [{ id: "gpt-6.1-sol", options: option("reasoningEffort") }] },
      { providerInstanceId: "claudeAgent", driverKind: "claudeAgent", canRunChildTask: true,
        models: [{ id: newcomer, options: option("effort") }] },
    ],
    scores: snapshot(["gpt-6.1-sol", newcomer]),
    config: { benchmark: { indexVersion: "5", anchors: { general: [newcomer] } } },
  };
  assert.ok(roleAnchors("general", { ...DEFAULT_POLICY, ...data.config }, "claudeAgent").includes(newcomer));
  assert.equal(recommend({ role: "general" }, data).providerInstanceId, "claudeAgent");
});

test("S5-3b: an Antigravity-only allowlist cannot exempt native Terra from primary trial accounting", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path);
  try {
    const models = ["gpt-6.1-sol", "gpt-6.1-terra"];
    const f = fixture(), scores = snapshot(models);
    scores.models[1]!.benchmarkCostUSDPerTask = .1;
    const data: PolicyData = { ...f, scores,
      catalog: [{ providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
        models: models.map(id => ({ id, options: option("reasoningEffort") })) }],
      config: { benchmark: { indexVersion: "5" }, driverModels: { antigravity: ["gpt-6.1-terra"] } },
      analytics: { ...f.analytics, models: Object.fromEntries(models.map(m => [m, stats()])) },
    };
    assert.ok(!roleAnchors("general", { ...DEFAULT_POLICY, ...data.config }).includes("gpt-6.1-terra"));
    assert.ok(roleAnchors("general", { ...DEFAULT_POLICY, ...data.config }, "antigravity").includes("gpt-6.1-terra"));
    let trials = 0;
    for (let i = 0; i < 12; i++) trials += Number(routing.recommend({ role: "general" }, data, "fixture", false).model === "gpt-6.1-terra");
    assert.equal(trials, 1);
    const db = new DatabaseSync(path);
    const h = JSON.parse(String(db.prepare("SELECT value FROM history WHERE role=?").get("general:benchmark:5")!.value));
    db.close();
    assert.deepEqual(h.allocations["gpt-6.1-terra"], { calls: 12, trials: 1 });
  } finally { routing.close(); d.remove(); }
});

test("S5-1: upgrade/unknown login holds are inadmissible and expose a clear routing reason", async () => {
  const d = routeScratch(), state = emptyState();
  let clock = now;
  const row = newProvider("ag", "antigravity"); row.accountKey = A;
  row.included = { state: "fresh", source: "t3", value: [win(80)], observedAt: iso(now - 1000), error: null };
  state.headroom.providers.push(row);
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, save: () => {}, now: () => clock });
  try {
    let data = await context(d.path, state, clock);
    assert.equal(data.catalog[0]?.canRunChildTask, false);
    assert.throws(() => recommend({ role: "general" }, data), /Antigravity held.*no saved verified context/);
    monitor.update([provider(A, now - 1000, 80)]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, false);
    data = await context(d.path, state, clock);
    assert.throws(() => recommend({ role: "general" }, data), /snapshot newer than/);
    clock += 10;
    monitor.update([provider(A, now + 5, 80)]);
    data = await context(d.path, state, clock);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
  } finally { await monitor.close(); d.remove(); }
});

test("S5-1: A to B to A never restores old snapshots and each verified context requires a newer observation", async () => {
  const d = routeScratch(), state = emptyState();
  let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, save: () => {}, now: () => clock });
  try {
    monitor.update([provider(A, clock - 1, 0)]);
    clock += 10; monitor.update([provider(A, clock - 1, 0)]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, true);
    let data = await context(d.path, state, clock);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    clock += 10; monitor.update([provider(B, now + 9, 80)]);
    data = await context(d.path, state, clock, [google("ag", B)]);
    assert.throws(() => recommend({ role: "general" }, data), /Antigravity held/);
    clock += 10; monitor.update([provider(B, clock - 1, 80)]);
    data = await context(d.path, state, clock, [google("ag", B)]);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
    clock += 10; monitor.update([provider(A, now + 9, 0)]);
    data = await context(d.path, state, clock);
    assert.throws(() => recommend({ role: "general" }, data), /Antigravity held/);
    clock += 10; monitor.update([provider(A, clock - 1, 80)]);
    data = await context(d.path, state, clock);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
  } finally { await monitor.close(); d.remove(); }
});

test("S5-1: same-login restart keeps admitted exhausted windows; alias re-addition without context is held", async () => {
  const d = routeScratch(), state = emptyState();
  let clock = now;
  const make = () => new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, save: () => {}, now: () => clock });
  let monitor = make();
  try {
    monitor.update([provider(A, now - 1, 0)]);
    clock += 10; const exhausted = provider(A, clock - 1, 0);
    monitor.update([exhausted]); await monitor.close();
    state.headroom = validateHeadroom(JSON.parse(JSON.stringify(state.headroom)));
    monitor = make(); monitor.update([exhausted]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, true);
    assert.equal(state.headroom.providers[0]?.included.value?.[0]?.remainingPercent, 0);
    let data = await context(d.path, state, clock);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    monitor.update([]); clock += 10; monitor.update([exhausted]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, false);
    data = await context(d.path, state, clock);
    assert.throws(() => recommend({ role: "general" }, data), /Antigravity held/);
  } finally { await monitor.close(); d.remove(); }
});

test("S5-2: delayed and legacy stops affect only their Antigravity alias, never peers on either login", async () => {
  const d = routeScratch(), state = emptyState();
  try {
    for (const [alias, accountKey] of [["ag", B], ["peer-b", B], ["peer-a", A]]) {
      const row = newProvider(alias!, "antigravity"); row.accountKey = accountKey!;
      row.antigravityContext = { identity: "c".repeat(64), fingerprint: createHash("sha256").update(accountKey!).digest("hex"), changedAt: iso(now - 2000), admitted: true };
      row.included = { state: "fresh", source: "t3", observedAt: iso(now - 500), value: [win(80)], error: null };
      state.headroom.providers.push(row);
    }
    const stop = { ...limited("delayed", now - 1000, null), providerInstanceId: "ag" };
    observeThread(state, stop, now);
    assert.equal(Object.hasOwn(state.parked.get(stop.id)!, "accountKey"), false);
    assert.equal(Object.hasOwn(state.parked.get(stop.id)!, "identityChecked"), false);
    const legacy = { ...state.parked.get(stop.id)!, driver: "antigravity", accountKey: A, identityChecked: true };
    state.parked.set(stop.id, legacy);
    const capacities = classifyCapacities(state, now);
    assert.equal(capacities.ag?.class, "stopped");
    assert.notEqual(capacities["peer-b"]?.class, "stopped"); assert.notEqual(capacities["peer-a"]?.class, "stopped");
    let data = await context(d.path, state, now, [google("ag", B)]);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    for (const peer of [google("peer-b", B), google("peer-a", A)]) {
      data = await context(d.path, state, now, [peer]);
      assert.equal(recommend({ role: "general" }, data).providerInstanceId, peer.providerInstanceId);
    }
    const loaded = loadState(join(d.path, "observer.json"), now);
    assert.equal(loaded.parked.get(stop.id)?.provider, "ag");
    observeThread(loaded, { ...stop, usageLimitResetAt: iso(now + 3600000) }, now + 1);
    assert.equal(Object.hasOwn(loaded.parked.get(stop.id)!, "accountKey"), false);
  } finally { d.remove(); }
});

test("S5-1: an unverified credential fingerprint cannot release the Antigravity hold", async () => {
  const state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, save: () => {}, now: () => clock });
  try {
    const p = provider(A, now - 1, 80);
    const noFingerprint: SwitchProvider = { ...p, usageLimits: { checkedAt: iso(now + 5), windows: [win(80)] } };
    monitor.update([noFingerprint]); clock += 10; monitor.update([noFingerprint]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, false);
    assert.match(state.headroom.providers[0]?.antigravityHold ?? "", /fingerprint/);
  } finally { await monitor.close(); }
});
