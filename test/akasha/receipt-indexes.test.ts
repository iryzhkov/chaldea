import test from "node:test";
import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { join } from "node:path";
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

function retained(store: EventStore): void {
  // Ordinary compact receipts outlive payloads. No outbox or event scan is needed
  // to reproduce the receipt-query defect.
  store.db.prepare(`
    WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<20000)
    INSERT INTO receipts
    SELECT 'retained-'||i,'request','envelope',
      CASE i%3 WHEN 0 THEN 'visible' WHEN 1 THEN 'tombstone' ELSE 'quarantined' END,
      NULL,'chaldea:agent-a','daily-health','homelab','ordinary','agent-a',?
    FROM n
  `).run(N + DAY);
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
    } finally { store.close(); dir.remove(); }
  });
}
