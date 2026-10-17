import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { rig, event, project, N } from "./helpers.ts";
import { hash, canonical, HttpError } from "../../src/akasha/schema.ts";
import { maintain, snapshot } from "../../src/akasha/maintenance.ts";
import { bridge, parity } from "../../src/akasha/migration/feed.ts";
import { DeliveryWorker } from "../../src/akasha/bus.ts";
import { Ingress } from "../../src/akasha/ingress.ts";


test("SIGKILL before/after SQLite admission and projection commits preserves exactly the durable work", async () => {
  const r = await rig();
  try {
    const { spawn } = await import("node:child_process"), { once } = await import("node:events");
    const crash = async (mode: string, value: unknown) => {
      const child = spawn(process.execPath, ["test/akasha/crash-child.ts", r.store.path, mode, String(N)],
        { stdio: ["pipe", "ignore", "pipe"], env: { ...process.env, HOME: r.dir.path, TMPDIR: r.dir.path } });
      child.stdin.end(JSON.stringify(value));
      let err = ""; child.stderr.on("data", b => { err += b; });
      const [, signal] = await once(child, "close"); assert.equal(signal, "SIGKILL", err);
    };
    const before = event(1); await crash("before-admit", before);
    assert.equal(r.store.receipt(before.event_id), undefined);
    const after = event(2); await crash("after-admit", after);
    assert.equal(r.store.receipt(after.event_id)?.state, "pending");
    const accepted = JSON.parse(r.store.pending(N)[0]!.envelope);
    await crash("before-project", accepted);
    assert.equal(r.store.receipt(after.event_id)?.state, "pending"); assert.equal(r.store.scalar("SELECT count(*) FROM events"), 0);
    await crash("after-project", accepted);
    assert.equal(r.store.receipt(after.event_id)?.state, "visible"); assert.equal(r.store.pending(N).length, 0);
    r.store.project(accepted, 1, N); assert.equal(r.store.scalar("SELECT count(*) FROM events"), 1);
  } finally { r.close(); }
});

test("ingress source bucket enforces burst 100 and rejects before another receipt is created", async () => {
  const r = await rig();
  try {
    const p = await r.auth.authorize(await r.token(), "append"), ingress = new Ingress(r.auth, r.store, () => {});
    for (let i = 0; i < 100; i++) ingress.rate(p);
    assert.throws(() => ingress.rate(p), /rate_limit/); assert.equal(r.store.scalar("SELECT count(*) FROM receipts"), 0);
  } finally { r.close(); }
});


test("prune selection stays index-ordered for expiry and pressure", async () => {
  const r = await rig();
  try {
    const plans = [
      r.store.db.prepare("EXPLAIN QUERY PLAN SELECT seq,event_id FROM events WHERE expiry<=? ORDER BY expiry,seq LIMIT 10").all(N),
      r.store.db.prepare("EXPLAIN QUERY PLAN SELECT seq,event_id FROM events ORDER BY received_at,seq LIMIT 10").all(),
    ];
    assert.ok(JSON.stringify(plans[0]).includes("events_expiry")); assert.ok(JSON.stringify(plans[1]).includes("events_received"));
    assert.ok(!JSON.stringify(plans).includes("TEMP B-TREE"));
  } finally { r.close(); }
});

test("maintenance catches up more than 100 expired events AND receipts, yielding between batches", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 121; i++) r.store.admit(event(i), hash(i), N);
    project(r.store); r.store.db.prepare("UPDATE events SET expiry=?").run(N - 1);
    r.store.db.prepare("UPDATE receipts SET expires=?").run(N - 1);
    let yielded = false; setImmediate(() => { yielded = true; });
    await maintain(r.store, N);
    assert.equal(yielded, true); assert.equal(r.store.scalar("SELECT count(*) FROM events"), 0);
    assert.equal(r.store.scalar("SELECT count(*) FROM receipts"), 0);
  } finally { r.close(); }
});

test("future producer timestamps cannot pin tool retention past 90 days after server admission", async () => {
  const r = await rig();
  try {
    const e = event(1, "tool_call"); e.title = ""; e.body = ""; e.tags = [];
    e.occurred_at = "2999-01-01T00:00:00.000Z";
    e.data = { ts: e.occurred_at, session: "s", proc: "p", seq: 1, client: "c", tool: "t", args: ["?"],
      outcome: "ok", ok: true, tool_source: "shell", raw_line_hash: "a".repeat(64) };
    r.store.admit(e, hash("future"), N); project(r.store);
    assert.equal(r.store.scalar("SELECT expiry FROM events"), N + 90 * 86400);
    await maintain(r.store, N + 90 * 86400);
    assert.equal(r.store.receipt(e.event_id)?.state, "tombstone");
  } finally { r.close(); }
});

