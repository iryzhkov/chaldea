import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { chmodSync, existsSync, linkSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { collectScores, fetchScores, publishScores, readAAKey } from "../../src/route/snapshot.ts";
import { scoreSnapshot, validateScores, MODEL_MAP } from "../../src/route/scores.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { catalog, scores, now, iso } from "../fixtures/route/targets.ts";
import { recommend } from "../../src/route/policy.ts";
import { readJson } from "../../src/route/cache.ts";

const config = { enabled: true, url: "https://akasha.fixture", tokenHelper: "/fixture/helper", host: "homelab" };
const row = { slug: MODEL_MAP[0]!.aaSlug, evaluations: { artificial_analysis_intelligence_index: 50, artificial_analysis_coding_index: 60 },
  pricing: { price_1m_input_tokens: 2, price_1m_output_tokens: 10 }, secret_extra: "must-not-publish" };
const response = (data: unknown, page = 1, more = false) => new Response(JSON.stringify({
  tier: "free", intelligence_index_version: 4.3, data,
  pagination: { page, page_size: 200, total_pages: more ? page + 1 : page, has_more: more },
}));
test("AA collector uses a fixed HTTPS API, header key, bounded pagination and public allowlist", async () => {
  const calls: string[] = [];
  const s = await fetchScores(now, async (url, init) => {
    calls.push(String(url));
    assert.match(String(url), /^https:\/\/artificialanalysis.ai\/api\/v2\/language\/models\/free\?page=/);
    assert.equal((init?.headers as Record<string,string>)["x-api-key"], "fixture-key");
    assert.equal(init?.redirect, "error");
    return calls.length === 1 ? response([row], 1, true) : response([{ slug: "new-unmapped" }, { ...row, slug: MODEL_MAP[1]!.aaSlug, pricing: {} }], 2);
  }, () => "fixture-key");
  assert.equal(calls.length, 2); assert.equal(s.models[0]!.coding, 60); assert.equal(s.indexVersion, "4.3");
  assert.deepEqual(s.unmapped, ["new-unmapped", MODEL_MAP[1]!.aaSlug]);
  assert.doesNotMatch(JSON.stringify(s), /fixture-key|secret_extra|must-not-publish/);
  await assert.rejects(fetchScores(now, async () => { throw new Error("fixture-key leaked upstream"); }, () => "fixture-key"),
    e => String(e) === "Error: aa_fetch_failed");
  await assert.rejects(fetchScores(now, async () => response([row], 1, true), () => "fixture-key"), /aa_fetch_failed/);
});
test("v2 publisher preserves nullable coding and measured task cost through the existing API", async () => {
  const scratch = routeScratch();
  try {
    const rich = { ...row, evaluations: { ...row.evaluations, artificial_analysis_coding_index: null },
      artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: .123 } } };
    const result = await publishScores({ ...config, formatVersion: 2 }, join(scratch.path, "v2.json"), now, {
      machine: "homelab", keyReader: () => "fixture-key", token: async () => "fixture-token",
      fetch: async (_, init) => {
        if (init?.method === "GET") return response([rich]);
        const payload = JSON.parse(String(init?.body));
        assert.equal(payload.data.scores.version, 2);
        assert.equal(payload.data.scores.models[0].coding, null);
        assert.equal(payload.data.scores.models[0].benchmarkCostUSDPerTask, .123);
        return Response.json({ state: "visible", event_id: "a".repeat(64) }, { status: 201 });
      },
    });
    assert.equal(result.version, 2);
  } finally { scratch.remove(); }
});
test("incomplete or wrong-index refresh retains an older complete benchmark snapshot and its age", async () => {
  const scratch = routeScratch();
  try {
    const old = { ...scores, version: 2 as const, metric: "aa-intelligence-cost-per-task" as const,
      fetchedAt: iso(now - 120 * 86400000),
      models: scores.models.map(s => ({ ...s, coding: null, benchmarkCostUSDPerTask: .5 })) };
    const path = join(scratch.path, "complete.json");
    writeFileSync(path, JSON.stringify({ attemptedAt: now - 86400000, fetchedAt: old.fetchedAt, value: old }), { mode: 0o600 });
    const partial = { ...old, fetchedAt: iso(now), models: old.models.filter(s => s.model !== "gpt-6.1-sol") };
    const event = (s: unknown) => ({ source: "route", host: "homelab", kind: "route_score_snapshot",
      provenance: { type: "verified" }, data: { scores: s } });
    const r = await collectScores(config, path, now,
      async () => Response.json({ events: [event(partial), event({ ...old, indexVersion: "5", fetchedAt: iso(now) })], next_cursor: null }),
      async () => "fixture-token",
      s => s.version === 2 && s.indexVersion === "4.3" && s.models.some(m => m.model === "gpt-6.1-sol"));
    assert.deepEqual(r.value, old);
    assert.equal(r.fetchedAt, old.fetchedAt);
    assert.match(r.reason!, /retained last successful cache/);
  } finally { scratch.remove(); }
});
test("unmapped diagnostics stay within the snapshot publication budget", () => {
  const s = scoreSnapshot({ intelligence_index_version: 4.3,
    data: [row, ...Array.from({ length: 500 }, (_, n) => ({ slug: "unknown-" + n + "-" + "a".repeat(140) }))] }, now);
  assert.ok(Buffer.byteLength(JSON.stringify(s)) < 16384);
  assert.match(s.unmapped.at(-1)!, /unmapped-models-omitted/);
});
test("AA key reader refuses symlinks, permissive files, hardlinks and oversized files", () => {
  const scratch = routeScratch();
  try {
    const path = join(scratch.path, "fixture-key");
    writeFileSync(path, "fake-fixture-key", { mode: 0o600 });
    if (process.geteuid!() === 0) assert.equal(readAAKey(path), "fake-fixture-key");
    else assert.throws(() => readAAKey(path), /invalid_aa_key_file/);
    chmodSync(path, 0o644); assert.throws(() => readAAKey(path)); chmodSync(path, 0o600);
    const sym = join(scratch.path, "symlink"); symlinkSync(path, sym); assert.throws(() => readAAKey(sym));
    const hard = join(scratch.path, "hardlink"); linkSync(path, hard); assert.throws(() => readAAKey(hard));
    const big = join(scratch.path, "big"); writeFileSync(big, "a".repeat(4097), { mode: 0o600 }); assert.throws(() => readAAKey(big));
  } finally { scratch.remove(); }
});
test("homelab publisher caches one daily fetch and retries the same idempotent publication", async () => {
  const scratch = routeScratch();
  try {
    const path = join(scratch.path, "fetch.json"), keys: string[] = [];
    let reads = 0, gets = 0, posts = 0;
    const options = { machine: "homelab", keyReader: () => { reads++; return "fixture-key"; },
      token: async () => "fixture-access-token", fetch: async (url: any, init: any) => {
        if (init.method === "GET") { gets++; return response([row]); }
        assert.doesNotMatch(String(init.body), /fixture-key|secret_extra/);
        posts++; keys.push(init.headers["Idempotency-Key"]);
        return new Response(JSON.stringify({ state: posts === 1 ? "pending" : "visible", event_id: "a".repeat(64) }), { status: posts === 1 ? 202 : 201 });
      } };
    await assert.rejects(publishScores(config, path, now, { ...options, machine: "agent-a" }), /homelab_only/);
    assert.equal(reads, 0);
    await assert.rejects(publishScores(config, path, now, options), /publication_pending/);
    await publishScores(config, path, now + 60000, options);
    assert.equal(reads, 1); assert.equal(gets, 1); assert.equal(keys[0], keys[1]);
    const last = readJson(path);
    await assert.rejects(publishScores(config, path, now + 86400000, { ...options,
      fetch: async () => { throw new Error("fixture failure"); } }), /last_good_retained/);
    assert.deepEqual((readJson(path) as any).value, (last as any).value);
  } finally { scratch.remove(); }
});
test("daily fetch follows UTC dates despite randomized timer jitter", async () => {
  const scratch = routeScratch();
  try {
    let gets = 0;
    const options = { machine: "homelab", keyReader: () => "fixture-key", token: async () => "fixture-token",
      fetch: async (_: any, init: any) => {
        if (init.method === "GET") { gets++; return response([row]); }
        return new Response(JSON.stringify({ state: "visible", event_id: "a".repeat(64) }), { status: 201 });
      } };
    const first = Date.parse("2026-10-17T04:14:00Z"), next = Date.parse("2026-10-18T04:01:00Z");
    await publishScores(config, join(scratch.path, "daily.json"), first, options);
    await publishScores(config, join(scratch.path, "daily.json"), next, options);
    assert.equal(gets, 2);
  } finally { scratch.remove(); }
});

