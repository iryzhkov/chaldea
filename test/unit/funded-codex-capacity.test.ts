import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCodex, newProvider } from "../../src/quota/headroom.ts";
import type { Metric, ProviderHeadroom, Window } from "../../src/quota/headroom.ts";
import { classifyCapacity, DEFAULT_CAPACITY } from "../../src/quota/capacity.ts";
import { accountKey, capacityKey } from "../../src/quota/account.ts";
import { recommend } from "../../src/route/policy.ts";
import type { RouteInput } from "../../src/route/types.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { liveCodex } from "../fixtures/route/live-policy.ts";

// Sanitized shape of the 2026-10-19 omarchy-pc cache: included weekly quota exhausted,
// ordinaryUsageAllowed=false, about 59k fresh credits, spend control not reached,
// an asserted HOME binding and an account hash. No native account ID is used.
const metric = <T>(value: T, at = now): Metric<T> => ({ value, observedAt: iso(at), state: "fresh", error: null, source: "codex-app-server" });
const weekly = (remaining: number, timeLeft = .4): Window => ({ id: "primary", kind: "weekly", usedPercent: 100 - remaining,
  remainingPercent: remaining, windowDurationMins: 10080, resetsAt: iso(now + timeLeft * 7 * 86400000) });
const session = (remaining: number): Window => ({ id: "5h", kind: "session", usedPercent: 100 - remaining,
  remainingPercent: remaining, windowDurationMins: 300, resetsAt: iso(now + 3600000) });
function fundedCodex(): ProviderHeadroom {
  const p = liveCodex();
  p.accountKey = "a".repeat(64);
  p.binding = "asserted";
  p.credits = metric({ balance: "59012.25", hasCredits: true, unlimited: false });
  p.included = metric([weekly(0)]);
  p.ordinaryUsageAllowed = metric(false);
  p.spendControlReached = metric(false);
  return p;
}
/** Claude weekly quota trending to run out before its reset: 30% left with 40% of the week left. */
function pacedClaude(): ProviderHeadroom {
  const p = newProvider("claudeAgent", "claudeAgent");
  p.accountKey = "b".repeat(64);
  p.included = { ...metric([weekly(30)]), source: "t3" };
  p.burnHistory = [{ observedAt: iso(now - 3600000), windows: [{ ...weekly(31), remainingPercent: 31, usedPercent: 69 }] }];
  return p;
}
function route(codex: ProviderHeadroom, input: RouteInput, stops: { codex?: boolean; claudeAgent?: boolean } = {}) {
  const rows = [codex, pacedClaude()];
  const capacity = Object.fromEntries(rows.map(p => [p.alias, classifyCapacity(p, stops[p.alias as "codex"] ?? false, now)]));
  const quota = Object.fromEntries(rows.map(p => [p.alias, { observedAt: p.included.observedAt,
    windows: p.included.value ?? [], activeStop: stops[p.alias as "codex"] ?? false }]));
  return recommend(input, { catalog, now, quota, analytics: null, capacity });
}

test("observed funded Codex: exhausted included quota and ordinary denial still classify credits as unlimited", () => {
  const c = classifyCapacity(fundedCodex(), false, now);
  assert.equal(c.class, "unlimited");
  assert.equal(c.creditFunded, true);
  assert.equal(c.burnTargetPerHour, null);
  assert.match(c.reasons.join("; "), /credit-funded lane/);
  assert.equal(classifyCapacity(pacedClaude(), false, now).class, "paced");
  const expiring = fundedCodex(); expiring.creditExpiresAt = iso(now + 3600000);
  assert.equal(classifyCapacity(expiring, false, now).class, "use-it");
  const included = fundedCodex(); included.ordinaryUsageAllowed = metric(true);
  assert.equal(classifyCapacity(included, false, now).creditFunded, true, "funding does not depend on the included lane");
});

test("funded Codex outranks paced Claude for builder and general; review separation still applies", () => {
  for (const [role, effort] of [["builder", "high"], ["general", "medium"]] as const) {
    const r = route(fundedCodex(), { role });
    assert.equal(r.providerInstanceId, "codex", role);
    assert.equal(r.model, "gpt-6.1-sol", role);
    assert.deepEqual(r.options, { reasoningEffort: effort }, role);
    assert.equal(r.alternatives[0]?.providerInstanceId, "claudeAgent", role);
  }
  const codexAuthor = route(fundedCodex(), { role: "builder", authorProvider: "codex" });
  assert.equal(codexAuthor.providerInstanceId, "claudeAgent");
  assert.equal(codexAuthor.model, "claude-opus-5-5");
  const claudeAuthor = route(fundedCodex(), { role: "builder", authorProvider: "claudeAgent" });
  assert.equal(claudeAuthor.providerInstanceId, "codex");
  assert.equal(claudeAuthor.model, "gpt-6.1-sol");
  // Bans and the catalog effort/model floor still apply to the funded provider.
  assert.equal(recommend({ role: "builder" }, { catalog, now, analytics: null, config: { bans: ["*sonnet*", "gpt-6.1-sol"] },
    quota: {}, capacity: { codex: classifyCapacity(fundedCodex(), false, now) } }).providerInstanceId, "claudeAgent");
});

