import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { statSync } from "node:fs";
import { createHash } from "node:crypto";
import { EventStore, DAY } from "../../src/akasha/store.ts";
import { DeliveryWorker } from "../../src/akasha/bus.ts";
import { migrate } from "../../src/store/sqlite.ts";
import { hash, MAX_ENVELOPE } from "../../src/akasha/schema.ts";
import { event, scratch, N } from "./helpers.ts";

type Sample = { sql: string; params: SQLInputValue[]; result: number };

function capture(store: EventStore): Sample[] {
  const samples: Sample[] = [], scalar = store.scalar.bind(store);
  store.scalar = (sql, ...params) => {
    const result = scalar(sql, ...params);
    if (/FROM receipts WHERE/.test(sql)) samples.push({ sql, params, result });
    return result;
  };
  return samples;
}

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
  // Neither partial scope may be charged to the status quota.
  store.db.exec(`
    INSERT INTO receipts VALUES
      ('other-project','r','e','visible',NULL,'i','mission-control-publisher','other','agent-a.mission-control','agent-a',1),
      ('other-profile','r','e','visible',NULL,'i','other','chaldea','agent-a.mission-control','agent-a',1)
  `);
  store.checkpoint();
}

function status(i: number, host = "agent-a", now = N) {
  return {
    ...event(i, "agent_status", now), issuer: "chaldea:" + host, host,
    title: "Mission control status", body: "", tags: [],
    source_id: host + "--mission-control", source: host + ".mission-control",
    profile: "mission-control-publisher", project: "chaldea",
    data: { snapshot: {
      schema: "mission-control.host.v1", host, epoch: "a".repeat(32), sequence: i,
      observedAt: now * 1000, connected: true, total: 0, truncated: false, agents: [],
      tokens: { qualified: false, output: null, rate: null, observedAt: null, coverage: "unknown" },
    } },
  };
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

for (const reopenLegacy of [false, true]) {
  test(`receipt hot paths use bounded covering searches on ${reopenLegacy ? "existing" : "fresh"} databases`, async t => {
    const dir = scratch(), path = join(dir.path, "events.db");
    let store = new EventStore(path, { initialize: true });
    try {
      retained(store);
      const version = store.scalar("PRAGMA user_version");
      if (reopenLegacy) {
        // Reconstruct the previous receipt schema without duplicating table DDL.
        const indices = store.db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND tbl_name='receipts' AND sql IS NOT NULL").all();
        for (const { name } of indices) {
          if (name !== "receipts_expiry" && name !== "receipts_feed")
            store.db.exec('DROP INDEX "' + String(name).replaceAll('"', '""') + '"');
        }
        store.close();
        store = new EventStore(path);
        assert.equal(store.scalar("PRAGMA user_version"), version);
        assert.equal(store.scalar("SELECT count(*) FROM receipts"), 20002);
      }
      const samples = capture(store);
      const worker = new DeliveryWorker(store, () => N, async () => ({
        async publish() {}, async fetch() { return []; },
        async firstSequence() { return 1; }, async close() {},
      }));
      // Keep the real pump/query, replacing only the unrelated consumer loop.
      t.mock.method(worker, "consume", async () => {});
      const pump = async () => {
        worker.stopped = false;
        try { await worker.pump(); } finally { await worker.stop(); }
      };
      await pump();
      const empty = samples.filter(s => /min\(expires\)/.test(s.sql));
      assert.equal(empty.length, 1);
      assert.equal(empty[0]!.result, 0);

      const a = status(1), b = status(2, "agent-b");
      store.admit(a, hash(a), N);
      store.admit(b, hash(b), N);
      const counts = () => samples.filter(s => /count\(\*\)/.test(s.sql));
      assert.deepEqual(counts().map(s => s.result), [0, 0, 0, 1]);
      const accepted = store.pending(N).map(p => JSON.parse(p.envelope));
      store.project(accepted[0], 1, N);
      store.project(accepted[1], 2, N);
      assert.deepEqual(counts().map(s => s.result), [0, 0, 0, 1, 1, 2, 1, 2]);
      assert.equal(store.receipt(a.event_id)?.state, "visible");
      assert.equal(store.admit(a, hash(a), N).event_id, a.event_id);
      assert.throws(() => store.admit(a, hash("conflict"), N), /idempotency_conflict/);
      assert.equal(store.scalar("SELECT count(*) FROM events"), 2);

      // Pending records expire later than every unrelated retained receipt.
      const c = status(3, "agent-a", N + 5);
      store.admit(c, hash(c), N + 5);
      await pump();
      const minima = samples.filter(s => /min\(expires\)/.test(s.sql));
      assert.deepEqual(minima.map(s => s.result), [0, N + 5 + DAY]);

      const queries = [...new Map(samples.filter(s => /min\(expires\)|count\(\*\)/.test(s.sql))
        .map(s => [s.sql, s])).values()];
      assert.equal(queries.length, 3, "pump minimum and both actual quota counts must be exercised");
      const plans = queries.map(s => ({
        ...s, detail: store.db.prepare("EXPLAIN QUERY PLAN " + s.sql).all(...s.params).map(r => String(r.detail)).join("; "),
      }));
      t.diagnostic(JSON.stringify(plans));
      for (const plan of plans) {
        assert.match(plan.detail, /SEARCH receipts USING COVERING INDEX/, plan.sql);
        assert.doesNotMatch(plan.detail, /SCAN receipts|TEMP B-TREE/, plan.sql);
        if (/min\(expires\)/.test(plan.sql)) {
          assert.match(plan.detail, /\(state=\?\)/, "minimum must seek pending state rather than traverse all expiries");
        } else {
          assert.match(plan.detail, /profile=\? AND project=\?/, "counts must restrict the complete status scope");
          if (plan.params.length) assert.match(plan.detail, /source=\?/, "source count must seek all three keys");
        }
      }
      // The previous runtime's version guard still accepts this database.
      migrate(store.db, [() => { throw new Error("unexpected migration"); }]);
      assert.equal(store.scalar("PRAGMA user_version"), version);
      store.close();
      store = new EventStore(path);
      assert.equal(store.scalar("PRAGMA user_version"), version);
      assert.equal(store.receipt(c.event_id)?.state, "pending");
      assert.equal(store.scalar("SELECT count(*) FROM receipts"), 20005);
      assert.equal(store.scalar("PRAGMA synchronous"), 2);
    } finally { if (store.db.isOpen) store.close(); dir.remove(); }
  });
}