test("complete broker schema, registry and allocator checks quarantine poison; own poison becomes terminal", async () => {
  const r = await rig();
  try {
    const e = event(1), worker = new DeliveryWorker(r.store, () => N, async () => { throw new Error("offline"); }, e => r.auth.validateDelivery(e));
    let term = 0, nak = 0;
    const deliver = (value: unknown, seq: number) => worker.handle({ data: Buffer.from(canonical(value)),
      subject: "akasha." + e.source_id + "." + e.kind, seq, deliveryCount: 1, ack() {}, nak() { nak++; }, term() { term++; } });
    const missing = { ...e } as Record<string, unknown>; delete missing.data;
    r.store.admit(missing as never, hash("poison"), N);
    // Admission supplies a feed ID/provenance; emulate corrupted accepted intent exactly.
    const ownPoison = JSON.parse(r.store.pending(N)[0]!.envelope);
    deliver(ownPoison, 1); assert.equal(term, 1); assert.equal(nak, 0);
    assert.equal(r.store.receipt(e.event_id)?.state, "quarantined"); assert.equal(r.store.pending(N).length, 0);
    const forged = event(2); forged.source = "other"; forged.provenance = { type: "verified", request_hash: hash("forged"), feed_id: 1_000_000_000_001 };
    deliver(forged, 2); assert.equal(term, 2);
    const jump = event(3); jump.provenance = { type: "verified", request_hash: hash("jump"), feed_id: Number.MAX_SAFE_INTEGER - 1 };
    deliver(jump, 3); assert.equal(term, 3); assert.equal(Number(r.store.get("feed_next")), 1_000_000_000_001);
    assert.equal(r.store.scalar("SELECT count(*) FROM events"), 0);
  } finally { r.close(); }
});

test("import preserves parseable non-ISO dates; invalid rows advance a durable explicit reject cursor", async () => {
  const r = await rig();
  try {
    const file = join(r.dir.path, "legacy.db"), db = new DatabaseSync(file);
    db.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,created_at TEXT,host TEXT,source TEXT,severity TEXT,title TEXT,body TEXT,tags TEXT,link TEXT)");
    const insert = (id: number, time: string) => db.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)").run(id, time, "host", "source", "info", "title", "body", "", "");
    insert(1, new Date(N * 1000).toISOString().replace("T", " ").replace("Z", ""));
    insert(2, "this is not a timestamp"); insert(3, new Date(N * 1000).toISOString()); db.close();
    assert.deepEqual(bridge(r.store, file, N), { scanned: 3, admitted: 2, rejected: 1, cursor: 3 });
    project(r.store);
    const result = parity(r.store, file, N); assert.equal(result.rejected, 1); assert.equal(result.rejects[0]?.id, 2);
    assert.equal(result.changed, 0); assert.equal(result.missing, 1);
    assert.equal(r.store.scalar("SELECT count(*) FROM events"), 2); assert.equal(bridge(r.store, file, N).scanned, 0);
  } finally { r.close(); }
});

test("contiguous stream cursor keeps holes and durable gaps across restart", async () => {
  const r = await rig();
  try {
    const a = event(1), b = event(2); r.store.admit(a, hash(1), N); r.store.admit(b, hash(2), N);
    const p = r.store.pending(N);
    r.store.project(JSON.parse(p[1]!.envelope), 2, N); assert.equal(r.store.cursor("nats"), 0);
    r.store.project(JSON.parse(p[0]!.envelope), 1, N); assert.equal(r.store.cursor("nats"), 2);
    r.store.recordGap(3, 8); r.restart();
    assert.deepEqual(r.store.health().first_gap, { from: 3, to: 8 }); assert.equal(r.store.cursor("nats"), 8);
  } finally { r.close(); }
});

test("admission commit guard rolls back an expiry detected after synchronous storage work", async () => {
  const r = await rig("service");
  try {
    const p = await r.auth.authorize(await r.token(), "append");
    let guards = 0;
    p.checkCommit = () => { if (++guards === 2) throw new HttpError(401, "expired"); };
    const ingress = new Ingress(r.auth, r.store, () => {}, { waitMs: 0 });
    await assert.rejects(ingress.append(p, { v: 1, kind: "report", title: "expire at commit" }, "key", false), /expired/);
    assert.equal(r.store.scalar("SELECT count(*) FROM receipts"), 0); assert.equal(r.store.pending(N).length, 0);
  } finally { r.close(); }
});

test("consistent single-step backup completes while another connection writes", async () => {
  const r = await rig();
  try {
    for (let i = 0; i < 5; i++) r.store.admit(event(i), hash(i), N);
    project(r.store);
    const writer = new DatabaseSync(r.store.path);
    const timer = setInterval(() => writer.prepare("UPDATE meta SET value=value WHERE name='epoch'").run(), 1);
    try { await snapshot(r.store, join(r.dir.path, "backup.db")); }
    finally { clearInterval(timer); writer.close(); }
    const check = new DatabaseSync(join(r.dir.path, "backup.db"), { readOnly: true });
    assert.equal((check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok"); check.close();
  } finally { r.close(); }
});
