import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync, readFileSync, symlinkSync, statSync, utimesSync } from "node:fs";
import { aggregate, collectAnalytics, validateAnalytics } from "../../src/route/analytics.ts";
import { collectClaudeUsage, CLAUDE_USAGE_URL, CLAUDE_CADENCE_MS } from "../../src/route/claude-usage.ts";
import { getJson } from "../../src/route/cache.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { recommend } from "../../src/route/policy.ts";
const row = { day: "2026-10-16", harness: "claudeAgent", model: "Opus 5.5",
  terminal: 100, completed: 90, failed: 6, interrupted: 4, timedTurns: 80, durationMs: 9600000 };
const report = { schemaVersion: 2, fetchedAt: iso(now), start: "2026-10-01", endExclusive: "2026-10-17", metrics: [row, row] };
test("aggregate Slopalytics across file window and exact names/harnesses", () => {
  const a = aggregate({ ...report, metrics: [...report.metrics,
    { ...row, day: "2026-10-18" }, { ...row, model: "Haiku 4.5" }, { ...row, harness: "opencode" },
    { ...row, model: "GPT-6 Sol", harness: "codex" },
  ] }, iso(now));
  assert.deepEqual(a.models["claude-opus-5-5"], {
    turns: 200, completionRate: .9, failedRate: .06, interruptedRate: .04, minutesPerTurn: 2,
  });
  assert.deepEqual(Object.keys(a.models), ["claude-opus-5-5"]);
  assert.throws(() => aggregate({ ...report, metrics: [{ ...row, failed: 100 }] }, iso(now)), /Invalid/);
});
test("cached analytics ignore obsolete models without changing stats, timestamps or freshness", async () => {
  const d = routeScratch();
  try {
    const a = aggregate(report, iso(now - 1000));
    const value = { ...a, endExclusive: iso(now - 4 * 86400000),
      models: { ...a.models, "claude-sonnet-5-5": { obsolete: true }, "old-generation": null } };
    const path = join(d.path, "slop.json");
    const disk = JSON.stringify({ attemptedAt: now, fetchedAt: iso(now - 1000), value });
    writeFileSync(path, disk, { mode: 0o600 });
    const result = await collectAnalytics(path, now, async () => { throw new Error("must not fetch"); });
    assert.deepEqual(result.value, { ...a, endExclusive: value.endExclusive });
    assert.equal(result.fetchedAt, iso(now - 1000)); assert.equal(result.reason, null);
    assert.equal(readFileSync(path, "utf8"), disk);
    const data = { catalog, quota: {}, analytics: result.value, now, config: { analyticsMaxAgeMs: 3 * 86400000 } };
    const stale = recommend({ role: "builder" }, data);
    assert.match(stale.reasons.join(" "), /Slopalytics stale/);
    assert.equal(stale.dataAges.slopalyticsWindow, 4 * 86400);
    assert.doesNotMatch(recommend({ role: "builder" }, { ...data,
      config: { analyticsMaxAgeMs: 5 * 86400000 } }).reasons.join(" "), /Slopalytics stale/);
    const empty = validateAnalytics({ ...a, models: { "claude-sonnet-5-5": null } });
    assert.deepEqual(empty.models, {});
    assert.equal(recommend({ role: "builder" }, { ...data, analytics: empty }).model,
      recommend({ role: "builder" }, { ...data, analytics: null }).model);
    for (const field of ["fetchedAt", "sourceFetchedAt", "endExclusive"])
      assert.throws(() => validateAnalytics({ ...value, [field]: "invalid" }), /Invalid analytics/);
    for (const bad of [null, { ...a.models["claude-opus-5-5"], turns: -1 },
      { ...a.models["claude-opus-5-5"], completionRate: 2 },
      { ...a.models["claude-opus-5-5"], failedRate: -1 },
      { ...a.models["claude-opus-5-5"], interruptedRate: NaN },
      { ...a.models["claude-opus-5-5"], minutesPerTurn: -1 }])
      assert.throws(() => validateAnalytics({ ...value, models: { ...value.models, "claude-opus-5-5": bad } }), /Invalid analytics/);
  } finally { d.remove(); }
});
test("Slopalytics caches successes and failures at most daily", async () => {
  const d = routeScratch();
  try {
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json(report); };
    const path = join(d.path, "slop.json");
    await collectAnalytics(path, now, fetcher); await collectAnalytics(path, now + 1, fetcher);
    assert.equal(calls, 1);
    await collectAnalytics(path, now + 86400000, fetcher); assert.equal(calls, 2);
    const failing: typeof fetch = async () => { calls++; throw new Error("network down"); };
    const missing = join(d.path, "missing.json");
    assert.equal((await collectAnalytics(missing, now, failing)).value, null);
    await collectAnalytics(missing, now + 1, failing); assert.equal(calls, 3);
  } finally { d.remove(); }
});
test("disabled collector never reads credentials or fetches; enabled GET-only sanitizes cache", async () => {
  const d = routeScratch();
  try {
    const credentialFile = join(d.path, "credential.json"), cacheFile = join(d.path, "usage.json");
    const secret = "fixture-access-token";
    const credential = JSON.stringify({ claudeAiOauth: { accessToken: secret, refreshToken: "fixture-refresh", expiresAt: now + 86400000 } });
    const headers: Headers[] = [];
    const fetcher: typeof fetch = async (url, options) => {
      assert.equal(url, CLAUDE_USAGE_URL); assert.equal(options?.method, "GET"); assert.equal(options?.redirect, "error");
      headers.push(new Headers(options.headers));
      return Response.json({ organization_id: "fixture-account", five_hour: { utilization: 20, resets_at: iso(now + 300 * 60000) },
        seven_day: { utilization: 38, resets_at: iso(now + .4 * 7 * 86400000) }, accessToken: secret });
    };
    const options = { enabled: false, credentialFile, cacheFile, now, fetcher };
    assert.equal((await collectClaudeUsage(options)).value, null); assert.equal(headers.length, 0);
    writeFileSync(credentialFile, credential, { mode: 0o600 });
    const before = statSync(credentialFile);
    const first = await collectClaudeUsage({ ...options, enabled: true });
    assert.equal(first.value?.windows[1]?.remainingPercent, 62);
    assert.equal(headers[0]?.get("authorization"), "Bearer " + secret);
    assert.equal(headers[0]?.get("anthropic-beta"), "oauth-2025-04-20");
    assert.equal(readFileSync(credentialFile, "utf8"), credential);
    assert.equal(statSync(credentialFile).mtimeMs, before.mtimeMs);
    const disk = readFileSync(cacheFile, "utf8");
    assert.doesNotMatch(disk, /fixture-access|fixture-refresh|accessToken|authorization/i);
    assert.equal(statSync(cacheFile).mode & 0o777, 0o600);
    await Promise.all(Array.from({ length: 8 }, () => collectClaudeUsage({ ...options, enabled: true, now: now + 1 })));
    assert.equal(headers.length, 1);
    await collectClaudeUsage({ ...options, enabled: true, now: now + CLAUDE_CADENCE_MS });
    assert.equal(headers.length, 2);
  } finally { d.remove(); }
});
test("failure, expired credentials and symlinks never refresh/write/leak; failures are rate-limited", async () => {
  const d = routeScratch();
  try {
    const credentialFile = join(d.path, "credential.json");
    const fixture = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-secret", expiresAt: now + 1000000 } });
    writeFileSync(credentialFile, fixture);
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error("Bearer fixture-secret response"); };
    const options = { enabled: true, credentialFile, cacheFile: join(d.path, "failure.json"), now, fetcher };
    const result = await collectClaudeUsage(options);
    await collectClaudeUsage({ ...options, now: now + 100 });
    assert.equal(calls, 1); assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
    assert.equal(readFileSync(credentialFile, "utf8"), fixture);
    writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-secret", expiresAt: now - 1 } }));
    assert.equal((await collectClaudeUsage({ ...options, cacheFile: join(d.path, "expired.json") })).value, null);
    assert.equal(calls, 1);
    symlinkSync(credentialFile, join(d.path, "link.json"));
    await collectClaudeUsage({ ...options, credentialFile: join(d.path, "link.json"), cacheFile: join(d.path, "link-cache.json") });
    assert.equal(calls, 1);
  } finally { d.remove(); }
});
test("lock contention, stale-lock cleanup, clock regression and changed cache data preserve cadence", async () => {
  const d = routeScratch();
  try {
    const cacheFile = join(d.path, "usage.json"), lock = cacheFile + ".lock";
    writeFileSync(lock, "");
    utimesSync(lock, new Date(now), new Date(now));
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; throw new Error("fixture"); };
    const options = { enabled: true, credentialFile: join(d.path, "missing"), cacheFile, now, fetcher };
    assert.match((await collectClaudeUsage(options)).reason!, /already reserved/);
    utimesSync(lock, new Date(now - 2 * CLAUDE_CADENCE_MS), new Date(now - 2 * CLAUDE_CADENCE_MS));
    assert.match((await collectClaudeUsage(options)).reason!, /already reserved/);
    assert.equal(calls, 0);
    writeFileSync(cacheFile, JSON.stringify({ attemptedAt: now, fetchedAt: {}, value: { obsolete: true } }));
    assert.equal((await collectClaudeUsage({ ...options, now: now - 1000 })).value, null);
    assert.equal((await collectClaudeUsage({ ...options, now: now + 1000 })).value, null);
    assert.equal(calls, 0);
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).attemptedAt, now);
  } finally { d.remove(); }
});
test("new cache concurrency reserves before network, malformed and huge HTTP bodies fail boundedly", async () => {
  const d = routeScratch();
  try {
    const credentialFile = join(d.path, "credential.json");
    writeFileSync(credentialFile, JSON.stringify({ claudeAiOauth: { accessToken: "fixture-secret", expiresAt: now + 1000000 } }));
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++; await new Promise(r => setTimeout(r, 20));
      return Response.json({ organization_id: "fixture-account", five_hour: { utilization: 10, resets_at: iso(now + 3600000) }, seven_day: { utilization: 20, resets_at: iso(now + 86400000) } });
    };
    await Promise.all(Array.from({ length: 10 }, () => collectClaudeUsage({
      enabled: true, credentialFile, cacheFile: join(d.path, "usage.json"), now, fetcher,
    })));
    assert.equal(calls, 1);
    await assert.rejects(getJson("https://example.invalid", {}, async () => new Response("x".repeat(100)), 10), /too large/);
    await assert.rejects(getJson("https://example.invalid", {}, async () => new Response("no", { status: 401 })), /failed/);
  } finally { d.remove(); }
});
