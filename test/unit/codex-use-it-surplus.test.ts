import assert from "node:assert/strict";
import { test } from "node:test";
import { newProvider } from "../../src/quota/headroom.ts";
import type { Metric, ProviderHeadroom, Window } from "../../src/quota/headroom.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import type { Capacity } from "../../src/quota/capacity.ts";
import { recommend } from "../../src/route/policy.ts";
import type { PolicyData } from "../../src/route/policy.ts";
import type { Role } from "../../src/route/types.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { liveCodex } from "../fixtures/route/live-policy.ts";

// Live omarchy-pc state on 2026-11-22, empty providerPreference: Codex weekly 93% left with 7% of
// the window left and a credit-funded lane; Claude weekly 78% left with 51% of the window left.
const metric = <T>(value: T): Metric<T> => ({ value, observedAt: iso(now), state: "fresh", error: null, source: "t3" });
const weekly = (left: number, timeLeft: number): Window => ({ id: "weekly", kind: "weekly", usedPercent: 100 - left,
  remainingPercent: left, windowDurationMins: 10080, resetsAt: iso(now + timeLeft * 7 * 86400000) });
function codex(left: number, timeLeft: number, funded = true): ProviderHeadroom {
  const p = liveCodex();
  p.accountKey = "a".repeat(64);
  p.included = metric([weekly(left, timeLeft)]);
  p.ordinaryUsageAllowed = metric(true);
  p.spendControlReached = metric(!funded ? true : false);
  if (!funded) { p.credits = newProvider("codex", "codex").credits; p.manualResets = newProvider("codex", "codex").manualResets; }
  return p;
}
function claude(left: number | null, timeLeft = .51): ProviderHeadroom {
  const p = newProvider("claudeAgent", "claudeAgent");
  p.accountKey = "b".repeat(64);
  if (left !== null) p.included = metric([weekly(left, timeLeft)]);
  return p;
}
function data(rows: ProviderHeadroom[], withCapacity = true): PolicyData {
  return { catalog, now, analytics: null,
    quota: Object.fromEntries(rows.map(p => [p.alias, { observedAt: p.included.observedAt, windows: p.included.value ?? [], activeStop: false }])),
    ...(withCapacity ? { capacity: Object.fromEntries(rows.map(p => [p.alias, classifyCapacity(p, false, now)])) } : {}) };
}
const roles: Role[] = ["builder", "critical-review", "bulk-read", "general"];

test("a credit-funded Codex lane with an under-paced included weekly window is use-it", () => {
  const c = classifyCapacity(codex(93, .07), false, now);
  assert.equal(c.class, "use-it");
  assert.equal(c.creditFunded, true);
  assert.match(c.reasons.join("; "), /credit-funded lane: fresh account-bound Codex credits, spend control not reached/);
  assert.match(c.reasons.join("; "), /included weekly window under-paced and would expire unused at the native reset/);
  // Ahead of pace, exhausted, or with the included lane closed: credits keep the lane unlimited.
  for (const p of [codex(30, .5), codex(5, .5)]) assert.equal(classifyCapacity(p, false, now).class, "unlimited");
  const denied = codex(93, .07); denied.ordinaryUsageAllowed = metric(false);
  assert.equal(classifyCapacity(denied, false, now).class, "unlimited");
  const gated = codex(93, .07);
  gated.included = metric([weekly(93, .07), { id: "5h", kind: "session", usedPercent: 100, remainingPercent: 0, windowDurationMins: 300, resetsAt: iso(now + 3600000) }]);
  const g = classifyCapacity(gated, false, now);
  assert.equal(g.class, "unlimited"); assert.equal(g.creditFunded, true);
  assert.equal(classifyCapacity(claude(78), false, now).class, "use-it");
});
test("live scenario: the larger expiring Codex surplus wins over use-it Claude", () => {
  const d = data([codex(93, .07), claude(78)]);
  for (const role of roles) {
    const r = recommend({ role }, d);
    assert.equal(r.providerInstanceId, "codex", role);
  }
  const r = recommend({ role: "general" }, d);
  assert.ok(r.reasons.includes("Quota pacing prefers codex: larger expiring weekly surplus (codex 0.86, claudeAgent 0.27)"));
  // Without credits the same included surplus still decides.
  assert.equal(recommend({ role: "builder" }, data([codex(93, .07, false), claude(78)])).providerInstanceId, "codex");
  assert.equal(recommend({ role: "executor" }, d).providerInstanceId, "codex");
});
test("a larger Claude surplus routes to Claude", () => {
  const d = data([codex(60, .45), claude(90, .3)]);
  for (const role of ["builder", "general", "bulk-read"] as const) assert.equal(recommend({ role }, d).providerInstanceId, "claudeAgent", role);
  assert.ok(recommend({ role: "general" }, d).reasons.some(x => x.startsWith("Quota pacing prefers claudeAgent: larger expiring weekly surplus")));
  // Executor keeps its Codex preference.
  assert.equal(recommend({ role: "executor" }, d).providerInstanceId, "codex");
});
test("Codex ahead of pace with credits stays unlimited and under-paced Claude still wins", () => {
  const d = data([codex(30, .5), claude(78)]);
  assert.equal(d.capacity?.codex?.class, "unlimited");
  for (const role of ["builder", "general"] as const) assert.equal(recommend({ role }, d).providerInstanceId, "claudeAgent", role);
  // Included quota exhausted, only credits left: unlimited Codex still beats paced Claude, as before.
  const paced = data([codex(5, .5), claude(30, .4)]);
  assert.equal(paced.capacity?.claudeAgent?.class, "paced");
  assert.equal(recommend({ role: "builder" }, paced).providerInstanceId, "codex");
});
// Generated pools: each instance is (driver, pace, capacity class). Pace p is produced by a weekly
// window with remaining - timeLeft = p; null means no window.
type Spec = { driver: "claudeAgent" | "codex"; pace: number | null; kind: "use-it" | "unlimited" };
const paceWindow: Record<string, [number, number]> = { "-0.3": [.5, .8], "0.05": [.55, .5], "0.2": [.7, .5], "0.6": [.9, .3] };
const cap = (s: Spec): Capacity => ({ class: s.kind, reasons: ["fixture"], remainingFraction: null, reserveWeeks: 0,
  observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: iso(now),
  ...(s.driver === "codex" ? { creditFunded: true as const } : {}) });
