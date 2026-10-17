import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, appendFileSync, utimesSync, statSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { collect, toolPayload } from "../../src/events/collector.ts";
import { Outbox, STATE_BYTES } from "../../src/events/outbox.ts";
import { publish, helperToken, type Publication } from "../../src/events/publisher.ts";
import { EventSink } from "../../src/quota/run.ts";
import { emptyState, loadState } from "../../src/quota/state.ts";
import { quotaKey } from "../../src/feed/poster.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
import { scratchDir } from "../helpers/scratch.ts";
const record = { ts: "2026-10-17T00:00:00Z", host: "agent-a", session: "s", proc: "p", seq: 1,
  client: "codex", tool: "feed post", args: ["severity"], outcome: "ok", ok: true, ms: 3 };
const line = () => JSON.stringify(record) + "\n";
function fixture() {
  const scratch = scratchDir("events"), spool = join(scratch.path, "spool"), path = join(spool, "feed", "agent-a-day.jsonl");
  mkdirSync(join(spool, "feed"), { recursive: true }); writeFileSync(path, line());
  const state = join(scratch.path, "collector.db");
  return { ...scratch, spool, path, state };
}
test("response loss and restart retry the identical generation/file/offset; identical calls stay distinct", async () => {
  const f = fixture(), seen: Publication[] = []; let db = new Outbox(f.state);
  try {
    appendFileSync(f.path, line()); let up = false;
    const deliver = async (e: Publication) => { seen.push(e); return up; };
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    assert.equal(db.cursor("tool/feed/agent-a-day.jsonl"), null);
    db.close(); db = new Outbox(f.state); up = true;
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    assert.deepEqual(seen[0], seen[1]); assert.notEqual(seen[1]!.key, seen[2]!.key);
    assert.equal(db.cursor("tool/feed/agent-a-day.jsonl")!.offset, Buffer.byteLength(line()) * 2);
    assert.equal(db.next(), null);
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    assert.equal(seen.length, 3);
  } finally { db.close(); f.remove(); }
});
test("torn lines wait, replacement and truncation create fresh logical generations", async () => {
  const f = fixture(), db = new Outbox(f.state), seen: Publication[] = [];
  const deliver = async (e: Publication) => { seen.push(e); return true; };
  try {
    writeFileSync(f.path, line().trimEnd()); await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    assert.equal(seen.length, 0);
    appendFileSync(f.path, "\n"); await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    renameSync(f.path, f.path + ".old"); writeFileSync(f.path, line());
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    writeFileSync(f.path, JSON.stringify({ ...record, seq: 2 }) + "\n");
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver });
    assert.equal(new Set(seen.map(e => e.key)).size, 3);
  } finally { db.close(); f.remove(); }
});
test("spool retention runs while delivery is down, counts only unqueued complete lines", async () => {
  const f = fixture(), db = new Outbox(f.state);
  try {
    appendFileSync(f.path, line());
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver: async () => false });
    const old = new Date(Date.now() - 91 * 86400_000); utimesSync(f.path, old, old);
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver: async () => false });
    assert.equal(existsSync(f.path), false); assert.equal(db.counters().expired_unshipped, 1);
    assert.ok(db.next(), "durable intent survives raw spool prune");
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver: async () => true });
    assert.equal(db.next(), null);
  } finally { db.close(); f.remove(); }
});
test("tool input is allowlisted, another host is counted and skipped; no operands or free-form errors", async () => {
  const raw = { ...record, secret: "SECRET", output: "SECRET", root: "/private", err: "Error: SECRET /private" };
  const payload = toolPayload(raw, Buffer.from(JSON.stringify(raw)), "feed", "agent-a");
  const data = payload.data as Record<string, unknown>;
  assert.match(String(data.err), /^fingerprint\//); assert.equal(data.root, undefined); assert.ok(!JSON.stringify(payload).includes("SECRET"));
  const f = fixture(), db = new Outbox(f.state);
  try {
    writeFileSync(f.path, JSON.stringify({ ...record, host: "agent-b" }) + "\n" + line());
    const seen: Publication[] = [];
    await collect({ spool: f.spool, host: "agent-a", outbox: db, deliver: async e => { seen.push(e); return true; } });
    assert.equal(seen.length, 1); assert.equal(db.counters().rejected, 1);
  } finally { db.close(); f.remove(); }
});
test("outbox physically caps the database and refuses new admission without evicting pending data", () => {
  const f = fixture(), db = new Outbox(f.state);
  const c = { generation: "g", dev: "1", ino: "1", offset: 1, prefix: "", prefixLength: 0, tail: "" };
  try {
    let admitted = 0;
    for (let i = 0; i < 1000; i++) {
      if (!db.admit({ key: "k" + i, source: "s", host: "h", payload: { body: "a".repeat(60000) } }, "f" + i, c)) break;
      admitted++;
    }
    assert.ok(admitted > 100 && admitted < 1000); assert.ok(statSync(f.state).size <= STATE_BYTES);
    assert.equal(db.next()!.event.key, "k0"); assert.ok(db.counters().capacity! > 0);
  } finally { db.close(); f.remove(); }
});
test("helper absence and all HTTP errors retain intents; no shared-key fallback; leases refresh on retry", async () => {
  const e: Publication = { key: "job/invocation", source: "agent-a.fleet", host: "agent-a", payload: { v: 1, kind: "job_finished" } };
  process.env.FEED_TOKEN = "SHARED-DO-NOT-USE";
  try {
    let calls = 0, tokens = 0;
    assert.equal(await publish(e, { url: "https://akasha.example", helper: "/missing/helper", fetch: async () => { calls++; throw Error(); } }), false);
    assert.equal(calls, 0);
    for (const status of [401, 403, 409, 429, 503, 201]) {
      const ok = await publish(e, { url: "https://akasha.example", token: async () => "lease-" + ++tokens,
        fetch: async (_u, init) => {
          calls++; assert.equal((init!.headers as Record<string, string>)["Idempotency-Key"], e.key);
          assert.equal((init!.headers as Record<string, string>).authorization, "Bearer lease-" + tokens);
          return new Response(JSON.stringify({ event_id: "a".repeat(64), state: status === 503 ? "pending" : "visible" }), { status });
        } });
      assert.equal(ok, status === 201);
    }
    assert.equal(calls, 6); assert.equal(tokens, 6);
  } finally { delete process.env.FEED_TOKEN; }
});
test("quota crash after atomic claim save but before enqueue recovers the original pending payload", () => {
  const f = scratchDir("quota-atomic"), path = join(f.path, "state.json"), state = emptyState();
  const record: QuotaRecord = { kind: "quota_reset_unknown", threadId: "t", runId: "r", provider: "codex", severity: "warn", resetAt: null, subagent: false };
  const logger = { info() {}, warn() {}, error() {} };
  try {
    state.posted.set("quota_reset_unknown|t|r", Date.now());
    const first = new EventSink(state, path, { enqueue() { throw Error("crash"); } }, logger);
    first.record([record]); assert.throws(() => first.save(), /crash/);
    const restored = loadState(path, Date.now()); assert.deepEqual(restored.pendingDelivery.get(quotaKey(record)), record);
    let delivered = 0;
    const second = new EventSink(restored, path, { enqueue(r, ack) { assert.deepEqual(r, record); delivered++; ack?.(); } }, logger);
    second.save(); assert.equal(delivered, 1); assert.equal(loadState(path, Date.now()).pendingDelivery.size, 0);
    second.close();
  } finally { f.remove(); }
});