test("disabled score transport reads last good without helpers, requests, reservations or writes", async () => {
  const scratch = routeScratch();
  try {
    const path = join(scratch.path, "scores.json"), disabled = { ...config, enabled: false };
    let requests = 0, helpers = 0;
    const fetcher: typeof fetch = async () => { requests++; throw new Error("disabled transport fetched"); };
    const token = async () => { helpers++; throw new Error("disabled transport read credentials"); };
    const missing = await collectScores(disabled, path, now, fetcher, token);
    assert.deepEqual(missing, { value: null, fetchedAt: null, reason: "snapshot transport disabled" });
    assert.equal(existsSync(path), false); assert.equal(existsSync(path + ".lock"), false);
    const old = { ...scores, fetchedAt: iso(now - 10 * 86400000) };
    const disk = JSON.stringify({ attemptedAt: now - 900001, fetchedAt: iso(now - 86400000), value: old,
      failureReason: "collection_failed", retryAt: now + 86400000 });
    writeFileSync(path, disk, { mode: 0o600 });
    writeFileSync(path + ".lock", "");
    const before = statSync(path), lockBefore = statSync(path + ".lock");
    assert.deepEqual(await collectScores(disabled, path, now, fetcher, token),
      { value: old, fetchedAt: iso(now - 86400000), reason: "snapshot transport disabled" });
    const pick = recommend({ role: "builder" }, { catalog, quota: {}, analytics: null, scores: old, now });
    assert.equal(pick.dataAges.artificialAnalysis, 10 * 86400);
    assert.match(pick.reasons.join(" "), /AA snapshot stale; use last good/);
    assert.equal(readFileSync(path, "utf8"), disk); assert.equal(statSync(path).mtimeMs, before.mtimeMs);
    assert.equal(statSync(path + ".lock").mtimeMs, lockBefore.mtimeMs);
    for (const value of [null, { ...old, fetchedAt: "invalid" }]) {
      writeFileSync(path, JSON.stringify({ attemptedAt: now, fetchedAt: iso(now), value }), { mode: 0o600 });
      assert.equal((await collectScores(disabled, path, now, fetcher, token)).value, null);
    }
    assert.equal(helpers, 0); assert.equal(requests, 0);
  } finally { scratch.remove(); }
});
test("authenticated readers accept only verified homelab route scores and preserve last good on failure", async () => {
  const scratch = routeScratch();
  try {
    const path = join(scratch.path, "scores.json"); let tokenReads = 0;
    const token = async (_: string, event: any, action: string | undefined) => {
      tokenReads++; assert.equal(event.source, "route"); assert.equal(action, "read"); return "fixture-token";
    };
    const event = { source: "route", host: "homelab", kind: "route_score_snapshot", provenance: { type: "verified" }, data: { scores } };
    const first = await collectScores(config, path, now, async (url, init) => {
      assert.equal(new URL(String(url)).searchParams.get("host"), "homelab");
      assert.equal(new URL(String(url)).searchParams.get("from"), iso(now - 90 * 86400000));
      assert.equal((init?.headers as Record<string,string>).authorization, "Bearer fixture-token");
      return new Response(JSON.stringify({ events: [
        { ...event, data: { scores: { ...scores, fetchedAt: iso(now + 1000) } } },
        { ...event, host: "attacker" }, { ...event, provenance: { type: "legacy-feed" } }, event,
      ], next_cursor: null }));
    }, token);
    assert.deepEqual(first.value, scores);
    const second = await collectScores(config, path, now + 900001, async () => { throw new Error("offline"); }, token);
    assert.deepEqual(second.value, scores); assert.match(second.reason!, /retained/);
    const older = await collectScores(config, path, now + 1800002, async () =>
      new Response(JSON.stringify({ events: [{ ...event, data: { scores: { ...scores, fetchedAt: iso(now - 86400000) } } }], next_cursor: null })), token);
    assert.deepEqual(older.value, scores);
    assert.equal(tokenReads, 3);
    assert.throws(() => validateScores({ ...scores, key: "forbidden" }));
    assert.throws(() => validateScores({ ...scores, models: [{ ...scores.models[0], effort: "max" }] }));
  } finally { scratch.remove(); }
});