function pool(specs: ReadonlyArray<Spec>, ids: ReadonlyArray<string>, withCapacity = true): PolicyData {
  const model = (d: Spec["driver"]) => catalog.find(p => p.providerInstanceId === d)!.models.find(m => m.id === (d === "codex" ? "gpt-6.1-sol" : "claude-opus-5-5"))!;
  return { now, analytics: null,
    catalog: specs.map((s, i) => ({ providerInstanceId: ids[i]!, driverKind: s.driver, canRunChildTask: true, models: [model(s.driver)] })),
    quota: Object.fromEntries(specs.map((s, i) => {
      const w = s.pace === null ? null : paceWindow[String(s.pace)]!;
      return [ids[i]!, { observedAt: iso(now), activeStop: false, windows: w ? [weekly(w[0] * 100, w[1])] : [] }];
    })),
    ...(withCapacity ? { capacity: Object.fromEntries(specs.map((s, i) => [ids[i]!, cap(s)])) } : {}) };
}
const label = (s: Spec) => s.driver + "/" + s.pace + "/" + s.kind;
/** Ranked specs, by label, so identically described instances are indistinguishable. */
function ranked(specs: ReadonlyArray<Spec>, ids: ReadonlyArray<string>, withCapacity = true): string[] {
  const r = recommend({ role: "builder" }, pool(specs, ids, withCapacity));
  // Without capacity evidence the class is not an input, so it is not part of the label.
  return [r, ...r.alternatives].map(t => specs[ids.indexOf(t.providerInstanceId)]!)
    .map(s => withCapacity ? label(s) : s.driver + "/" + s.pace);
}
const permutations = <T>(xs: T[]): T[][] => xs.length <= 1 ? [xs] : xs.flatMap((x, i) =>
  permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map(rest => [x, ...rest]));
