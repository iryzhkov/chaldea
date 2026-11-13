import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { SQLInputValue } from "node:sqlite";
import { EventStore } from "../../src/akasha/store.ts";
import { eventPage } from "../../src/akasha/compat.ts";
import { scratch, event, N, registration } from "./helpers.ts";

const index = "events_host_kind_seq_time";
const scope = { ...registration, global: true };

for (const prebuilt of [false, true]) {
  test(`host/kind index migration preserves populated v1 store, prebuilt=${prebuilt}`, () => {
    const dir = scratch(), path = join(dir.path, "events.db");
    let store = new EventStore(path, { initialize: true });
    try {
      // Older and newer timestamps deliberately interleave in seq order.
      const insert = store.db.prepare(`INSERT INTO events
        (event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
      for (let i = 1; i <= 40; i++) {
        const e = event(i, "tool_call", N - (i % 2 ? 3600 : 86400));
        insert.run(e.event_id, JSON.stringify(e), e.issuer, e.profile, e.project,
          e.source, e.host, e.kind, e.received_at, e.occurred_at, N + 86400);
      }
      store.db.exec("DROP INDEX " + index + "; PRAGMA user_version=1");
      if (prebuilt) store.db.exec("CREATE INDEX " + index + " ON events(host,kind,seq,occurred_at)");
      const before = store.db.prepare("SELECT * FROM events ORDER BY seq").all();
      const epoch = store.get("epoch");
      store.close();
      store = new EventStore(path);
      assert.equal(store.scalar("PRAGMA user_version"), 2);
      assert.equal(store.get("epoch"), epoch);
      assert.deepEqual(store.db.prepare("SELECT * FROM events ORDER BY seq").all(), before);
      assert.deepEqual(store.db.prepare("PRAGMA index_info(" + index + ")").all().map(r => r.name),
        ["host", "kind", "seq", "occurred_at"]);
      store.close();
      store = new EventStore(path); // v2 reopen is idempotent too.
      assert.equal(store.scalar("SELECT count(*) FROM events"), 40);
    } finally { if (store.db.isOpen) store.close(); dir.remove(); }
  });
}

test("reader host/kind pages and since scans use the covering index without sorting", t => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  const prepare = store.db.prepare.bind(store.db);
  try {
    for (let i = 1; i <= 8; i++) {
      const e = event(i, "tool_call", N - (i % 2 ? 0 : 86400));
      prepare(`INSERT INTO events
        (event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(e.event_id, JSON.stringify(e), e.issuer, e.profile, e.project,
          e.source, e.host, e.kind, e.received_at, e.occurred_at, N + 86400);
    }
    // Capture the real builder SQL and bound parameters, including cursor pages.
    const plans: string[] = [];
    store.db.prepare = sql => {
      const stmt = prepare(sql);
      if (sql.startsWith("SELECT seq FROM events WHERE")) {
        const all = stmt.all.bind(stmt);
        stmt.all = ((...params: SQLInputValue[]) => {
          const details = prepare("EXPLAIN QUERY PLAN " + sql).all(...params).map(r => String(r.detail)).join("\n");
          t.diagnostic(sql + "\n" + details);
          plans.push(details);
          return all(...params);
        }) as typeof stmt.all;
      }
      return stmt;
    };
    const q = new URLSearchParams({ host: registration.host, kind: "tool_call", limit: "2", from: "1h" });
    const first = eventPage(store, q, scope, N);
    assert.deepEqual([...first.rows].map(r => r.event_id), [event(1).event_id, event(3).event_id]);
    q.set("cursor", first.next()!);
    const second = eventPage(store, q, scope, N);
    assert.deepEqual([...second.rows].map(r => r.event_id), [event(5).event_id, event(7).event_id]);
    assert.equal(second.next(), null);
    assert.equal(plans.length, 2);
    for (const where of ["host=? AND kind=?", "host=? AND kind=? AND occurred_at>=?"]) {
      const sql = "SELECT seq FROM events WHERE " + where + " ORDER BY seq LIMIT ?";
      const params = [registration.host, "tool_call", ...(where.includes("occurred_at") ? [new Date((N - 86400) * 1000).toISOString()] : []), 100];
      const details = prepare("EXPLAIN QUERY PLAN " + sql).all(...params).map(r => String(r.detail)).join("\n");
      t.diagnostic(sql + "\n" + details);
      plans.push(details);
    }
    for (const details of plans) {
      assert.match(details, /SEARCH events USING COVERING INDEX events_host_kind_seq_time \(host=\? AND kind=\?/);
      assert.doesNotMatch(details, /TEMP B-TREE/);
    }
    const payloadPlan = prepare("EXPLAIN QUERY PLAN SELECT envelope FROM events WHERE seq=? AND 1 AND occurred_at>=? AND occurred_at<=? AND host=? AND kind=?")
      .all(1, new Date((N - 86400) * 1000).toISOString(), new Date(N * 1000).toISOString(), registration.host, "tool_call");
    assert.match(String(payloadPlan[0]!.detail), /USING INTEGER PRIMARY KEY/);
    t.diagnostic(String(payloadPlan[0]!.detail));
  } finally { store.db.prepare = prepare; store.close(); dir.remove(); }
});
