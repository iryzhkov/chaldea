import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { EventStore, DAY } from "../../src/akasha/store.ts";
import { hash, MAX_ENVELOPE } from "../../src/akasha/schema.ts";
import { event, scratch, N, project } from "./helpers.ts";

// Keep the selected receipts far apart in the table, event-id autoindex and
// scope index. Contiguous compact rows miss the prune reservation undercount.
function spread(store: EventStore): number {
  const insert = store.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  store.db.exec("BEGIN IMMEDIATE");
  for (let i = 0; i < 24000; i++) {
    const key = hash(i), expired = i % 239 === 0;
    insert.run(key, hash("request" + i), hash("envelope" + i),
      expired ? (i % 2 ? "tombstone" : "quarantined") : "visible",
      i + 1, "chaldea:agent-a", hash("profile" + i).repeat(3),
      hash("project" + i).repeat(3), hash("source" + i).repeat(3), "agent-a",
      expired ? N - 1 : N + DAY);
  }
  store.db.exec("COMMIT");
  store.checkpoint();
  return store.scalar("SELECT count(*) FROM receipts WHERE expires<?", N);
}

function observe(store: EventStore) {
  const samples: { phase: string; bytes: number }[] = [];
  const prepare = store.db.prepare.bind(store.db), exec = store.db.exec.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql), run = statement.run.bind(statement);
    statement.run = (...params) => {
      const result = Reflect.apply(run, statement, params);
      if (/^(DELETE|UPDATE|INSERT)/i.test(sql.trim())) samples.push({ phase: sql.split(" ")[0]!, bytes: store.walBytes() });
      return result;
    };
    return statement;
  };
  store.db.exec = sql => {
    exec(sql);
    if (/COMMIT|incremental_vacuum/i.test(sql)) samples.push({ phase: sql, bytes: store.walBytes() });
  };
  return samples;
}

test("spread receipt prune stays inside minimum WAL during writes/commit and makes progress", t => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  try {
    const count = spread(store);
    store.admit(event(90000), hash("pending"), N);
    store.checkpoint();
    store.budget.wal = 4 * MAX_ENVELOPE;
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    const samples = observe(store);
    let removed = 0, rounds = 0;
    do {
      const progress = store.prune(N);
      assert.ok(progress > 0 && progress <= 200, "bounded cleanup must make progress");
      removed += progress;
      assert.ok(++rounds <= count, "one or more expired receipts per call");
    } while (removed < count);
    const peak = Math.max(...samples.map(s => s.bytes));
    t.diagnostic(JSON.stringify({ count, rounds, peak, wal: store.budget.wal }));
    assert.ok(samples.some(s => /COMMIT/i.test(s.phase)), "sample commit before prune's final checkpoint");
    assert.ok(peak < store.budget.wal, "prune WAL peak " + peak + " exceeds budget " + store.budget.wal);
    assert.equal(removed, count);
    assert.equal(store.scalar("SELECT count(*) FROM receipts WHERE state='visible'"), 24000 - count);
    assert.equal(store.receipt(event(90000).event_id)?.state, "pending");
    assert.equal(store.pending(N).length, 1);
    assert.equal(store.scalar("PRAGMA user_version"), 1);
    assert.equal(store.scalar("PRAGMA synchronous"), 2);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { store.close(); dir.remove(); }
});

test("blocked reader refuses spread prune before any row writes and resumes after release", () => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  let reader: DatabaseSync | undefined;
  try {
    const count = spread(store);
    store.budget.wal = 4 * MAX_ENVELOPE;
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    reader = new DatabaseSync(store.path);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM receipts").get();
    // Synthetic setup only: leave less than the fixed guard headroom free.
    for (let i = 0; store.walBytes() < store.budget.wal - 128 * 1024; i++)
      store.put("churn", String(i % 10).repeat(16 * 1024));
    assert.ok(store.walBytes() < store.budget.wal);
    const samples = observe(store), before = store.walBytes();
    assert.throws(() => store.prune(N), /checkpoint_blocked|wal_capacity/);
    assert.equal(samples.length, 0, "reservation must refuse before prune writes");
    assert.equal(store.walBytes(), before);
    assert.equal(store.scalar("SELECT count(*) FROM receipts WHERE expires<?", N), count);
    reader.exec("ROLLBACK"); reader.close(); reader = undefined;
    store.checkpoint();
    assert.ok(store.prune(N) > 0);
  } finally { reader?.close(); store.close(); dir.remove(); }
});


