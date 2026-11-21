import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { mergeAntigravityWindows, antigravityExhaustion } from "../../src/quota/window-policy.ts";
import { recommend, type PolicyData } from "../../src/route/policy.ts";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { routeCatalog, collectRouteContext } from "../../src/route/runtime.ts";
import { HeadroomMonitor, validateHeadroom } from "../../src/quota/headroom.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { exercisePrimaryEquivalence, invariantFixture, primarySnapshot } from "../fixtures/route/invariants.ts";
import { now, iso } from "../fixtures/route/targets.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const A = "a".repeat(64);
const option = [{ id: "thought_level", type: "select", options: [{ id: "medium" }] }];
const window = (left: number, id = "gemini-weekly", reset = now + 86400000) => ({
  id, kind: "weekly", usedPercent: 100 - left, remainingPercent: left, windowDurationMins: 10080, resetsAt: iso(reset),
});
const live = (at: number, left: number, quotaAccountKey?: string): SwitchProvider => ({
  instanceId: "ag", driver: "antigravity", enabled: true, installed: true, status: "ready", auth: { status: "authenticated" },
  ...(quotaAccountKey ? { quotaAccountKey } : {}),
  models: [{ slug: "gemini-4-neon", capabilities: { optionDescriptors: option } }],
  usageLimits: { credentialFingerprint: A, checkedAt: iso(at), windows: [window(left)] },
});
async function context(home: string, state: ReturnType<typeof emptyState>, p: SwitchProvider, at: number) {
  const stateFile = join(home, "observer.json"), configPath = join(home, "route.json");
  saveState(stateFile, state, at);
  writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(home, "cache") }));
  const { data } = await collectRouteContext({ home, configPath, now: at, catalog: async () => routeCatalog([p]),
    fetcher: async () => { throw new Error("fixture offline"); } });
  return { ...data, scores: invariantFixture(at).scores!, config: { ...data.config, benchmark: { indexVersion: "5" } } };
}

test("P: generated route and review sequences preserve the primary-only state after every call", () => {
  const d = routeScratch();
  try { assert.equal(exercisePrimaryEquivalence(RouteState, RouteState, d.path), 256); }
  finally { d.remove(); }
});

test("Sol incumbent: a preferred Antigravity winner cannot prevent settled native Terra becoming incumbent", () => {
  const d = routeScratch(), hp = join(d.path, "head.sqlite"), mp = join(d.path, "native.sqlite");
  const head = new RouteState(hp), native = new RouteState(mp);
  try {
    for (let step = 0; step < 3; step++) {
      const at = now + (step ? 8 * 86400000 + step : 0);
      const data = invariantFixture(at);
      data.catalog = data.catalog.filter(p => p.driverKind !== "claudeAgent" && (step === 1 || p.driverKind !== "antigravity"))
        .map(p => p.driverKind === "antigravity" ? { ...p, models: p.models.filter(m => m.id === "gemini-4-neon") } : p);
      data.config = { ...data.config, driverModels: { antigravity: ["gemini-4-neon"] }, providerPreference: ["antigravity"] };
      if (step === 2) data.analytics = null;
      const expected = native.recommend({ role: "general" }, { ...data, catalog: data.catalog.filter(p => p.driverKind !== "antigravity") }, "fixture", false);
      const actual = head.recommend({ role: "general" }, data, "fixture", false);
      assert.deepEqual(primarySnapshot(hp), primarySnapshot(mp));
      if (step === 1) { assert.equal(actual.providerInstanceId, "ag"); assert.equal(expected.model, "gpt-6.1-terra"); }
      if (step === 2) assert.equal(actual.model, "gpt-6.1-terra");
    }
    const db = new DatabaseSync(hp);
    const history = JSON.parse(String(db.prepare("SELECT value FROM history WHERE role=?").get("general:benchmark:5")!.value));
    db.close();
    assert.equal(history.picks["general:benchmark:5"].model, "gpt-6.1-terra");
  } finally { head.close(); native.close(); d.remove(); }
});

test("Sol verify7: adding an account key or aging the observation cannot erase live Antigravity exhaustion", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(clock - 1, 80)]); clock += 10; monitor.update([live(clock - 1, 80)]);
    clock += 10;
    for (const account of [undefined, A]) for (const age of [0, 2 * 3600000]) {
      const data = await context(d.path, state, live(clock - 1, 0, account), clock + age);
      assert.equal(data.quota.ag?.windows[0]?.remainingPercent, 0);
      assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    }
  } finally { await monitor.close(); d.remove(); }
});

