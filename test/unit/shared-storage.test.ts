import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { atomicWrite } from "../../src/fs/atomic.ts";
import { migrate, tx, meta } from "../../src/store/sqlite.ts";
import { Outbox, sqliteOutbox, recoverOutbox } from "../../src/store/outbox.ts";
import { backoff, sleep } from "../../src/retry.ts";
import { AccessState } from "../../src/access/trust.ts";
import { scratchDir } from "../helpers/scratch.ts";

test("atomic replacement ignores predictable temp symlinks, syncs complete bytes and cleans failed publications", () => {
  const s = scratchDir("atomic");
  try {
    const path = join(s.path, "state"), victim = join(s.path, "victim");
    writeFileSync(victim, "untouched");
    for (const suffix of [".tmp", ".new"]) symlinkSync(victim, path + suffix);
    atomicWrite(path, "first"); atomicWrite(path, Buffer.from("second"));
    assert.equal(readFileSync(path, "utf8"), "second");
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(readFileSync(victim, "utf8"), "untouched");
    const directory = join(s.path, "directory"); mkdirSync(directory);
    assert.throws(() => atomicWrite(directory, "cannot replace directory"));
    assert.equal(readdirSync(s.path).some(p => p.startsWith(".chaldea-")), false);
    atomicWrite(path, "public", 0o644);
    assert.equal(statSync(path).mode & 0o777, 0o644);
  } finally { s.remove(); }
});
test("migrations commit schema and user_version together, retain legacy metadata, refuse future versions", () => {
  const s = scratchDir("sqlite"), path = join(s.path, "state.sqlite");
  let db = new DatabaseSync(path);
  try {
    db.exec("CREATE TABLE meta(name TEXT PRIMARY KEY,value TEXT NOT NULL)");
    meta(db).put("format", "legacy");
    assert.throws(() => migrate(db, [() => { db.exec("CREATE TABLE partial(value)"); throw new Error("interrupted"); }]), /interrupted/);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='partial'").get(), undefined);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 0);
    migrate(db, [() => { assert.equal(meta(db).get("format"), "legacy"); db.exec("CREATE TABLE durable(value)"); }]);
    db.close(); db = new DatabaseSync(path);
    migrate(db, [() => { throw new Error("must not rerun"); }]);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 1);
    assert.equal(meta(db).get("format"), "legacy");
    assert.throws(() => tx(db, () => { meta(db).put("format", "lost"); throw new Error("rollback"); }), /rollback/);
    assert.equal(meta(db).get("format"), "legacy");
    db.exec("PRAGMA user_version=2");
    assert.throws(() => migrate(db, [() => {}]), /unsupported_database_version/);
    assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 2);
  } finally { db.close(); s.remove(); }
});
test("legacy access adoption never repairs a missing format marker", () => {
  const s = scratchDir("adopt"), path = join(s.path, "state.sqlite");
  const state = new AccessState(path, { initialize: true });
  try {
    state.db.exec("PRAGMA user_version=0");
    state.put("revocation", "retained"); state.close();
    const reopened = new AccessState(path);
    assert.equal(reopened.get("revocation"), "retained");
    reopened.db.exec("PRAGMA user_version=0; DELETE FROM access_meta WHERE name='format'");
    reopened.close();
    assert.throws(() => new AccessState(path), /invalid_state_format/);
    const db = new DatabaseSync(path);
    try { assert.equal(db.prepare("PRAGMA user_version").get()!.user_version, 0); }
    finally { db.close(); }
  } finally { s.remove(); }
});
test("resend retains original payload after a lost acknowledgement across reopen", async () => {
  const s = scratchDir("outbox"), path = join(s.path, "outbox.sqlite");
  let db = new DatabaseSync(path);
  const queue = () => new Outbox(sqliteOutbox(db, {
    table: "pending", key: "key", columns: ["key", "payload"],
    encode: (r: { key: string; payload: string }) => [r.key, r.payload],
    decode: r => ({ key: String(r.key), payload: String(r.payload) }),
  }), "resend");
  try {
    db.exec("CREATE TABLE pending(key TEXT PRIMARY KEY,payload TEXT NOT NULL)");
    let outbox = queue(); outbox.enqueue("stable", { key: "stable", payload: "original" });
    assert.equal(outbox.enqueue("stable", { key: "stable", payload: "changed" }), false);
    const seen: string[] = [];
    const send = async (r: { payload: string }) => { seen.push(r.payload); return true; };
    await assert.rejects(outbox.deliver("stable", send, () => { throw new Error("lost ack"); }), /lost ack/);
    db.close(); db = new DatabaseSync(path); outbox = queue();
    await outbox.deliver("stable", send, () => {});
    assert.deepEqual(seen, ["original", "original"]); assert.equal(outbox.size, 0);
  } finally { db.close(); s.remove(); }
});
test("dedupe requires a durable claim before send and never replays an ambiguous attempt", async () => {
  const rows = new Map<string, string>(), queue = new Outbox(rows, "dedupe");
  queue.enqueue("once", "payload");
  let sends = 0;
  const send = async () => { sends++; throw new Error("lost response"); };
  assert.equal(await queue.deliver("once", send, () => false), false);
  assert.equal(sends, 0); assert.equal(queue.size, 1);
  await assert.rejects(queue.deliver("once", send, () => {}), /lost response/);
  assert.equal(queue.size, 0);
  assert.equal(await queue.deliver("once", send, () => {}), false); assert.equal(sends, 1);
});
test("restart recovery preserves immutable payloads and terminal states for both ambiguity policies", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE outbox(state TEXT,payload TEXT,attempts INTEGER); INSERT INTO outbox VALUES('sending','original',2),('blocked','blocked',1),('sent','sent',1)");
    recoverOutbox(db, "resend");
    assert.deepEqual(db.prepare("SELECT * FROM outbox ORDER BY rowid").all().map(r => [r.state,r.payload,r.attempts]),
      [["pending","original",2],["blocked","blocked",1],["sent","sent",1]]);
    db.exec("UPDATE outbox SET state='sending' WHERE state='pending'");
    recoverOutbox(db, "dedupe");
    assert.equal(db.prepare("SELECT state FROM outbox WHERE payload='original'").get()!.state, "uncertain");
  } finally { db.close(); }
});
test("retry jitter respects caller caps, tables and aborts without leaving a timer", async () => {
  assert.equal(backoff(0, undefined, () => 0), 125);
  assert.equal(backoff(100, undefined, () => 1), 30_000);
  assert.equal(backoff(1, { base: 1, cap: 60, delays: [1000, 5000] }, () => 0), 2500);
  const controller = new AbortController();
  const waiting = sleep(60_000, controller.signal); controller.abort(); await waiting;
  await sleep(60_000, controller.signal);
});
