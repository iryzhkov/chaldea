import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { statSync } from "node:fs";
import { rig, event, project, N, scratch } from "./helpers.ts";
import { Ingress, operationId } from "../../src/akasha/ingress.ts";
import { Authorization } from "../../src/akasha/auth.ts";
import { EventStore } from "../../src/akasha/store.ts";
import { hash, idempotencyKey, normalize, parse, NEW_FEED_ID } from "../../src/akasha/schema.ts";
import { bridge, parity, reverseExport } from "../../src/akasha/migration/feed.ts";
import { eventPage, feedRows, article } from "../../src/akasha/compat.ts";
import { snapshot } from "../../src/akasha/maintenance.ts";
import { DeliveryWorker } from "../../src/akasha/bus.ts";

test("source registry and strict input validation reject spoofing and telemetry operands", async () => {
  const r = await rig();
  try {
    assert.throws(() => new Authorization([r.r, r.r], r.trust, r.clock), /duplicate/);
    const p = await r.auth.authorize(await r.token(), "append");
    for (const field of ["source", "host", "run_id", "project"]) assert.throws(() =>
      normalize({ v: 1, kind: "report", title: "ok", [field]: "other" }, p.identity, false), /identity_mismatch/);
    assert.throws(() => normalize({ title: "ok", created_at: new Date().toISOString() }, p.identity, true), /unknown_field/);
    for (const value of ["", "x\nx", "x".repeat(257), "é"]) assert.throws(() => idempotencyKey(value));
    assert.throws(() => parse(Buffer.from('{"v":1,"v":1}')), /invalid_json/);
    assert.throws(() => normalize({ v: 2, kind: "report", title: "ok" }, p.identity, false), /unknown_version/);
    assert.throws(() => normalize({ v: 1, kind: "unknown", title: "ok" }, p.identity, false), /unknown_kind/);
    assert.throws(() => normalize({ v: 1, kind: "tool_call", data: { arguments: "secret" } }, p.identity, false), /unknown_field/);
    const tool = { ts: new Date(N * 1000).toISOString(), session: "s", proc: "p", seq: 1, client: "c", tool: "t",
      args: ["path"], outcome: "ok", ok: true, tool_source: "shell", raw_line_hash: "a".repeat(64) };
    assert.equal(normalize({ v: 1, kind: "tool_call", data: tool }, p.identity, false).data.tool_source, "shell");
    assert.throws(() => normalize({ v: 1, kind: "tool_call", body: "raw", data: tool }, p.identity, false), /tool_prose/);
    assert.throws(() => normalize({ v: 1, kind: "tool_call", data: { ...tool, err: "secret operand text" } }, p.identity, false), /error_class/);
    assert.throws(() => normalize({ v: 1, kind: "report", title: "t", tags: Array(33).fill("a") }, p.identity, false));
    assert.throws(() => normalize({ v: 1, kind: "report", title: "t", data: { arbitrary: "no" } }, p.identity, false));
  } finally { r.close(); }
});

test("report bearer is append-only, resource/audience bound; package C rechecks rotation, expiry, clocks and restart", async () => {
  const r = await rig();
  try {
    await assert.rejects(r.auth.authorize(await r.token(), "read"));
    await assert.rejects(r.auth.authorize(await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] }), "read"), /append_only/);
    await assert.rejects(r.auth.authorize(await r.token({ aud: "feed" }), "append"));
    await assert.rejects(r.auth.authorize(await r.token({ source: "other" }), "append"));
    await assert.rejects(r.auth.authorize(await r.token({ host: "agent-b" }), "append"));
    const p = await r.auth.authorize(await r.token(), "append");
    r.sample = { ...r.sample, healthy: false }; await assert.rejects(p.recheck());
    r.sample = { ...r.sample, healthy: true, offsetSeconds: 31 }; await assert.rejects(p.recheck());
    r.sample = { ...r.sample, offsetSeconds: 0, unixSeconds: N - 1 }; await assert.rejects(p.recheck());
    r.sample = { ...r.sample, unixSeconds: N, monotonicSeconds: 200 }; await assert.rejects(p.recheck());
    r.sample = { ...r.sample, unixSeconds: N, monotonicSeconds: 100 };
    await r.install({ ...r.bundle, sequence: 2, keys: [] });
    await assert.rejects(p.recheck()); r.restart();
    await assert.rejects(r.install(r.bundle), /rollback/);
    await assert.rejects(r.install({ ...r.bundle, sequence: 3 }), /reactivation/);
  } finally { r.close(); }
});

