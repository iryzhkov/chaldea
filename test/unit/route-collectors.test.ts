import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync, readFileSync, symlinkSync, statSync, utimesSync } from "node:fs";
import { aggregate, collectAnalytics, validateAnalytics } from "../../src/route/analytics.ts";
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
test("Slopalytics v3 refreshes the real collector cache and keeps exact harness isolation", async () => {
  const d = routeScratch();
  try {
    const payload = { ...report, schemaVersion: 3, metrics: [
      { ...row, tokenTurns: 100, input: 1000, estimatedCost: 1 },
      { ...row, harness: "codex", completed: 1, failed: 99, interrupted: 0 },
    ] };
    const result = await collectAnalytics(join(d.path, "v3.json"), now, async () => Response.json(payload));
    assert.equal(result.reason, null);
    assert.equal(result.value?.models["claude-opus-5-5"]?.turns, 100);
    assert.equal(result.value?.models["claude-opus-5-5"]?.completionRate, .9);
    assert.throws(() => aggregate({ ...payload, schemaVersion: 4 }, iso(now)), /Invalid/);
    assert.throws(() => aggregate({ ...payload, metrics: [{ ...row, terminal: 101 }] }, iso(now)), /Invalid/);
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
