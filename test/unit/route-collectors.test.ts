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
    assert.throws(() => aggregate({ ...payload, schemaVersion: 5 }, iso(now)), /Invalid/);
    assert.throws(() => aggregate({ ...payload, metrics: [{ ...row, terminal: 101 }] }, iso(now)), /Invalid/);
  } finally { d.remove(); }
});
test("Slopalytics v4 tolerates one-turn outcome rounding and keeps rates bounded", async () => {
  const d = routeScratch();
  try {
    // Shapes seen in the live v4 dataset: outcome sums one above and one below terminal.
    const payload = { ...report, schemaVersion: 4, metrics: [
      { ...row, terminal: 99, tokenTurns: 99, subagents: 0, estimatedCost: 1 },
      { ...row, terminal: 101 },
      { ...row, model: "Fable 5.2", terminal: 1, completed: 1, failed: 1, interrupted: 0, timedTurns: 1 },
    ] };
    const result = await collectAnalytics(join(d.path, "v4.json"), now, async () => Response.json(payload));
    assert.equal(result.reason, null);
    assert.equal(result.value?.models["claude-opus-5-5"]?.turns, 200);
    assert.equal(result.value?.models["claude-opus-5-5"]?.completionRate, .9);
    assert.equal(result.value?.models["claude-fable-5-2"]?.completionRate, .5);
    assert.throws(() => aggregate({ ...payload, metrics: [{ ...row, terminal: 102 }] }, iso(now)), /Invalid/);
    assert.throws(() => aggregate({ ...payload, schemaVersion: 3, metrics: [{ ...row, terminal: 99 }] }, iso(now)), /Invalid/);
    // Rounding cannot make one outcome exceed terminal: a phantom failure must not inflate rates.
    const zero = { ...row, terminal: 0, completed: 0, failed: 1, interrupted: 0, timedTurns: 0, durationMs: 0 };
    for (const bad of [zero, { ...zero, failed: 0, completed: 1 }, { ...zero, failed: 0, interrupted: 1 },
      { ...row, terminal: 5, completed: 0, failed: 6, interrupted: 0, timedTurns: 0 },
      { ...row, terminal: 5, completed: 6, failed: 0, interrupted: 0, timedTurns: 5 }])
      assert.throws(() => aggregate({ ...payload, metrics: [row, bad] }, iso(now)), /Invalid Slopalytics metrics/);
    const phantom = await collectAnalytics(join(d.path, "phantom.json"), now, async () =>
      Response.json({ ...payload, metrics: [row, ...Array(30).fill(zero)] }));
    assert.equal(phantom.value, null);
    assert.match(phantom.reason ?? "", /^invalid_metrics; no successful cache/);
    const healthy = aggregate({ ...payload, metrics: [row, { ...row, terminal: 0, completed: 0, failed: 0, interrupted: 0, timedTurns: 0, durationMs: 0 }] }, iso(now));
    assert.equal(healthy.models["claude-opus-5-5"]?.failedRate, .06);
  } finally { d.remove(); }
});
test("Slopalytics failures persist only fixed diagnostic categories", async () => {
  const d = routeScratch();
  try {
    const cases: Array<[string, typeof fetch]> = [
      ["unsupported_schema", async () => Response.json({ ...report, schemaVersion: 5 })],
      ["invalid_metrics", async () => Response.json({ ...report, metrics: [{ ...row, failed: 100 }] })],
      ["invalid_metrics", async () => Response.json({ ...report, start: "secret-token-in-body" })],
      ["fetch_failed", async () => { throw new Error("network down https://user:secret@example.invalid"); }],
      ["fetch_failed", async () => new Response("secret-token-in-body", { status: 500 })],
      ["fetch_failed", async () => new Response("not json secret-token-in-body")],
      ["oversized_response", async () => new Response("x".repeat(2 * 1024 * 1024 + 1))],
    ];
    for (const [i, [reason, fetcher]] of cases.entries()) {
      const path = join(d.path, "diag-" + i + ".json");
      const result = await collectAnalytics(path, now, fetcher);
      assert.equal(result.value, null);
      assert.equal(result.reason, reason + "; no successful cache; retry at " + iso(now + 86400000));
      const disk = readFileSync(path, "utf8");
      assert.equal(JSON.parse(disk).failureReason, reason);
      assert.doesNotMatch(disk, /secret|network|example/);
      // A later read inside the reservation reports the same category without fetching.
      assert.equal((await collectAnalytics(path, now + 1, async () => { throw new Error("must not fetch"); })).reason, result.reason);
    }
    // Retained last-good data keeps its age next to the new category.
    const path = join(d.path, "retained.json");
    await collectAnalytics(path, now, async () => Response.json(report));
    const later = await collectAnalytics(path, now + 86400000, async () => Response.json({ ...report, schemaVersion: 5 }));
    assert.match(later.reason ?? "", /^unsupported_schema; retained last successful cache, age 86400s; retry at /);
    assert.ok(later.value?.models["claude-opus-5-5"]);
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