test("receipt admission survives restart, token refresh; report identity includes run and service identity does not", async () => {
  for (const mode of ["report", "service"] as const) {
    const r = await rig(mode);
    try {
      let ingress = new Ingress(r.auth, r.store, () => {}, { waitMs: 0 });
      let p = await r.auth.authorize(await r.token(), "append");
      const payload = { v: 1, kind: "report", title: "ok", data: {} };
      const first = await ingress.append(p, payload, "daily-report", false);
      assert.equal(first.state, "pending");
      await assert.rejects(ingress.append(p, { ...payload, title: "changed" }, "daily-report", false), /idempotency_conflict/);
      r.restart(); ingress = new Ingress(r.auth, r.store, () => {}, { waitMs: 0 });
      p = await r.auth.authorize(await r.token({ run_id: "run-2", jti: "bcdefghijklmnopqrstuvwx" }), "append");
      const again = await ingress.append(p, payload, "daily-report", false);
      assert.equal(first.event_id === again.event_id, mode === "service");
      project(r.store);
      assert.equal(r.store.scalar("SELECT count(*) FROM events"), mode === "service" ? 1 : 2);
      const found = await ingress.lookup(p, "report", "daily-report");
      assert.equal(found.state, "visible");
      const other = { ...p, scope: { ...p.scope, source: "other" } };
      assert.equal(r.store.ownedReceipt(found.event_id, other.scope), undefined);
      const pendingEvent = event(900);
      r.store.admit(pendingEvent, hash("h"), N);
      r.sample = { ...r.sample, unixSeconds: N + 301, monotonicSeconds: 401 };
      await assert.rejects(ingress.append(p, payload, "expired", false));
      assert.equal(r.store.receipt(operationId(p, "report", "expired")), undefined);
      // Accepted intents complete even though the original caller is now expired.
      project(r.store, N + 301);
      assert.equal(r.store.receipt(pendingEvent.event_id)?.state, "visible");
    } finally { r.close(); }
  }
});

test("SQLite projection commit/ACK ordering, duplicate delivery and poison quarantine", async () => {
  const r = await rig("operator");
  try {
    const e = event(1); r.store.admit(e, hash("h"), N); const pending = r.store.pending(N)[0]!;
    const worker = new DeliveryWorker(r.store, () => N, async () => { throw new Error("offline"); });
    let ack = 0, nak = 0, term = 0;
    const m = { data: Buffer.from(pending.envelope), subject: "akasha." + e.source_id + "." + e.kind, seq: 1, deliveryCount: 1,
      ack() { assert.equal(r.store.receipt(e.event_id)?.state, "visible"); ack++; },
      nak() { nak++; }, term() { term++; } };
    worker.handle(m); worker.handle(m);
    assert.equal(ack, 2); assert.equal(r.store.scalar("SELECT count(*) FROM events"), 1);
    worker.handle({ ...m, data: Buffer.from("{}"), seq: 2 }); assert.equal(term, 1);
    const original = r.store.project.bind(r.store);
    r.store.project = () => { throw new Error("SQLITE_FULL"); };
    worker.handle({ ...m, seq: 3, deliveryCount: 10 });
    assert.equal(nak, 1); assert.equal(r.store.alarm, "delivery_exhausted_replay_required");
    r.store.project = original;
    assert.equal(r.store.scalar("SELECT count(*) FROM quarantine"), 1);
    assert.equal(r.store.cursor("nats"), 2);
  } finally { r.close(); }
});

