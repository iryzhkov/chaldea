import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { routeCatalog, collectRouteContext } from "../../src/route/runtime.ts";
import { HeadroomMonitor, validateHeadroom } from "../../src/quota/headroom.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { fixture, stats, now, iso } from "../fixtures/route/targets.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const A = "a".repeat(64), B = "b".repeat(64), terra = "gpt-6.1-terra";
const options = (id: string) => [{ id, type: "select", options: [{ id: "medium" }] }];
const win = (left: number) => ({ id: "gemini-weekly", kind: "weekly", usedPercent: 100 - left,
  remainingPercent: left, windowDurationMins: 10080, resetsAt: iso(now + 86400000) });
const live = (fingerprint: string, at: number, left: number): SwitchProvider => ({
  instanceId: "ag", driver: "antigravity", enabled: true, installed: true, status: "ready",
  auth: { status: "authenticated" }, models: [{ slug: "gemini-4-neon",
    capabilities: { optionDescriptors: options("thought_level") } }],
  usageLimits: { credentialFingerprint: fingerprint, checkedAt: iso(at), windows: [win(left)] },
});
const scores = (models: string[]) => ({ version: 2 as const, metric: "aa-intelligence-cost-per-task" as const,
  indexVersion: "5", fetchedAt: iso(now), unmapped: [], models: models.map((model, i) => ({
    model, effort: "medium" as const, aaSlug: model, intelligence: 60, coding: 60, inputPrice: 1,
    outputPrice: 1, benchmarkCostUSDPerTask: 2 - i * .5,
  })) });
async function context(home: string, state: ReturnType<typeof emptyState>, p: SwitchProvider, at: number) {
  const stateFile = join(home, "observer.json"), configPath = join(home, "route.json");
  saveState(stateFile, state, at);
  writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(home, "cache") }));
  const before = readFileSync(stateFile, "utf8");
  const { data } = await collectRouteContext({ home, configPath, now: at, catalog: async () => routeCatalog([p]),
    fetcher: async () => { throw new Error("fixture offline"); } });
  assert.equal(readFileSync(stateFile, "utf8"), before, "routing must not rewrite observer state");
  return { ...data, scores: scores(["gemini-4-neon"]), config: { ...data.config, benchmark: { indexVersion: "5" } } };
}
const history = (path: string, key = "general:benchmark:5") => {
  const db = new DatabaseSync(path);
  try { return JSON.parse(String(db.prepare("SELECT value FROM history WHERE role=?").get(key)!.value)); }
  finally { db.close(); }
};

test("R6-1: live fingerprints and windows override saved admission and cached headroom", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(A, clock - 1, 80)]);
    clock += 10; const admitted = live(A, clock - 1, 80); monitor.update([admitted]);
    assert.equal(recommend({ role: "general" }, await context(d.path, state, admitted, clock)).providerInstanceId, "ag");
    clock += 10;
    const changed = await context(d.path, state, live(B, clock - 1, 0), clock);
    assert.throws(() => recommend({ role: "general" }, changed), /live credential fingerprint differs/);
    const exhausted = await context(d.path, state, live(A, clock - 1, 0), clock);
    assert.equal(exhausted.quota.ag?.windows[0]?.remainingPercent, 0);
    assert.throws(() => recommend({ role: "general" }, exhausted), /No eligible/);
    assert.equal(state.headroom.providers[0]?.included.value?.[0]?.remainingPercent, 80);
  } finally { await monitor.close(); d.remove(); }
});

test("R6-1: missing, empty, unsupported and failed live usage never admit an otherwise saved login", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(A, clock - 1, 80)]); clock += 10; monitor.update([live(A, clock - 1, 80)]);
    clock += 10;
    const p = live(A, clock - 1, 80), u = p.usageLimits!;
    const { credentialFingerprint: _fingerprint, ...noFingerprint } = u;
    const { usageLimits: _usage, ...withoutUsage } = p;
    const cases = [undefined, noFingerprint, { ...u, windows: [] },
      ...["unsupported", "probeFailed"].map(reason => ({ ...u, unavailable: { reason } })),
      { ...u, checkedAt: iso(clock + 1) }, { ...u, windows: [{ ...win(80), usedPercent: NaN }] }];
    for (const usageLimits of cases) {
      const data = await context(d.path, state, { ...withoutUsage, ...(usageLimits ? { usageLimits } : {}) }, clock);
      assert.equal(data.catalog[0]?.canRunChildTask, false);
      assert.throws(() => recommend({ role: "general" }, data), /Antigravity held/);
    }
  } finally { await monitor.close(); d.remove(); }
});

