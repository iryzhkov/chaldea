import assert from "node:assert/strict";
import { test } from "node:test";
import { recommend } from "../../src/route/policy.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import { newProvider } from "../../src/quota/headroom.ts";
import { PAIRS, routeInput } from "../../src/route/types.ts";
import type { Analytics, Quota } from "../../src/route/types.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { liveReportDates } from "../fixtures/route/live-policy.ts";
const weekly = (remainingPercent: number, timeLeft = 0.4): Quota => ({
  observedAt: iso(now), activeStop: false,
  windows: [{ kind: "weekly", remainingPercent, windowDurationMins: 10080, resetsAt: iso(now + timeLeft * 7 * 86400000) }],
});
const base = { catalog, now, quota: {}, analytics: null };
const stats = (completed: number, failed: number, interrupted: number, minutesPerTurn = 2) => ({
  turns: completed + failed + interrupted, completionRate: completed / (completed + failed + interrupted),
  failedRate: failed / (completed + failed + interrupted), interruptedRate: interrupted / (completed + failed + interrupted), minutesPerTurn,
});
const analytics = (claude = stats(95, 3, 2), codex = stats(95, 3, 2)): Analytics => ({
  fetchedAt: iso(now), sourceFetchedAt: iso(now), endExclusive: iso(now - 3600000),
  models: { "claude-opus-5-5": claude, "gpt-6.1-sol": codex },
});
test("18-instance catalog uses safe fallback pairs/options including Haiku", () => {
  assert.equal(catalog.length, 18);
  for (const role of Object.keys(PAIRS) as Array<keyof typeof PAIRS>) {
    const r = recommend({ role }, base);
    assert.equal(r.providerInstanceId, "claudeAgent");
    assert.equal(r.model, PAIRS[role][0]);
    assert.deepEqual(r.options, { effort: role === "builder" ? "high" : "medium" });
    assert.equal(r.alternatives[0]?.model, PAIRS[role][1]);
    assert.deepEqual(r.alternatives[0]?.options, { reasoningEffort: role === "builder" ? "high" : "medium" });
    assert.notEqual(r.model, "claude-sonnet-5-5");
  }
});
test("Claude under-paced by >=10 points wins; otherwise Codex", () => {
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: weekly(62) } }).model, "claude-opus-5-5");
  const r = recommend({ role: "builder" }, { ...base, quota: { claudeAgent: weekly(49) } });
  assert.equal(r.model, "gpt-6.1-sol");
  assert.match(r.reasons.join(" "), /not assumed unlimited/);
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: weekly(49) }, config: { paceMargin: .05 } }).model, "claude-opus-5-5");
});
test("all windows gate low quota, threshold configurable and exact 10% allowed", () => {
  const q = weekly(62); q.windows = [...q.windows, { kind: "session", remainingPercent: 9, windowDurationMins: 300, resetsAt: null }];
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q } }).model, "gpt-6.1-sol");
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q }, config: { minimumRemaining: .05 } }).model, "claude-opus-5-5");
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: weekly(10, .001) }, config: { paceMargin: .05 } }).model, "claude-opus-5-5");
});
test("short windows only push away, including with unlimited credit capacity", () => {
  const short = (left: number) => ({ kind: "session", remainingPercent: left, windowDurationMins: 300, resetsAt: iso(now + 600000) });
  const q = weekly(40);
  q.windows = [...q.windows, short(35)];
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q } }).providerInstanceId, "codex");
  q.windows = [...weekly(62).windows, short(5)];
  const r = recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q } });
  assert.equal(r.providerInstanceId, "codex");
  assert.match(r.reasons.join("; "), /weekly 62% left with 40%.*5h window 5%.*tight/);
  const capacity = { ...classifyCapacity(newProvider("codex", "codex"), false, now), class: "unlimited" as const };
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { codex: q }, capacity: { codex: capacity } }).providerInstanceId, "claudeAgent");
  q.windows = [short(80)];
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q } }).providerInstanceId, "claudeAgent");
});
test("active stop overrides unknown/fresh windows, both blocked refuses", () => {
  const q = { ...weekly(62), activeStop: true };
  assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q } }).providerInstanceId, "codex");
  assert.throws(() => recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q, codex: q } }), /No eligible/);
});
test("reviews must cross author provider even when quota/default prefer author", () => {
  for (const authorProvider of ["codex", "claudeAgent"] as const) {
    const r = recommend({ role: "critical-review", authorProvider }, { ...base, quota: { claudeAgent: weekly(62) } });
    assert.notEqual(r.providerInstanceId, authorProvider);
    assert.equal(r.alternatives.length, 0);
  }
  assert.throws(() => recommend({ role: "critical-review", authorProvider: "codex" },
    { ...base, quota: { claudeAgent: { ...weekly(62), activeStop: true } } }), /No eligible/);
});
test("missing effort/model/canRun never invents catalog choices; custom instance IDs preserved", () => {
  const custom = catalog.filter(p => p.providerInstanceId === "codex").map(p => ({ ...p, providerInstanceId: "codex-custom" }));
  assert.equal(recommend({ role: "builder" }, { ...base, catalog: custom }).providerInstanceId, "codex-custom");
  assert.throws(() => recommend({ role: "builder" }, { ...base, catalog: custom.map(p => ({ ...p, models: [] })) }), /No eligible/);
  assert.throws(() => recommend({ role: "builder", effortOverride: "xhigh" }, { ...base, catalog: custom.map(p => ({
    ...p, models: p.models.map(m => ({ ...m, options: [] })),
  })) }), /No eligible/);
});
test("safe overrides only; forbidden efforts rejected even when catalog offers them", () => {
  for (const effortOverride of ["low", "medium", "high", "xhigh"] as const)
    assert.equal(recommend({ role: "general", effortOverride }, base).options.effort, effortOverride);
  for (const effortOverride of ["max", "ultra", "ultrathink", "ultracode", "HIGH"])
    assert.throws(() => routeInput({ role: "builder", effortOverride }), /Invalid route/);
  assert.throws(() => routeInput({ role: "haiku" }), /Invalid route/);
});
test("stale/future quota and reset windows degrade to role default, unknown stays explicit", () => {
  for (const q of [
    { ...weekly(5), observedAt: iso(now - 16 * 60000) },
    { ...weekly(5), observedAt: iso(now + 1) },
    { ...weekly(5), windows: [{ ...weekly(5).windows[0]!, resetsAt: iso(now - 1) }] },
  ]) assert.equal(recommend({ role: "builder" }, { ...base, quota: { claudeAgent: q } }).model, "claude-opus-5-5");
  assert.match(recommend({ role: "builder" }, base).reasons.join(" "), /Claude pacing unknown/);
});
test("Slopalytics failure+interrupt filter requires enough turns on both peers", () => {
  const bad = analytics(stats(75, 15, 10));
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: bad, quota: { claudeAgent: weekly(62) } }).model, "gpt-6.1-sol");
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: analytics(stats(15, 3, 2)) }).model, "claude-opus-5-5");
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: bad, config: { failureMargin: .3 } }).model, "gpt-6.1-sol"); // tie-break still favors completion
});
test("Slopalytics breaks unknown-pacing ties by completion then minutes, never overrides known pace", () => {
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: analytics(stats(94, 3, 3), stats(96, 2, 2)) }).model, "gpt-6.1-sol");
  const a = analytics(stats(95, 3, 2, 3), stats(95, 3, 2, 1));
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: a }).model, "gpt-6.1-sol");
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: a, quota: { claudeAgent: weekly(62) } }).model, "claude-opus-5-5");
});
test("unknown Claude capacity ties paced Codex and preserves every role default", () => {
  const unknown = classifyCapacity(newProvider("claudeAgent", "claudeAgent"), false, now);
  const paced = { ...unknown, class: "paced" as const, reasons: ["fixture paced"] };
  for (const role of Object.keys(PAIRS) as Array<keyof typeof PAIRS>) {
    const r = recommend({ role }, { ...base, quota: { codex: weekly(40) }, capacity: { claudeAgent: unknown, codex: paced } });
    assert.equal(r.providerInstanceId, "claudeAgent", role);
  }
});
test("statistics cannot remove the only eligible review or stopped-peer fallback", () => {
  const a = analytics(stats(75, 15, 10));
  a.models["claude-fable-5-1"] = stats(75, 15, 10);
  a.models["gpt-6-astra"] = stats(95, 3, 2);
  assert.equal(recommend({ role: "critical-review", authorProvider: "codex" },
    { ...base, analytics: a }).model, "claude-fable-5-1");
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: a,
    quota: { codex: { ...weekly(60), activeStop: true } } }).model, "claude-opus-5-5");
});
test("irregular live report stays usable for 21 days from endExclusive; bound configurable", () => {
  const a = { ...analytics(stats(75, 15, 10)), ...liveReportDates };
  const r = recommend({ role: "builder" }, { ...base, analytics: a });
  assert.equal(r.model, "gpt-6.1-sol");
  assert.doesNotMatch(r.reasons.join(" "), /stale or unavailable/);
  assert.equal(r.dataAges.slopalyticsWindow, (now - Date.parse(a.endExclusive)) / 1000);
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: a,
    config: { analyticsMaxAgeMs: 7 * 86400000 } }).model, "claude-opus-5-5");
  const boundary = { ...a, endExclusive: iso(now - 21 * 86400000 + 1000) };
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: boundary }).model, "gpt-6.1-sol");
  boundary.endExclusive = iso(now - 21 * 86400000);
  assert.equal(recommend({ role: "builder" }, { ...base, analytics: boundary }).model, "claude-opus-5-5");
});
test("old window stays stale after retrieval; future or missing timestamps fall back", () => {
  for (const a of [
    { ...analytics(), endExclusive: iso(now - 22 * 86400000) },
    ...["endExclusive", "sourceFetchedAt", "fetchedAt"].flatMap(key =>
      [iso(now + 1000), ""].map(value => ({ ...analytics(), [key]: value }))),
  ]) {
    const r = recommend({ role: "builder" }, { ...base, analytics: a });
    assert.equal(r.model, "claude-opus-5-5"); assert.match(r.reasons.join(" "), /stale or unavailable/);
  }
});