test("blocked reader prevents event tombstoning, cascades and floor writes", () => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  let reader: DatabaseSync | undefined;
  try {
    store.admit(event(80000), hash("event"), N); project(store);
    store.admit(event(80001), hash("pending"), N);
    store.db.prepare("UPDATE events SET expiry=?").run(N - 1);
    store.checkpoint();
    store.budget.wal = 4 * MAX_ENVELOPE;
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    reader = new DatabaseSync(store.path);
    reader.exec("BEGIN");
    reader.prepare("SELECT count(*) FROM events").get();
    for (let i = 0; store.walBytes() < store.budget.wal - 128 * 1024; i++)
      store.put("churn", String(i % 10).repeat(16 * 1024));
    const before = store.walBytes(), floor = store.get("floor"), cursor = store.cursor("nats");
    const spill = store.scalar("PRAGMA cache_spill"), samples = observe(store);
    assert.throws(() => store.prune(N), /checkpoint_blocked|wal_capacity/);
    assert.equal(samples.length, 0);
    assert.equal(store.walBytes(), before);
    assert.equal(store.scalar("PRAGMA cache_spill"), spill);
    assert.equal(store.receipt(event(80000).event_id)?.state, "visible");
    assert.equal(store.scalar("SELECT count(*) FROM events"), 1);
    assert.equal(store.scalar("SELECT count(*) FROM feed_entries"), 1);
    assert.equal(store.scalar("SELECT count(*) FROM event_tags"), 1);
    assert.equal(store.get("floor"), floor);
    assert.equal(store.cursor("nats"), cursor);
    assert.equal(store.pending(N).length, 1);
    reader.exec("ROLLBACK"); reader.close(); reader = undefined;
    assert.equal(store.prune(N), 1);
    assert.equal(store.receipt(event(80000).event_id)?.state, "tombstone");
    assert.ok(Math.max(...samples.map(s => s.bytes)) < store.budget.wal);
  } finally { reader?.close(); store.close(); dir.remove(); }
});

for (const mode of ["expiry", "pressure"] as const) {
  test("large tagged event prune reserves cascades at minimum WAL: " + mode, t => {
    const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
    try {
      // Real admission/projection creates all feed and tag index entries.
      for (let i = 0; i < 24; i++) {
        const e = event(100000 + i);
        e.body = "b".repeat(256 * 1024);
        e.tags = Array.from({ length: 32 }, (_, tag) => hash(i + ":" + tag).slice(0, 48));
        store.admit(e, hash("large" + i), N); project(store);
      }
      store.admit(event(99999), hash("pending"), N);
      if (mode === "expiry") store.db.prepare("UPDATE events SET expiry=?").run(N - 1);
      else {
        const used = (store.scalar("PRAGMA page_count") - store.scalar("PRAGMA freelist_count")) * 4096;
        store.budget.main = Math.ceil(used / 0.86 / 4096) * 4096;
      }
      store.checkpoint();
      store.budget.wal = 4 * MAX_ENVELOPE;
      store.db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=8");
      const spill = store.scalar("PRAGMA cache_spill"), samples = observe(store);
      let calls = 0, removed = 0;
      while (store.scalar("SELECT count(*) FROM events") && calls++ < 24) {
        const progress = store.prune(N);
        if (mode === "pressure" && progress === 0) break;
        assert.ok(progress > 0 && progress <= 100, "bounded event cleanup makes progress");
        removed += progress;
        assert.equal(store.scalar("PRAGMA cache_spill"), spill);
      }
      const peak = Math.max(...samples.map(s => s.bytes));
      t.diagnostic(JSON.stringify({ mode, calls, removed, peak, wal: store.budget.wal }));
      assert.ok(removed > 0);
      if (mode === "expiry") {
        assert.equal(removed, 24);
        assert.equal(store.scalar("SELECT count(*) FROM feed_entries"), 0);
        assert.equal(store.scalar("SELECT count(*) FROM event_tags"), 0);
        assert.equal(store.scalar("SELECT count(*) FROM receipts WHERE state='tombstone'"), 24);
        assert.equal(Number(store.get("floor")), 24);
      }
      assert.ok(peak < store.budget.wal, "event/cascade WAL peak " + peak);
      assert.equal(store.receipt(event(99999).event_id)?.state, "pending");
      assert.equal(store.pending(N).length, 1);
      assert.equal(store.scalar("SELECT count(*) FROM receipts"), 25);
      assert.equal(store.cursor("nats"), 24);
      assert.ok(store.scalar("PRAGMA page_count") * 4096 <= store.budget.main);
      assert.ok(store.scalar("SELECT coalesce(sum(bytes),0) FROM outbox") <= store.budget.outbox);
      assert.ok(store.scalar("SELECT coalesce(sum(bytes),0) FROM quarantine") <= store.budget.quarantine);
      assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    } finally { store.close(); dir.remove(); }
  });
}
