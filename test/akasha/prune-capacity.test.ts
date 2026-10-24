import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { EventStore, DAY } from "../../src/akasha/store.ts";
import { hash, canonical, MAX_ENVELOPE } from "../../src/akasha/schema.ts";
import { event, scratch, N, project } from "./helpers.ts";
import { eventPage, feedRows } from "../../src/akasha/compat.ts";

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


for (const wal of [4 * MAX_ENVELOPE, 3 * 1024 ** 2]) {
  test("large tag trees make full bounded prune progress at WAL " + wal, t => {
    const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
    try {
      const count = 300;
      for (let i = 0; i < count; i++) {
        const e = event(200000 + i);
        e.tags = Array.from({ length: 32 }, (_, tag) => hash(i + ":" + tag).slice(0, 48));
        store.admit(e, hash("tag-tree" + i), N); project(store);
      }
      const trees = store.db.prepare("SELECT name,count(*) AS pages FROM dbstat WHERE name IN ('event_tags','sqlite_autoindex_event_tags_1') GROUP BY name").all();
      assert.equal(trees.length, 2);
      assert.ok(trees.every(tree => Number(tree.pages) > 64), "both tag trees must exceed the metadata walk");
      store.admit(event(199999), hash("pending"), N);
      store.db.prepare("UPDATE events SET expiry=?").run(N - 1);
      store.checkpoint();
      store.budget.wal = wal;
      store.db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=8");
      const spill = store.scalar("PRAGMA cache_spill"), samples = observe(store);
      let calls = 0, removed = 0;
      while (store.scalar("SELECT count(*) FROM events")) {
        const progress = store.prune(N);
        assert.ok(progress > 0 && progress <= 100, "every call must make bounded progress");
        removed += progress;
        assert.ok(++calls <= count);
        assert.equal(store.scalar("PRAGMA cache_spill"), spill);
      }
      const peak = Math.max(...samples.map(sample => sample.bytes));
      t.diagnostic(JSON.stringify({ wal, trees, calls, removed, peak }));
      assert.ok(samples.some(sample => /COMMIT/i.test(sample.phase)));
      assert.ok(peak < wal, "write/commit WAL peak " + peak + " exceeds " + wal);
      assert.equal(removed, count);
      assert.equal(store.scalar("SELECT count(*) FROM event_tags"), 0);
      assert.equal(store.scalar("SELECT count(*) FROM feed_entries"), 0);
      assert.equal(store.scalar("SELECT count(*) FROM receipts WHERE state='tombstone'"), count);
      assert.equal(store.receipt(event(199999).event_id)?.state, "pending");
      assert.equal(store.pending(N).length, 1);
      assert.equal(store.cursor("nats"), count);
      assert.equal(Number(store.get("floor")), count);
      assert.equal(store.scalar("PRAGMA user_version"), 1);
      assert.equal(store.scalar("PRAGMA synchronous"), 2);
      assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
      assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
    } finally { store.close(); dir.remove(); }
  });
}