test("Q: family exhaustion is independent of freshness, credit reserves and threshold, until reset", () => {
  const models = ["gemini-4-neon", "gemini-4-argon", "claude-opus-5-5", "gpt-6.1-terra"];
  const ids = ["weekly", "gemini-weekly", "3p-weekly", "gemini-argon-wtu-weekly", "gemini-new", "3p-new"];
  let cases = 0;
  for (const model of models) for (const id of ids) for (const left of [0, 9, 10, 24, 25, 80])
  for (const minimum of [.1, .25]) for (const age of [0, 2 * 3600000]) for (const expired of [false, true]) {
    const data: PolicyData = invariantFixture(now + age);
    data.catalog = [{ providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true, models: [{ id: model, options: option }] }];
    data.config = { ...data.config, minimumRemaining: minimum, driverModels: { antigravity: [model] } };
    data.scores = { ...data.scores!, models: [{ model, effort: "medium", aaSlug: model, intelligence: 60,
      coding: 60, inputPrice: 1, outputPrice: 1, benchmarkCostUSDPerTask: 1 }] };
    data.quota = { ag: { observedAt: iso(now), activeStop: false,
      windows: [window(left, id, expired ? now - 1 : now + 86400000)] } };
    data.capacity = { ag: { class: "unlimited", reasons: [], remainingFraction: null, reserveWeeks: 2,
      observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: iso(now), creditFunded: true } };
    const applies = id === "weekly" || (id === "gemini-argon-wtu-weekly" ? model === "gemini-4-argon"
      : id.startsWith("gemini-") ? model.startsWith("gemini-") : /^(claude-|gpt-)/.test(model));
    if (applies && !expired && left / 100 < minimum) assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    else assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
    cases++;
  }
  assert.equal(cases, 1152);
});

test("Q: omissions, failures, replay and restart retain exhaustion; newer attributed recovery or reset clears it", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const make = () => new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  let monitor = make();
  try {
    monitor.update([live(clock - 1, 80)]); clock += 10; monitor.update([live(clock - 1, 0)]);
    clock += 10;
    const failed = { ...live(clock - 1, 80), usageLimits: { ...live(clock - 1, 80).usageLimits!, windows: [], unavailable: { reason: "probeFailed" } } };
    monitor.update([failed]);
    assert.equal(state.headroom.providers[0]?.included.value?.[0]?.remainingPercent, 0);
    const held = await context(d.path, state, failed, clock);
    assert.throws(() => recommend({ role: "general" }, held), /Antigravity held/);
    clock += 10;
    const unrelated = { ...live(clock - 1, 80), usageLimits: { ...live(clock - 1, 80).usageLimits!, windows: [window(80, "3p-weekly")] } };
    monitor.update([unrelated]);
    let data = await context(d.path, state, unrelated, clock);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    const replay = live(now + 9, 80); monitor.update([replay]);
    data = await context(d.path, state, replay, clock);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    await monitor.close();
    Object.assign(state.headroom, validateHeadroom(JSON.parse(JSON.stringify(state.headroom))));
    monitor = make(); monitor.update([unrelated]);
    data = await context(d.path, state, unrelated, clock);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
    clock += 10; const recovered = live(clock - 1, 80); monitor.update([recovered]);
    data = await context(d.path, state, recovered, clock);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
    clock += 10; monitor.update([live(clock - 1, 0)]);
    clock = now + 86400001;
    const reset = { ...live(clock - 1, 80), usageLimits: { ...live(clock - 1, 80).usageLimits!,
      windows: [window(80, "3p-weekly", clock + 86400000)] } };
    monitor.update([reset]); data = await context(d.path, state, reset, clock);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
  } finally { await monitor.close(); d.remove(); }
});

test("Q: exhaustion beyond the standard metric inventory remains binding without breaking main's format", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(clock - 1, 80)]); clock += 10;
    const p = { ...live(clock - 1, 80), usageLimits: { ...live(clock - 1, 80).usageLimits!,
      windows: Array.from({ length: 33 }, (_, i) => window(i === 32 ? 0 : 80, i ? "gemini-extra-" + i : "gemini-weekly")) } };
    monitor.update([p]);
    assert.equal(state.headroom.providers[0]?.included.value?.length, 32);
    assert.equal(state.headroom.providers[0]?.antigravityWindows?.length, 33);
    const data = await context(d.path, state, p, clock);
    assert.equal(data.quota.ag?.windows.length, 33);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/);
  } finally { await monitor.close(); d.remove(); }
});

