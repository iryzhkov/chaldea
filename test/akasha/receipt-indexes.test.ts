import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventStore, DAY } from "../../src/akasha/store.ts";
import { MAX_ENVELOPE } from "../../src/akasha/schema.ts";
import { scratch, N } from "./helpers.ts";

function retained(store: EventStore, count = 20000, requestHash = "request"): void {
  // Ordinary compact receipts outlive payloads. No outbox or event scan is needed
  // to reproduce the receipt-query defect.
  store.db.prepare(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<?)
    INSERT INTO receipts
    SELECT 'retained-'||i,?,'envelope',
      CASE i%3 WHEN 0 THEN 'visible' WHEN 1 THEN 'tombstone' ELSE 'quarantined' END,
      NULL,'chaldea:agent-a','daily-health','homelab','ordinary','agent-a',?
    FROM n
  `).run(count, requestHash, N + DAY);
  // Keep receipts with distinct profile/project scopes in the reopen fixture.
  store.db.exec(`
    INSERT INTO receipts VALUES
      ('other-project','r','e','visible',NULL,'i','other-service','other','other-source','agent-a',1),
      ('other-profile','r','e','visible',NULL,'i','other','chaldea','other-source','agent-a',1)
  `);
  store.checkpoint();
}

test("index setup accepts the minimum supported WAL budget on initialization and reopen", () => {
  const dir = scratch(), path = join(dir.path, "events.db"), budget = { wal: 4 * MAX_ENVELOPE };
  try {
    const store = new EventStore(path, { initialize: true, budget });
    store.close();
    new EventStore(path, { budget }).close();
  } finally { dir.remove(); }
});

function legacy(store: EventStore): void {
  store.db.exec("DROP INDEX receipts_state_expiry; DROP INDEX receipts_status_scope;");
  store.checkpoint();
}
function snapshot(db: DatabaseSync): unknown {
  const digest = createHash("sha256");
  for (const row of db.prepare("SELECT * FROM receipts ORDER BY event_id").iterate())
    digest.update(JSON.stringify(row) + "\n");
  return {
    receiptDigest: digest.digest("hex"),
    schema: db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY name").all(),
    receipts: db.prepare("SELECT count(*) AS n,sum(length(CAST(request_hash AS BLOB))) AS bytes FROM receipts").get(),
    meta: db.prepare("SELECT * FROM meta ORDER BY name").all(),
    version: db.prepare("PRAGMA user_version").get(),
  };
}

for (const [count, wal, accepts] of [
  [16, 4 * MAX_ENVELOPE, true],
  [4000, 4 * MAX_ENVELOPE, false],
  [20000, 64 * 1024 ** 2, true],
] as const) {
  test(`populated legacy bootstrap: ${count} receipts, WAL ${wal}, accepts=${accepts}`, () => {
    const dir = scratch(), path = join(dir.path, "events.db");
    const store = new EventStore(path, { initialize: true });
    try {
      retained(store, count); legacy(store);
      const before = snapshot(store.db);
      store.close();
      if (accepts) {
        const reopened = new EventStore(path, { budget: { wal } });
        assert.equal(reopened.scalar("SELECT count(*) FROM receipts"), count + 2);
        assert.equal(reopened.scalar("PRAGMA user_version"), 1);
        reopened.close();
      } else {
        assert.throws(() => new EventStore(path, { budget: { wal } }), /wal_capacity/);
        const db = new DatabaseSync(path);
        try { assert.deepEqual(snapshot(db), before); } finally { db.close(); }
      }
    } finally { if (store.db.isOpen) store.close(); dir.remove(); }
  });
}

test("already indexed populated reopen does not reserve build space", () => {
  const dir = scratch(), path = join(dir.path, "events.db");
  const store = new EventStore(path, { initialize: true });
  try {
    retained(store, 4000); store.close();
    const reopened = new EventStore(path, { budget: { wal: 4 * MAX_ENVELOPE } });
    assert.equal(reopened.scalar("SELECT count(*) FROM receipts"), 4002);
    reopened.close();
  } finally { if (store.db.isOpen) store.close(); dir.remove(); }
});

test("bootstrap reserves only the missing index", () => {
  for (const missing of ["receipts_state_expiry", "receipts_status_scope"]) {
    const dir = scratch(), path = join(dir.path, "events.db");
    const store = new EventStore(path, { initialize: true });
    try {
      retained(store, 700);
      store.db.exec("DROP INDEX " + missing); store.checkpoint(); store.close();
      const reopened = new EventStore(path, { budget: { wal: 4 * MAX_ENVELOPE } });
      assert.equal(reopened.scalar("SELECT count(*) FROM receipts"), 702);
      reopened.close();
    } finally { if (store.db.isOpen) store.close(); dir.remove(); }
  }
});

test("bootstrap refuses near main capacity and counts UTF-8 key bytes before DDL", () => {
  for (const longKeys of [false, true]) {
    const dir = scratch(), path = join(dir.path, "events.db");
    const store = new EventStore(path, { initialize: true });
    try {
      retained(store, longKeys ? 32 : 400);
      store.db.prepare("UPDATE receipts SET " + (longKeys ? "source" : "request_hash") + "=? WHERE event_id LIKE 'retained-%'")
        .run(longKeys ? "界".repeat(6000) : "x".repeat(7000));
      legacy(store);
      const before = snapshot(store.db);
      store.close();
      assert.throws(() => new EventStore(path, { budget: longKeys ? { wal: 4 * MAX_ENVELOPE } : { main: 4 * 1024 ** 2 } }),
        longKeys ? /wal_capacity/ : /protected_state_capacity/);
      const db = new DatabaseSync(path);
      try { assert.deepEqual(snapshot(db), before); } finally { db.close(); }
    } finally { if (store.db.isOpen) store.close(); dir.remove(); }
  }
});

test("legacy bootstrap refuses a blocked checkpoint before DDL, then recovers", () => {
  const dir = scratch(), path = join(dir.path, "events.db");
  const store = new EventStore(path, { initialize: true });
  let reader: DatabaseSync | undefined;
  try {
    retained(store, 16); legacy(store);
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    reader = new DatabaseSync(path);
    reader.exec("BEGIN; SELECT * FROM receipts LIMIT 1;");
    store.db.prepare("UPDATE receipts SET request_hash=? WHERE event_id='retained-1'").run("x".repeat(1200000));
    const before = snapshot(store.db);
    assert.throws(() => new EventStore(path, { budget: { wal: 4 * MAX_ENVELOPE } }), /checkpoint_blocked/);
    assert.deepEqual(snapshot(store.db), before);
    reader.exec("ROLLBACK"); reader.close(); reader = undefined;
    store.checkpoint(); store.close();
    new EventStore(path, { budget: { wal: 4 * MAX_ENVELOPE } }).close();
  } finally { reader?.close(); if (store.db.isOpen) store.close(); dir.remove(); }
});

test("bootstrap rejects an incompatible existing index name before DDL", () => {
  const dir = scratch(), path = join(dir.path, "events.db");
  const store = new EventStore(path, { initialize: true });
  try {
    legacy(store);
    store.db.exec("CREATE INDEX receipts_state_expiry ON receipts(expires,state)");
    const before = snapshot(store.db); store.close();
    assert.throws(() => new EventStore(path), /invalid_receipt_index/);
    const db = new DatabaseSync(path);
    try { assert.deepEqual(snapshot(db), before); } finally { db.close(); }
  } finally { if (store.db.isOpen) store.close(); dir.remove(); }
});

test("310k offline index build records WAL inside the transaction", {
  skip: process.env.AKASHA_INDEX_PEAK !== "1",
}, t => {
  const dir = scratch(), path = join(dir.path, "events.db");
  const store = new EventStore(path, { initialize: true });
  let db: DatabaseSync | undefined;
  try {
    // Disk-backed synthetic receipt count and payload size, never a live DB copy.
    retained(store, 309998, "x".repeat(1600)); legacy(store);
    const before = snapshot(store.db);
    const mainBefore = store.scalar("PRAGMA page_count") * 4096;
    store.close();
    assert.throws(() => new EventStore(path), /wal_capacity/);
    db = new DatabaseSync(path);
    assert.deepEqual(snapshot(db), before);
    db.exec("PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=-2048");
    assert.equal(db.prepare("PRAGMA journal_mode").get()!.journal_mode, "wal");
    assert.equal(db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()!.busy, 0);
    const wal = () => { try { return statSync(path + "-wal").size; } catch { return 0; } };
    const samples: { phase: string; bytes: number }[] = [];
    db.exec("BEGIN IMMEDIATE");
    db.exec("CREATE INDEX receipts_state_expiry ON receipts(state,expires)");
    samples.push({ phase: "state index, before commit", bytes: wal() });
    db.exec("CREATE INDEX receipts_status_scope ON receipts(profile,project,source)");
    samples.push({ phase: "both indices, before commit", bytes: wal() });
    assert.ok(samples[1]!.bytes > 4 * MAX_ENVELOPE, "uncommitted build exceeds the supported minimum WAL");
    db.exec("COMMIT");
    samples.push({ phase: "commit, autocheckpoint disabled", bytes: wal() });
    assert.ok(Math.max(...samples.map(s => s.bytes)) < 64 * 1024 ** 2, "fixture fits default WAL for reviewed offline apply");
    t.diagnostic(JSON.stringify({
      receipts: 310000, mainBefore, mainAfter: Number(db.prepare("PRAGMA page_count").get()!.page_count) * 4096,
      samples, synchronous: db.prepare("PRAGMA synchronous").get(), version: db.prepare("PRAGMA user_version").get(),
    }));
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    db.close(); db = undefined;
    // Reviewed offline DDL allows reopening with no bootstrap build charge.
    const reopened = new EventStore(path, { budget: { wal: 4 * MAX_ENVELOPE } });
    assert.equal(reopened.scalar("SELECT count(*) FROM receipts"), 310000);
    reopened.close();
  } finally { db?.close(); if (store.db.isOpen) store.close(); dir.remove(); }
});