test("refusal after tag commit preserves visible state and resumes after reopen", () => {
  const dir = scratch();
  let store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  let reader: DatabaseSync | undefined;
  try {
    const e = event(81000);
    e.tags = Array.from({ length: 32 }, (_, i) => "tag-" + i);
    store.admit(e, hash("event"), N); project(store);
    store.admit(event(81001), hash("retained"), N); project(store);
    store.admit(event(81002), hash("pending"), N);
    store.db.prepare("UPDATE events SET expiry=? WHERE event_id=?").run(N - 1, e.event_id);
    store.checkpoint();
    store.budget.wal = 4 * MAX_ENVELOPE;
    store.db.exec("PRAGMA wal_autocheckpoint=0");
    const scope = { issuer: e.issuer, profile: e.profile, project: e.project, source: e.source, host: e.host, global: false };
    const visible = () => {
      const page = eventPage(store, new URLSearchParams("limit=1"), scope, N);
      const rows = [...page.rows], cursor = page.next();
      return { rows, cursor,
        rest: [...eventPage(store, new URLSearchParams({ limit: "1", cursor: cursor! }), scope, N).rows],
        feed: store.feed(store.receipt(e.event_id)!.feed_id!, scope),
        filtered: [...feedRows(store, new URLSearchParams("tag=tag-0&host=" + e.host), scope, N)],
        receipt: store.receipt(e.event_id), pending: store.pending(N),
        floor: store.get("floor"), nats: store.cursor("nats"),
        events: store.db.prepare("SELECT * FROM events ORDER BY seq").all(),
        feeds: store.db.prepare("SELECT * FROM feed_entries ORDER BY id").all(),
        receipts: store.db.prepare("SELECT * FROM receipts ORDER BY event_id").all(),
      };
    };
    const before = visible(), spill = store.scalar("PRAGMA cache_spill");
    assert.equal(before.rows[0]!.event_id, e.event_id);
    assert.deepEqual(before.rows[0]!.tags, e.tags);
    assert.equal(before.filtered.length, 1);
    const exec = store.db.exec.bind(store.db);
    let interrupted = false;
    store.db.exec = sql => {
      exec(sql);
      if (sql === "COMMIT" && !interrupted &&
          store.scalar("SELECT count(*) FROM event_tags WHERE event_id=?", e.event_id) === 0) {
        interrupted = true;
        reader = new DatabaseSync(store.path);
        reader.exec("BEGIN");
        reader.prepare("SELECT count(*) FROM events").get();
        // Make the next reservation checkpoint after the final tag commit.
        store.budget.wal = store.walBytes() + 128 * 1024 + 1;
      }
    };
    assert.throws(() => store.prune(N), /checkpoint_blocked/);
    assert.ok(interrupted);
    assert.equal(store.scalar("SELECT count(*) FROM event_tags WHERE event_id=?", e.event_id), 0);
    assert.equal(store.scalar("SELECT count(*) FROM event_tags"), 1, "retained event's tag stays");
    assert.deepEqual(visible(), before);
    assert.equal(store.scalar("PRAGMA cache_spill"), spill);
    assert.ok(reader);
    reader.exec("ROLLBACK"); reader.close(); reader = undefined;
    store.close();
    store = new EventStore(join(dir.path, "events.db"));
    store.budget.wal = 4 * MAX_ENVELOPE;
    assert.deepEqual(visible(), before, "partial tag cleanup survives reopen invisibly");
    assert.equal(store.prune(N), 1);
    assert.equal(store.receipt(e.event_id)?.state, "tombstone");
    assert.equal(store.scalar("SELECT count(*) FROM events"), 1);
    assert.equal(store.scalar("SELECT count(*) FROM feed_entries"), 1);
    assert.equal(store.pending(N).length, 1);
    assert.equal(Number(store.get("floor")), 1);
    assert.equal(store.cursor("nats"), before.nats);
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(store.db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { reader?.close(); store.close(); dir.remove(); }
});

test("prune tag lookup and delete use the existing primary key without a tag-table scan", t => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  try {
    store.admit(event(82000), hash("event"), N); project(store);
    store.db.prepare("UPDATE events SET expiry=?").run(N - 1);
    const prepare = store.db.prepare.bind(store.db), sqls = new Set<string>();
    store.db.prepare = sql => {
      if (sql.startsWith("SELECT t.tag,t.event_id") || sql.startsWith("DELETE FROM event_tags")) sqls.add(sql);
      return prepare(sql);
    };
    assert.equal(store.prune(N), 1);
    assert.equal(sqls.size, 2);
    for (const sql of sqls) {
      const lookup = sql.startsWith("SELECT");
      const plan = prepare("EXPLAIN QUERY PLAN " + sql).all(...(lookup ? [1] : ["test", event(82000).event_id]));
      const details = plan.map(row => String(row.detail)).join("\n");
      t.diagnostic(details);
      assert.match(details, /SEARCH (?:t|event_tags) USING (?:COVERING )?INDEX sqlite_autoindex_event_tags_1 \(tag=\? AND event_id=\?\)/);
      assert.doesNotMatch(details, /SCAN (?:t|event_tags)(?:\s|$)/);
    }
  } finally { store.close(); dir.remove(); }
});


test("deep 30k-event database makes bounded prune progress at 3 MiB", { skip: process.env.AKASHA_PRUNE_STRESS !== "1" }, t => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  try {
    // Opt-in layout probe: direct fixture seeding avoids 30k admission cycles.
    // Keep the production v1 schema and all receipt/event/feed/tag index entries.
    const total = 30000, expired = 40, db = store.db;
    const receipt = db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)");
    const insert = db.prepare("INSERT INTO events(event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry,session,tool,client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const tagRow = db.prepare("INSERT INTO event_tags VALUES(?,?)");
    const feed = db.prepare("INSERT INTO feed_entries VALUES(?,?,?,?,?,?,?,?,?,?)");
    db.exec("BEGIN IMMEDIATE");
    for (let i = 0; i < total; i++) {
      const e = event(300000 + i, "feed_post", N - total + i);
      e.tags = Array.from({ length: i < expired ? 32 : 2 }, (_, tag) => hash("deep" + i + ":" + tag).slice(0, 48));
      e.provenance = { type: "verified", request_hash: hash("rq" + i), feed_id: i + 1 };
      receipt.run(e.event_id, hash("rq" + i), hash(e), "visible", i + 1, e.issuer, e.profile, e.project, e.source, e.host, N + 180 * DAY);
      insert.run(e.event_id, canonical(e), e.issuer, e.profile, e.project, e.source, e.host, e.kind, e.received_at, e.occurred_at,
        i < expired ? N - 1 : N + 180 * DAY, "", "", "");
      for (const tag of e.tags) tagRow.run(e.event_id, tag);
      feed.run(i + 1, e.event_id, e.received_at, e.host, e.source, e.severity, e.title, e.body, e.tags.join(","), e.link);
    }
    store.setCursor("nats", total);
    db.exec("COMMIT");
    store.admit(event(299999), hash("pending-deep"), N);
    store.checkpoint();
    const pages = store.scalar("PRAGMA page_count");
    const layout = db.prepare("SELECT name,count(*) AS pages,max(length(path)-length(replace(path,'/',''))) AS depth FROM dbstat GROUP BY name").all();
    assert.ok(layout.some(tree => Number(tree.depth) >= 3));
    assert.ok(pages * 4096 > 80 * 1024 ** 2);
    store.budget.wal = 3 * 1024 ** 2;
    db.exec("PRAGMA wal_autocheckpoint=0; PRAGMA cache_size=8");
    const spill = store.scalar("PRAGMA cache_spill"), samples = observe(store);
    let calls = 0, removed = 0;
    while (store.scalar("SELECT count(*) FROM events WHERE expiry<=?", N)) {
      const progress = store.prune(N);
      assert.ok(progress > 0 && progress <= 100);
      removed += progress;
      assert.ok(++calls <= expired);
      assert.equal(store.scalar("PRAGMA cache_spill"), spill);
    }
    const peak = Math.max(...samples.map(sample => sample.bytes));
    t.diagnostic(JSON.stringify({ total, expired, pages, layout, calls, removed, peak, wal: store.budget.wal }));
    assert.equal(removed, expired);
    assert.ok(peak < store.budget.wal);
    assert.equal(store.scalar("SELECT count(*) FROM events"), total - expired);
    assert.equal(store.scalar("SELECT count(*) FROM feed_entries"), total - expired);
    assert.equal(store.scalar("SELECT count(*) FROM event_tags"), (total - expired) * 2);
    assert.equal(store.scalar("SELECT count(*) FROM receipts WHERE state='tombstone'"), expired);
    assert.equal(Number(store.get("floor")), expired);
    assert.equal(store.cursor("nats"), total);
    assert.equal(store.pending(N).length, 1);
    assert.equal(store.receipt(event(299999).event_id)?.state, "pending");
    assert.equal(store.scalar("PRAGMA user_version"), 1);
    assert.equal(store.scalar("PRAGMA synchronous"), 2);
    assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally { store.close(); dir.remove(); }
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
