import assert from "node:assert/strict";
import { test } from "node:test";
import { newProvider } from "../../src/quota/headroom.ts";
import { classifyCapacity, DEFAULT_CAPACITY } from "../../src/quota/capacity.ts";
import { now, iso } from "../fixtures/route/catalog.ts";
function scenario(hours: number, expiryHours: number | null = null, remaining = .2) {
  const p = newProvider("codex", "codex");
  const w = { id: "week", kind: "weekly", remainingPercent: remaining * 100, usedPercent: 100 - remaining * 100,
    windowDurationMins: 10080, resetsAt: iso(now + hours * 3600000) };
  p.included = { state: "fresh", observedAt: iso(now), source: "fixture", error: null, value: [w] };
  p.burnHistory = [{ observedAt: iso(now - 3600000), windows: [{ ...w, remainingPercent: w.remainingPercent + .15, usedPercent: w.usedPercent - .15 }] }];
  p.manualResets = { state: "fresh", observedAt: iso(now), source: "fixture", error: null,
    value: { availableCount: 2, nextExpiresAt: expiryHours === null ? null : iso(now + expiryHours * 3600000) } };
  return p;
}
test("Codex reserve scenario table values redemption lead, not a free week", () => {
  // Heavy rate .003 quota/hour, projected first exhaustion at 66.67 hours.
  for (const [hours, expected] of [[1, 0], [72, 0], [144, (144 - .2 / .003) / 168]] as const) {
    const c = classifyCapacity(scenario(hours), false, now);
    assert.ok(Math.abs(c.reserveWeeks - expected) < 1e-10, "native reset in " + hours + "h");
    assert.match(c.reasons.join(" "), /72h lead/);
  }
  // With lead relaxed, an almost-exhausted quota gains only the fraction of an hour left.
  const c = classifyCapacity(scenario(1, null, .001), false, now, { ...DEFAULT_CAPACITY, minimumResetLeadHours: 0 });
  assert.ok(Math.abs(c.reserveWeeks - (1 - .001 / .003) / 168) < 1e-10);
  assert.ok(c.reserveWeeks < 1 / 168);
});
test("reserve expiry before projected redemption is worthless, useful near-expiry reserve is use-it", () => {
  const worthless = classifyCapacity(scenario(144, 48), false, now);
  assert.equal(worthless.reserveWeeks, 0); assert.equal(worthless.class, "paced");
  assert.match(worthless.reasons.join(" "), /0\/2 reserves usable/);
  const useful = classifyCapacity(scenario(144, 20, .05), false, now);
  assert.ok(useful.reserveWeeks > 0); assert.equal(useful.class, "use-it");
});
test("Codex exactly 72 hours of lead counts; just inside minimum lead does not", () => {
  const first = .2 / .003;
  const atBoundary = classifyCapacity(scenario(first + 72), false, now);
  assert.ok(Math.abs(atBoundary.reserveWeeks - 72 / 168) < 1e-8);
  const inside = classifyCapacity(scenario(first + 71.99), false, now);
  assert.equal(inside.reserveWeeks, 0);
});
test("Claude refills are valued at future exhaustion and expire before that point", () => {
  const p = scenario(144, null);
  const claude = { ...p, alias: "claudeAgent", driver: "claudeAgent" };
  const config = { ...DEFAULT_CAPACITY, providers: { claudeAgent: { claudeRefills: { count: 2, expiresAt: iso(now + 48 * 3600000) } } } };
  assert.equal(classifyCapacity(claude, false, now, config).reserveWeeks, 0);
  config.providers.claudeAgent.claudeRefills.expiresAt = iso(now + 145 * 3600000);
  assert.ok(Math.abs(classifyCapacity(claude, false, now, config).reserveWeeks - (144 - .2 / .003) / 168) < 1e-10);
});
