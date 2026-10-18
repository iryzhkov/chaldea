import assert from "node:assert/strict";
import { test } from "node:test";
import { newProvider, applyT3, validateHeadroom, emptyHeadroom } from "../../src/quota/headroom.ts";
import type { Metric, Window } from "../../src/quota/headroom.ts";
import { classifyCapacity, classifyCapacities, DEFAULT_CAPACITY } from "../../src/quota/capacity.ts";
import { emptyState } from "../../src/quota/state.ts";
import { recommend } from "../../src/route/policy.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { liveCodex } from "../fixtures/route/live-policy.ts";
const metric = <T>(value: T): Metric<T> => ({ value, observedAt: iso(now), state: "fresh", error: null, source: "fixture" });
function provider(driver: string, remaining: number, burn = .002, timeLeft = .4) {
  const p = newProvider(driver, driver);
  const window: Window = { id: "week", kind: "weekly", usedPercent: 100 - remaining, remainingPercent: remaining,
    windowDurationMins: 10080, resetsAt: iso(now + timeLeft * 168 * 3600000) };
  p.included = metric([window]);
  p.burnHistory = [{ observedAt: iso(now - 3600000), windows: [{ ...window, remainingPercent: remaining + burn * 100, usedPercent: 100 - remaining - burn * 100 }] }];
  return p;
}
test("capacity scenario table: light/heavy weeks, reserves, expiring credits, stale and stop", () => {
  const light = provider("claudeAgent", 80);
  const heavy = provider("codex", 20, .0015, 6 / 7);
  heavy.manualResets = metric({ availableCount: 2, nextExpiresAt: null });
  const expiring = provider("codex", 30, .01);
  expiring.credits = metric({ balance: "100", hasCredits: true, unlimited: false });
  const stale = provider("codex", 90); stale.included = { ...stale.included, observedAt: iso(now - 3600000) };
  const config = { ...DEFAULT_CAPACITY, providers: { codex: { creditsPerFullWeek: 100, creditExpiresAt: iso(now + 3600000) } } };
  for (const [name, p, stop, expected] of [
    ["light week", light, false, "use-it"], ["heavy week with resets", heavy, false, "unlimited"],
    ["credit near expiry", expiring, false, "use-it"], ["stale data", stale, false, "unknown"],
    ["provider stop", heavy, true, "stopped"], ["low, no reserves", provider("codex", 9), false, "tight"],
  ] as const) {
    const c = classifyCapacity(p, stop, now, config);
    assert.equal(c.class, expected, name); assert.ok(c.reasons.length, name);
  }
  const c = classifyCapacity(heavy, false, now, config);
  assert.ok(Math.abs(c.reserveWeeks - (144 - .2 / .003) / 168) < 1e-10);
  assert.ok(Math.abs(c.projectedHeavyUse! - .432) < 1e-10);
  assert.ok(Math.abs(c.burnTargetPerHour! - .15 / 144) < 1e-10);
});
test("short reset proximity never changes weekly pace; short gates override reserves and credits", () => {
  const short = (left: number, reset = now + 600000): Window => ({ id: "5h", kind: "session",
    usedPercent: 100 - left, remainingPercent: left, windowDurationMins: 300, resetsAt: iso(reset) });
  const p = provider("claudeAgent", 40, .01);
  p.included = metric([...p.included.value!, short(35)]);
  assert.equal(classifyCapacity(p, false, now).class, "paced");
  assert.match(classifyCapacity(p, false, now).reasons.join("; "), /weekly 40% left with 40%.*5h window 35%/);
  const weekly = provider("claudeAgent", 62, .01).included.value![0]!;
  p.included = metric([weekly, short(5)]);
  const c = classifyCapacity(p, false, now);
  assert.equal(c.class, "tight");
  assert.match(c.reasons.join("; "), /weekly 62% left with 40%.*under-paced.*5h window 5%/);
  assert.equal(classifyCapacity(p, false, now, { ...DEFAULT_CAPACITY, minimumRemaining: .04 }).class, "use-it");
  p.included = metric([weekly, short(10)]);
  assert.equal(classifyCapacity(p, false, now).class, "use-it");
  p.included = metric([weekly, short(0)]);
  assert.equal(classifyCapacity(p, false, now).class, "stopped");
  p.included = metric([weekly, short(0, now)]);
  assert.equal(classifyCapacity(p, false, now).class, "use-it");
  p.included = metric([short(80)]);
  assert.equal(classifyCapacity(p, false, now).class, "unknown");
  const codex = provider("codex", 62);
  codex.credits = metric({ balance: "200", hasCredits: true, unlimited: false });
  codex.manualResets = metric({ availableCount: 2, nextExpiresAt: null });
  for (const [left, expected] of [[5, "tight"], [0, "stopped"], [10, "unlimited"]] as const) {
    codex.included = metric([codex.included.value![0]!, short(left)]);
    assert.equal(classifyCapacity(codex, false, now).class, expected);
  }
});
test("Claude 40% without reserves vs Codex 20% with 2 resets routes Codex", () => {
  const claude = provider("claudeAgent", 40, .0015, 6 / 7), codex = provider("codex", 20, .0015, 6 / 7);
  codex.manualResets = metric({ availableCount: 2, nextExpiresAt: iso(now + 10 * 86400000) });
  const state = emptyState(); state.headroom.providers.push(claude, codex);
  const capacity = classifyCapacities(state, now);
  assert.equal(capacity.claudeAgent?.class, "paced"); assert.equal(capacity.codex?.class, "unlimited");
  const quota = Object.fromEntries([claude, codex].map(p => [p.alias, { observedAt: p.included.observedAt, windows: p.included.value!, activeStop: false }]));
  const r = recommend({ role: "builder" }, { catalog, now, quota, analytics: null, capacity });
  assert.equal(r.providerInstanceId, "codex"); assert.match(r.reasons.join(" "), /2 Codex resets/);
});
test("Claude refill keeps native deadline and is capped by remaining window time; expired excluded", () => {
  const p = provider("claudeAgent", 20, .01);
  const config = { ...DEFAULT_CAPACITY, providers: { claudeAgent: { claudeRefills: { count: 2, expiresAt: iso(now + 10 * 86400000) } } } };
  assert.ok(Math.abs(classifyCapacity(p, false, now, config).reserveWeeks - (57.2 + 7.2) / 168) < 1e-10);
  assert.equal(classifyCapacity(p, false, now, config).class, "paced");
  config.providers.claudeAgent.claudeRefills.expiresAt = iso(now - 1);
  assert.equal(classifyCapacity(p, false, now, config).reserveWeeks, 0);
});
test("Codex credits need no conversion or reserve; stale credits and expired resets cannot establish unlimited", () => {
  const p = provider("codex", 20, .01);
  p.credits = metric({ balance: "200", hasCredits: true, unlimited: false });
  assert.equal(classifyCapacity(p, false, now).class, "unlimited");
  const config = { ...DEFAULT_CAPACITY, providers: { codex: { creditsPerFullWeek: 100 } } };
  assert.equal(classifyCapacity(p, false, now, config).class, "unlimited");
  p.credits = { ...p.credits, observedAt: iso(now - 3600000) };
  p.manualResets = metric({ availableCount: 2, nextExpiresAt: iso(now - 1) });
  assert.equal(classifyCapacity(p, false, now, config).class, "paced");
  const missing = newProvider("codex", "codex"); missing.credits = metric({ balance: "999999", hasCredits: true, unlimited: true });
  assert.equal(classifyCapacity(missing, false, now, config).class, "unlimited");
});
test("live Codex wallet establishes capacity without native windows, conversion or burn", () => {
  const p = liveCodex();
  assert.equal(classifyCapacity(p, false, now).class, "unlimited");
  p.included = provider("codex", 0).included;
  assert.equal(classifyCapacity(p, false, now).class, "unlimited");
  p.creditExpiresAt = iso(now + 3600000);
  assert.equal(classifyCapacity(p, false, now).class, "use-it");
  assert.equal(classifyCapacity(p, true, now).class, "stopped");
  p.ordinaryUsageAllowed = metric(false);
  assert.equal(classifyCapacity(p, false, now).class, "tight");
  p.ordinaryUsageAllowed = metric(true);
  assert.equal(classifyCapacity(p, false, now).class, "use-it");
  const capacity = { codex: classifyCapacity(p, false, now) };
  assert.equal(recommend({ role: "builder" }, { catalog, now, quota: {}, analytics: null, capacity }).providerInstanceId, "codex");
});
test("missing, invalid, stale and expired credit evidence never implies unlimited", () => {
  for (const balance of [null, "0", "invalid", "-1"]) {
    const p = newProvider("codex", "codex");
    p.credits = metric({ balance, hasCredits: true, unlimited: false });
    assert.equal(classifyCapacity(p, false, now).class, "unknown", String(balance));
  }
  for (const state of ["unknown", "stale", "error"] as const) {
    const p = liveCodex(); p.credits = { ...p.credits, state };
    assert.equal(classifyCapacity(p, false, now).class, "unknown", state);
  }
  const p = liveCodex();
  p.creditExpiresAt = iso(now);
  assert.equal(classifyCapacity(p, false, now).class, "unknown");
  delete p.creditExpiresAt;
  p.credits = { ...p.credits, observedAt: iso(now - DEFAULT_CAPACITY.maxAgeMs) };
  assert.equal(classifyCapacity(p, false, now).class, "unknown");
});
test("recent burn resets on refill, respects configurable heavy multiplier, no writes in policy", () => {
  const p = provider("codex", 20, .01), before = JSON.stringify(p);
  assert.equal(classifyCapacity(p, false, now, { ...DEFAULT_CAPACITY, heavyMultiplier: .1 }).class, "unlimited");
  assert.equal(JSON.stringify(p), before);
  p.burnHistory = [{ observedAt: iso(now - 3600000), windows: [{ ...p.included.value![0]!, remainingPercent: 10 }] }];
  assert.equal(classifyCapacity(p, false, now).observedBurnPerHour, null);
});
test("idle samples never establish unlimited; history has a per-provider byte budget", () => {
  const idle = provider("codex", 15, 0);
  assert.equal(classifyCapacity(idle, false, now).class, "paced");
  const p = provider("codex", 40);
  for (let i = 1; i <= 100; i++) applyT3(p, { usageLimits: { checkedAt: iso(now + i * 300000),
    windows: Array.from({ length: 32 }, (_, j) => ({ id: "window_" + j, kind: "weekly",
      usedPercent: 60, windowDurationMins: 10080, resetsAt: iso(now + 7 * 86400000) })) } } as never);
  assert.ok(Buffer.byteLength(JSON.stringify(p.burnHistory)) <= 16 * 1024);
  assert.ok(p.burnHistory!.length > 1);
});
test("observer retains bounded samples without changing feed cadence; validation rejects oversized history", () => {
  const p = provider("codex", 20, .01);
  applyT3(p, { usageLimits: { checkedAt: iso(now + 600000), windows: [{ id: "week", kind: "weekly", usedPercent: 81, windowDurationMins: 10080, resetsAt: p.included.value![0]!.resetsAt! }] } } as never);
  assert.equal(p.burnHistory?.length, 2);
  const state = { ...emptyHeadroom(), providers: [p] };
  assert.equal(validateHeadroom(state), state);
  p.burnHistory = Array.from({ length: 289 }, () => p.burnHistory![0]!);
  assert.throws(() => validateHeadroom(state), /invalid_headroom/);
});