test("Q: retained healthy windows cannot establish fresh pacing when the live snapshot omits them", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(clock - 1, 80)]); clock += 10; monitor.update([live(clock - 1, 80)]);
    clock += 10;
    const p = { ...live(clock - 1, 80), usageLimits: { ...live(clock - 1, 80).usageLimits!, windows: [window(80, "3p-weekly")] } };
    monitor.update([p]);
    const data = await context(d.path, state, p, clock);
    assert.deepEqual(data.quota.ag?.windows.map(w => w.id), ["3p-weekly"]);
    assert.ok(data.quota.ag?.knownWindows?.some(w => w.id === "gemini-weekly"));
    const pick = recommend({ role: "general" }, data);
    assert.equal(pick.providerInstanceId, "ag");
    assert.equal(pick.diagnostics?.quota["ag:gemini-4-neon"]?.bindingWindow, null);
    assert.ok(pick.reasons.some(r => r.includes("quota pacing unknown")));
  } finally { await monitor.close(); d.remove(); }
});

test("Q: each window has its own recovery clock, independent of updates and replays in other families", async () => {
  const d = routeScratch(), state = emptyState(); let clock = now;
  const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
    local: true, now: () => clock, save: () => {} });
  try {
    monitor.update([live(clock - 1, 80)]); clock += 10; monitor.update([live(clock - 1, 0)]);
    clock += 20;
    const unrelated = { ...live(clock - 1, 80), usageLimits: { ...live(clock - 1, 80).usageLimits!, windows: [window(80, "3p-weekly")] } };
    monitor.update([unrelated]);
    const recovered = live(now + 19, 80); monitor.update([recovered]);
    let data = await context(d.path, state, recovered, clock);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag");
    monitor.update([live(now + 14, 0)]);
    data = await context(d.path, state, unrelated, clock);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "ag", "old replay must not undo newer recovery");
    const newLimit = { ...live(now + 15, 80), usageLimits: { ...live(now + 15, 80).usageLimits!,
      windows: [window(0, "gemini-new-limit")] } };
    monitor.update([newLimit]);
    data = await context(d.path, state, unrelated, clock);
    assert.throws(() => recommend({ role: "general" }, data), /No eligible/, "an older newly learned limit still binds");
  } finally { await monitor.close(); d.remove(); }
});

test("Q: every threshold retains its original deadline until actual recovery, regardless of reset metadata changes", () => {
  let cases = 0;
  for (const previous of [0, 9, 24, 80]) for (const remaining of [0, 5, 9, 10, 25, 80])
  for (const floor of [.1, .25, .9]) for (const reset of [null, now - 1, now + 50, now + 200]) {
    const old = { ...window(previous, "gemini-weekly", now + 100), observedAt: iso(now - 10) };
    const next = { ...window(remaining), resetsAt: reset === null ? null : iso(reset) };
    const limits = mergeAntigravityWindows([old], [next], old.observedAt, iso(now - 1), now);
    if (previous / 100 < floor && remaining / 100 < floor)
      assert.ok(antigravityExhaustion(limits, "gemini-4-neon", now + 75, floor));
    if (remaining / 100 >= floor)
      assert.equal(antigravityExhaustion(limits, "gemini-4-neon", now + 75, floor), undefined);
    if (previous / 100 >= floor && (reset === null || reset <= now + 75))
      assert.equal(antigravityExhaustion(limits, "gemini-4-neon", now + 75, floor), undefined);
    cases++;
  }
  assert.equal(cases, 288);
});

test("Q: review pressure shares the age-independent family exhaustion rule without changing primary waivers", () => {
  for (const age of [0, 2 * 3600000]) {
    const data = invariantFixture();
    data.catalog = data.catalog.map(p => p.driverKind === "antigravity"
      ? { ...p, models: p.models.filter(m => m.id === "gemini-4-neon") } : p);
    data.config = { ...data.config, driverModels: { antigravity: ["gemini-4-neon"] },
      benchmark: { indexVersion: "5", anchors: { general: ["gpt-6.1-terra"] } } };
    data.quota = { claudeAgent: { observedAt: iso(now), activeStop: true, windows: [] },
      ag: { observedAt: iso(now - age), activeStop: false, windows: [window(80, "3p-weekly")],
        knownWindows: [window(0)] } };
    const input = { authorProvider: "codex" as const, mainRole: "general" as const,
      peerRole: "general" as const, allowQuotaException: true };
    const baseline = recommendReviewPair(input, { ...data, catalog: data.catalog.filter(p => p.driverKind !== "antigravity") });
    assert.equal(baseline.code, "quota_exception");
    assert.deepEqual(recommendReviewPair(input, data), baseline);
  }
});