test("ranking is a total preorder over generated mixed-driver triples", () => {
  const specs: Spec[] = [];
  for (const driver of ["claudeAgent", "codex"] as const) for (const pace of [null, -0.3, 0.05, 0.2, 0.6])
    for (const kind of ["use-it", "unlimited"] as const) specs.push({ driver, pace, kind });
  let checked = 0;
  for (let i = 0; i < specs.length; i++) for (let j = i; j < specs.length; j++) for (let k = j; k < specs.length; k++) {
    const triple = [specs[i]!, specs[j]!, specs[k]!];
    for (const withCapacity of [true, false]) {
      // Input order (instance ids are sorted before ranking) must not change the ranking.
      const orders = permutations(["a", "b", "c"]).map(ids => ranked(triple, ids, withCapacity).join(" > "));
      assert.equal(new Set(orders).size, 1, triple.map(label).join(", ") + (withCapacity ? "" : " (no capacity)") + ": " + [...new Set(orders)].join(" | "));
      // Adding or removing another driver's candidate never reorders one driver's candidates.
      const full = ranked(triple, ["a", "b", "c"], withCapacity);
      for (const drop of [0, 1, 2]) {
        const rest = triple.filter((_, n) => n !== drop);
        if (rest[0]!.driver !== rest[1]!.driver || triple[drop]!.driver === rest[0]!.driver) continue;
        const sub = ranked(rest, ["a", "b"], withCapacity);
        assert.deepEqual(full.filter(l => sub.includes(l) && l.startsWith(rest[0]!.driver + "/")).filter((l, n, a) => a.indexOf(l) === n),
          sub.filter((l, n, a) => a.indexOf(l) === n), triple.map(label).join(", "));
      }
      checked++;
    }
  }
  assert.ok(checked > 400);
});
test("reviewer repro: adding a Claude candidate does not change which Codex account wins", () => {
  // A: Claude use-it (refill expiring), pace 0.05. B: funded Codex use-it (credits expiring),
  // unknown pace. C: funded Codex use-it (credits expiring), pace -0.30.
  const A: Spec = { driver: "claudeAgent", pace: 0.05, kind: "use-it" };
  const B: Spec = { driver: "codex", pace: null, kind: "use-it" };
  const C: Spec = { driver: "codex", pace: -0.3, kind: "use-it" };
  assert.deepEqual(ranked([A, B, C], ["a", "b", "c"]), [label(A), label(C), label(B)]);
  assert.deepEqual(ranked([B, C], ["b", "c"]), [label(C), label(B)]);
  for (const ids of permutations(["a", "b", "c"])) assert.deepEqual(ranked([A, B, C], ids), [label(A), label(C), label(B)]);
});
test("benchmark surplus reason names the representatives actually compared", () => {
  // Claude Opus pace 0.60, cheaper Claude Haiku pace 0.15, Codex pace 0.40; all use-it.
  const opts = (id: string) => [{ id, type: "select", options: [{ id: "medium" }] }];
  const s = (model: string, cost: number) => ({ model, effort: "medium" as const, aaSlug: model, intelligence: 60, coding: 60,
    inputPrice: 1, outputPrice: 1, benchmarkCostUSDPerTask: cost });
  const paced = (left: number, timeLeft: number) => ({ observedAt: iso(now), activeStop: false, windows: [weekly(left, timeLeft)] });
  const use = cap({ driver: "claudeAgent", pace: null, kind: "use-it" });
  const d: PolicyData = { now, analytics: null,
    catalog: [
      { providerInstanceId: "claude-a", driverKind: "claudeAgent", canRunChildTask: true, models: [{ id: "claude-opus-5-5", options: opts("effort") }] },
      { providerInstanceId: "claude-b", driverKind: "claudeAgent", canRunChildTask: true, models: [{ id: "claude-haiku-5-5", options: opts("effort") }] },
      { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true, models: [{ id: "gpt-6.1-sol", options: opts("reasoningEffort") }] }],
    quota: { "claude-a": paced(90, .3), "claude-b": paced(65, .5), codex: paced(90, .5) },
    capacity: { "claude-a": use, "claude-b": use, codex: { ...use, creditFunded: true } },
    scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(now), unmapped: [],
      models: [s("claude-opus-5-5", 5), s("claude-haiku-5-5", 1), s("gpt-6.1-sol", 3)] },
    config: { benchmark: { indexVersion: "5", anchors: { general: ["claude-opus-5-5", "claude-haiku-5-5", "gpt-6.1-sol"] } } } };
  const r = recommend({ role: "general" }, d);
  assert.equal(r.providerInstanceId, "codex");
  assert.ok(r.reasons.includes("Quota pacing prefers codex: larger expiring weekly surplus (codex 0.40, claudeAgent 0.15)"), r.reasons.join("\n"));
});
test("unknown Claude pace keeps the role default", () => {
  // No capacity evidence at all: an under-paced Codex never overrides the Claude default.
  const bare = data([codex(93, .07), claude(null)], false);
  const r = recommend({ role: "general" }, bare);
  assert.equal(r.providerInstanceId, "claudeAgent");
  assert.ok(r.reasons.includes("Claude pacing unknown; role default prefers Claude"));
  // With capacity evidence, use-it Codex outranks unknown Claude, as it already did when unlimited.
  assert.equal(recommend({ role: "general" }, data([codex(93, .07), claude(null)])).providerInstanceId, "codex");
});