test("unproven credit funding fails closed while the included lane is denied", () => {
  const cases: Array<[string, (p: ProviderHeadroom) => void]> = [
    ["spend control reached", p => { p.spendControlReached = metric(true); }],
    ["spend control unknown", p => { p.spendControlReached = newProvider("codex", "codex").spendControlReached; }],
    ["spend control errored", p => { p.spendControlReached = { ...p.spendControlReached, state: "error", error: "read_failed" }; }],
    ["spend control stale", p => { p.spendControlReached = metric(false, now - DEFAULT_CAPACITY.maxAgeMs); }],
    ["credits stale", p => { p.credits = metric(p.credits.value!, now - DEFAULT_CAPACITY.maxAgeMs); }],
    ["credits expired", p => { p.creditExpiresAt = iso(now); }],
    ["credits missing", p => { p.credits = newProvider("codex", "codex").credits; }],
    ["zero wallet", p => { p.credits = metric({ balance: "0", hasCredits: false, unlimited: false }); }],
    ["zero balance flagged available", p => { p.credits = metric({ balance: "0", hasCredits: true, unlimited: false }); }],
    ["unknown balance", p => { p.credits = { ...metric({ balance: null, hasCredits: true, unlimited: false }), state: "unknown" }; }],
    ["no account binding", p => { delete p.accountKey; }],
  ];
  for (const [name, change] of cases) {
    const p = fundedCodex(); change(p);
    const c = classifyCapacity(p, false, now);
    assert.equal(c.class, "tight", name);
    assert.equal(c.creditFunded, undefined, name);
    assert.match(c.reasons.join("; "), /ordinary included usage not allowed/, name);
    assert.equal(route(p, { role: "builder" }).providerInstanceId, "claudeAgent", name);
    assert.equal(route(p, { role: "general" }).providerInstanceId, "claudeAgent", name);
  }
  // With the included lane open, a reached spend control means credits add nothing; exhausted quota stays tight.
  const p = fundedCodex(); p.ordinaryUsageAllowed = metric(true); p.spendControlReached = metric(true);
  const c = classifyCapacity(p, false, now);
  assert.equal(c.class, "tight"); assert.match(c.reasons.join("; "), /spend control reached/);
});