test("R6-1: only newer usable fingerprint-attributed windows release the observer hold", async () => {
  const state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(A, clock - 1, 80)]);
    for (const unavailable of [{ reason: "unsupported" }, { reason: "probeFailed" }]) {
      clock += 10;
      const p = live(A, clock - 1, 80);
      monitor.update([{ ...p, usageLimits: { ...p.usageLimits!, unavailable } }]);
      assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, false);
      assert.match(state.headroom.providers[0]?.antigravityHold ?? "", /no usable T3 usage windows/);
    }
    clock += 10; const p = live(A, clock - 1, 80);
    monitor.update([{ ...p, usageLimits: { ...p.usageLimits!, windows: [] } }]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, false);
    monitor.update([p]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, true);
    assert.ok(state.headroom.providers[0]?.antigravityContext?.fingerprint);
    Object.assign(state.headroom, validateHeadroom(JSON.parse(JSON.stringify(state.headroom))));
    delete state.headroom.providers[0]!.antigravityContext!.fingerprint;
    clock += 10; monitor.update([p]);
    assert.equal(state.headroom.providers[0]?.antigravityContext?.admitted, false, "old-format admission requires fresh data");
  } finally { await monitor.close(); }
});

function duplicateData(): PolicyData {
  const f = fixture(), models = ["gpt-6.1-sol", terra];
  return { ...f, scores: scores(models),
    catalog: [
      { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
        models: models.map(id => ({ id, options: options("reasoningEffort") })) },
      { providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true,
        models: [{ id: terra, options: options("thought_level") }] },
    ],
    config: { benchmark: { indexVersion: "5" }, driverModels: { antigravity: [terra] } },
    analytics: { ...f.analytics, models: Object.fromEntries(models.map(m => [m, stats()])) },
  };
}

test("R6-2: allowlisted Antigravity Terra exposures never spend native Terra trials", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path);
  try {
    const data = duplicateData(); let trials = 0, alternatives = 0;
    for (let i = 0; i < 12; i++) {
      const pick = routing.recommend({ role: "general" }, data, "fixture", false);
      assert.equal(pick.providerInstanceId, "codex");
      trials += Number(pick.model === terra);
      alternatives += Number(pick.byProvider.antigravity?.eligible && pick.byProvider.antigravity.model === terra);
    }
    assert.equal(trials, 1); assert.equal(alternatives, 12);
    const h = history(path);
    assert.deepEqual(h.allocations[terra], { calls: 12, trials: 1 });
    assert.deepEqual(h.allocations["antigravity:" + terra], { calls: 0, trials: 0 });
    assert.equal(h.seen["antigravity:" + terra], now);
  } finally { routing.close(); d.remove(); }
});

test("R6-2: Antigravity-only activity preserves primary counters and discards new primary first-seen probes", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path);
  try {
    const data = duplicateData();
    routing.recommend({ role: "general" }, data, "fixture", false);
    const before = history(path);
    data.catalog = data.catalog.map(p => p.driverKind === "codex" ? { ...p,
      models: [...p.models, { id: "new-native-probe", options: options("reasoningEffort") }] } : p);
    data.quota = { codex: { observedAt: iso(now), windows: [], activeStop: true } };
    assert.equal(routing.recommend({ role: "general" }, data, "fixture", false).providerInstanceId, "ag");
    const after = history(path);
    for (const key of ["gpt-6.1-sol", terra]) assert.deepEqual(after.allocations[key], before.allocations[key]);
    assert.equal(after.seen["new-native-probe"], undefined);
    assert.equal(after.allocations["new-native-probe"], undefined);
  } finally { routing.close(); d.remove(); }
});

test("R6-2: Antigravity review accounting layers onto independent primary slots", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite"), routing = new RouteState(path);
  try {
    const data = duplicateData();
    data.config = { ...data.config, providerPreference: ["antigravity"] };
    const pair = routing.reviewPair({ authorProvider: "claudeAgent", mainRole: "general", peerRole: "general" }, data);
    assert.equal(pair.status, "complete"); assert.equal(pair.main?.providerInstanceId, "ag");
    const h = history(path, "general:claudeAgent:benchmark:5");
    assert.ok(Object.keys(h.seen).length);
    const baseline = new RouteState(join(d.path, "native.sqlite"));
    try {
      baseline.reviewPair({ authorProvider: "claudeAgent", mainRole: "general", peerRole: "general" },
        { ...data, catalog: data.catalog.filter(p => p.driverKind !== "antigravity") });
      const expected = history(join(d.path, "native.sqlite"), "general:claudeAgent:benchmark:5");
      for (const field of ["seen", "allocations"]) assert.deepEqual(
        Object.fromEntries(Object.entries(h[field]).filter(([k]) => !k.startsWith("antigravity:"))), expected[field]);
    } finally { baseline.close(); }
    assert.ok(Object.hasOwn(h.seen, "antigravity:" + terra));
  } finally { routing.close(); d.remove(); }
});