test("retention/tombstones, exact tags/LIKE filters, scoped cursors and consistent restore", async () => {
  const r = await rig("operator");
  try {
    const p = await r.auth.authorize(await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] }), "read");
    for (let i = 0; i < 3; i++) {
      const e = event(i); e.tags = i === 0 ? ["abc"] : ["abc-more"]; e.body = "Hello SQL wildcard";
      r.store.admit(e, hash("h" + i), N);
    }
    project(r.store);
    assert.equal([...feedRows(r.store, new URLSearchParams("tag=abc"), p.scope, N)].length, 1);
    assert.equal([...feedRows(r.store, new URLSearchParams("grep=H_llo%wildcard"), p.scope, N)].length, 3);
    assert.equal([...feedRows(r.store, new URLSearchParams("host=other"), p.scope, N)].length, 0);
    assert.equal([...feedRows(r.store, new URLSearchParams("limit=0"), p.scope, N)].length, 0);
    assert.throws(() => [...feedRows(r.store, new URLSearchParams("limit=-1"), p.scope, N)]);
    const q = new URLSearchParams("limit=1"), page = eventPage(r.store, q, p.scope, N); assert.equal([...page.rows].length, 1);
    q.set("cursor", page.next()!); const second = eventPage(r.store, q, p.scope, N); assert.equal([...second.rows].length, 1);
    assert.throws(() => eventPage(r.store, q, { ...p.scope, global: false, source: "other" }, N));
    const backup = join(r.dir.path, "backup.db"); await snapshot(r.store, backup);
    const restored = new EventStore(backup);
    assert.equal(restored.scalar("SELECT count(*) FROM events"), 3);
    assert.equal(restored.cursor("nats"), 3); restored.close();
    r.store.db.prepare("UPDATE events SET expiry=?").run(N - 1);
    r.store.prune(N);
    assert.equal(r.store.scalar("SELECT count(*) FROM events"), 0);
    assert.equal(r.store.receipt(event(0).event_id)?.state, "tombstone");
    assert.throws(() => eventPage(r.store, q, p.scope, N), /cursor_expired/);
    r.store.admit(event(0), hash("h0"), N); assert.equal(r.store.pending(N).length, 0);
    assert.equal(statSync(join(r.dir.path, "events.db")).mode & 0o077, 0);
  } finally { r.close(); }
});

test("bounded outbox and WAL starvation refuse admission without dropping pending intent", () => {
  const dir = scratch();
  try {
    const store = new EventStore(join(dir.path, "events.db"), { initialize: true, budget: { outbox: 1000, wal: 4 * 1024 ** 2, main: 4 * 1024 ** 2 } });
    const e = event(1); store.admit(e, hash("h"), N);
    assert.throws(() => store.admit(event(2), hash("h2"), N), /outbox_capacity/);
    assert.equal(store.receipt(e.event_id)?.state, "pending"); assert.equal(store.receipt(event(2).event_id), undefined);
    const reader = new DatabaseSync(store.path); reader.exec("BEGIN"); reader.prepare("SELECT count(*) FROM receipts").get();
    let failed = false;
    for (let n = 0; n < 100; n++) {
      try { store.transaction(() => store.put("churn", String(n % 10).repeat(64 * 1024)), 64 * 1024); }
      catch { failed = true; break; }
    }
    assert.equal(failed, true); assert.ok(store.walBytes() <= store.budget.wal);
    reader.exec("ROLLBACK"); reader.close(); store.checkpoint();
    assert.equal(store.receipt(e.event_id)?.state, "pending"); store.close();
  } finally { dir.remove(); }
});

test("read-only import/bridge exact legacy IDs, content parity, restart and reverse export", async () => {
  const r = await rig("operator");
  try {
    const source = join(r.dir.path, "old.db"), old = new DatabaseSync(source);
    old.exec("CREATE TABLE entries(id INTEGER PRIMARY KEY,created_at TEXT,host TEXT,source TEXT,severity TEXT,title TEXT,body TEXT,tags TEXT,link TEXT)");
    const stamp = new Date(N * 1000).toISOString();
    for (let i = 1; i <= 100; i++) old.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)").run(i, stamp, "old host", "old.source", "warn", "legacy " + i, "body", "abc,def", "https://example.com");
    old.close();
    assert.equal(bridge(r.store, source, N, 50).admitted, 50); r.restart();
    assert.equal(bridge(r.store, source, N).admitted, 50); assert.equal(bridge(r.store, source, N).admitted, 0);
    project(r.store);
    assert.deepEqual(parity(r.store, source, N), { compared: 100, missing: 0, extra: 0, changed: 0, differences: [], rejected: 0, rejects: [] });
    const p = await r.auth.authorize(await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] }), "read");
    assert.equal(r.store.feed(1, { ...p.scope, global: false }), undefined);
    assert.equal(r.store.feed(1, p.scope)?.host, "old host");
    const e = event(200); r.store.admit(e, hash("new"), N); project(r.store);
    const out = join(r.dir.path, "export.db"); assert.equal(reverseExport(r.store, out), 1);
    const exported = new DatabaseSync(out, { readOnly: true });
    assert.equal((exported.prepare("SELECT id FROM entries").get() as { id: number }).id, NEW_FEED_ID);
    exported.close();
    assert.throws(() => reverseExport(r.store, out));
    const html = article({ id: 1, created_at: stamp, host: "<script>", source: "source", severity: "fail",
      title: "<img onerror=alert(1)>", body: "<script>secret</script>", tags: "tag", link: "javascript:alert(1)" });
    assert.ok(!html.includes("<script>") && !html.includes("href=") && html.includes("&lt;img"));
  } finally { r.close(); }
});