test("funding proof never crosses observed account identity; same-account partial reads keep retained fields", () => {
  const wallet = (balance: string) => ({ balance, hasCredits: true, unlimited: false });
  const read = (id: string | null, bucket: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({ ...(id ? { accountId: id } : {}), ...extra, rateLimitsByLimitId: { codex: bucket } });
  const a = read("FIXTURE_ACCOUNT_A", { planType: "pro", spendControlReached: false, credits: wallet("100") },
    { ordinaryUsageAllowed: true, rateLimitResetCredits: { availableCount: 1 } });
  const b = read("FIXTURE_ACCOUNT_B", { credits: wallet("59012.25") }, { ordinaryUsageAllowed: false });
  const row = newProvider("codex", "codex");
  row.binding = "asserted";
  row.included = { ...metric([weekly(0)]), source: "t3" };
  applyCodex(row, a, iso(now - 60000));
  assert.equal(classifyCapacity(row, false, now).creditFunded, true, "account A proved its own funding");
  const keyA = row.accountKey;
  applyCodex(row, b, iso(now));
  assert.notEqual(row.accountKey, keyA);
  let c = classifyCapacity(row, false, now);
  assert.equal(c.creditFunded, undefined, "B must not qualify on A's spend-control proof");
  assert.equal(c.class, "tight");
  assert.match(c.reasons.join("; "), /spend control unknown or stale/);
  assert.equal(row.spendControlReached.value, null, "A's spend control is not B's");
  assert.equal(row.plan.value, null); assert.equal(row.manualResets.value, null);
  assert.deepEqual(row.included.value, [weekly(0)], "T3 instance windows are not app-server account metrics");
  applyCodex(row, read("FIXTURE_ACCOUNT_B", { spendControlReached: false, credits: wallet("59012.25") }), iso(now));
  assert.equal(row.ordinaryUsageAllowed.value, false, "same account keeps an omitted ordinary-usage field");
  assert.equal(classifyCapacity(row, false, now).creditFunded, true, "B's own spend proof qualifies");
  applyCodex(row, b, iso(now));
  assert.equal(row.spendControlReached.value, false, "same account keeps an omitted spend-control field");
  assert.equal(classifyCapacity(row, false, now).creditFunded, true);
  // Known to missing identity: retained B fields are dropped and nothing account-bound remains.
  applyCodex(row, read(null, { credits: wallet("10") }), iso(now));
  assert.equal(row.accountKey, undefined);
  assert.equal(row.spendControlReached.value, null); assert.equal(row.ordinaryUsageAllowed.value, null);
  assert.equal(classifyCapacity(row, false, now).creditFunded, undefined);
  // Missing to known identity: proof gathered without an account ID does not bind to the new account.
  applyCodex(row, read(null, { spendControlReached: false, credits: wallet("10") }, { ordinaryUsageAllowed: false }), iso(now));
  applyCodex(row, b, iso(now));
  assert.equal(row.spendControlReached.value, null);
  c = classifyCapacity(row, false, now);
  assert.equal(c.class, "tight"); assert.equal(c.creditFunded, undefined);
  // T3-sourced reset inventory belongs to the T3 instance and survives an app-server identity change.
  row.manualResets = { ...metric({ availableCount: 2, nextExpiresAt: null }), source: "t3" };
  applyCodex(row, read("FIXTURE_ACCOUNT_C", { credits: wallet("1") }), iso(now));
  assert.equal(row.manualResets.source, "t3"); assert.equal(row.manualResets.value?.availableCount, 2);
  // A's cached credit expiry is not B's: B's configured past expiry still refuses funding.
  const expiring = newProvider("codex", "codex");
  expiring.binding = "asserted";
  applyCodex(expiring, a, iso(now));
  expiring.creditExpiresAt = iso(now + 30 * 86400000);
  assert.equal(classifyCapacity(expiring, false, now).creditFunded, true);
  const config = { ...DEFAULT_CAPACITY, providers: { [capacityKey("codex", accountKey("FIXTURE_ACCOUNT_B")!)]: { creditExpiresAt: iso(now - 1) } } };
  const fundedB = read("FIXTURE_ACCOUNT_B", { spendControlReached: false, credits: wallet("59012.25") }, { ordinaryUsageAllowed: false });
  applyCodex(expiring, fundedB, iso(now));
  c = classifyCapacity(expiring, false, now, config);
  assert.equal(c.creditFunded, undefined, "A's future expiry must not override B's expired credits");
  assert.equal(c.class, "tight");
  assert.equal(expiring.creditExpiresAt, undefined);
  // The same account keeps its cached expiry; losing the identity drops it.
  expiring.creditExpiresAt = iso(now + 3600000);
  applyCodex(expiring, fundedB, iso(now));
  assert.equal(expiring.creditExpiresAt, iso(now + 3600000));
  applyCodex(expiring, read(null, { credits: wallet("1") }), iso(now));
  assert.equal(expiring.creditExpiresAt, undefined);
});

test("active usage stops stay stopped; included short-window gates do not gate the proven paid lane", () => {
  assert.equal(classifyCapacity(fundedCodex(), true, now).class, "stopped");
  assert.equal(route(fundedCodex(), { role: "builder" }, { codex: true }).providerInstanceId, "claudeAgent");
  assert.throws(() => route(fundedCodex(), { role: "builder", authorProvider: "claudeAgent" }, { codex: true }), /No eligible/);
  for (const left of [0, 5]) {
    const funded = fundedCodex(); funded.included = metric([weekly(0), session(left)]);
    const c = classifyCapacity(funded, false, now);
    assert.equal(c.class, "unlimited", String(left)); assert.equal(c.creditFunded, true);
    const r = route(funded, { role: "builder" });
    assert.equal(r.providerInstanceId, "codex", String(left));
    assert.match(r.reasons.join("; "), /included short window .* does not gate the credit-funded lane/);
    assert.equal(route(funded, { role: "builder" }, { codex: true }).providerInstanceId, "claudeAgent");
    // Without proven funding the short included gate still excludes Codex, as before.
    const advisory = fundedCodex(); advisory.included = funded.included;
    advisory.ordinaryUsageAllowed = metric(true); advisory.spendControlReached = newProvider("codex", "codex").spendControlReached;
    assert.equal(classifyCapacity(advisory, false, now).class, left === 0 ? "stopped" : "tight");
    assert.equal(route(advisory, { role: "builder" }).providerInstanceId, "claudeAgent");
  }
});
