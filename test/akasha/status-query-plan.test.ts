import test from "node:test";
import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { join } from "node:path";
import { EventStore } from "../../src/akasha/store.ts";
import { eventPage } from "../../src/akasha/compat.ts";
import { validateEnvelope, type Envelope } from "../../src/akasha/schema.ts";
import type { Scope } from "../../src/akasha/auth.ts";
import { event, scratch, N } from "./helpers.ts";

const hosts = ["agent-a", "agent-b", "omarchy-pc", "omarchy-macbook-air-igor"];
const scope: Scope = {
  issuer: "chaldea:omarchy-normandy", profile: "mission-control-reader", project: "chaldea",
  source: "mission-control-reader", host: "omarchy-normandy", global: false,
  missionControlSources: hosts.map(host => host + "--mission-control"),
};
const query = () => new URLSearchParams({
  kind: "agent_status", project: "chaldea", limit: "128",
  from: new Date((N - 120) * 1000).toISOString(), to: new Date(N * 1000).toISOString(),
});
function status(i: number, host = hosts[i % hosts.length]!, occurred = N - 120 + Math.floor(i * 120 / 260)): Envelope {
  return validateEnvelope({
    ...event(i, "agent_status", occurred), issuer: "chaldea:" + host, host,
    title: "Mission control status", body: "", tags: [],
    source_id: host + "--mission-control", source: host + ".mission-control",
    profile: "mission-control-publisher", project: "chaldea",
    data: { snapshot: {
      schema: "mission-control.host.v1", host, epoch: "a".repeat(32), sequence: i + 1,
      observedAt: occurred * 1000, connected: true, total: 0, truncated: false, agents: [],
      tokens: { qualified: false, output: null, rate: null, observedAt: null, coverage: "unknown" },
    } },
  });
}
type Selection = { sql: string; params: SQLInputValue[]; ids: number[]; plan: string[] };
function capture(store: EventStore) {
  const selections: Selection[] = [], prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const statement = prepare(sql);
    if (sql.startsWith("SELECT seq FROM events ")) {
      const all = statement.all.bind(statement);
      statement.all = ((...params: SQLInputValue[]) => {
        const rows = all(...params);
        selections.push({
          sql, params, ids: rows.map(row => Number(row.seq)),
          plan: prepare("EXPLAIN QUERY PLAN " + sql).all(...params).map(row => String(row.detail)),
        });
        return rows;
      }) as typeof statement.all;
    }
    return statement;
  };
  return { selections, restore: () => { store.db.prepare = prepare; } };
}
function fixture(store: EventStore) {
  const insert = store.db.prepare("INSERT INTO events(event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const put = (e: Envelope, expiry = N + 3600) => Number(insert.run(e.event_id, JSON.stringify(e),
    e.issuer, e.profile, e.project, e.source, e.host, e.kind, e.received_at, e.occurred_at, expiry).lastInsertRowid);
  // Compact old ordinary history is enough to reproduce the planner choice.
  // This is a selector fixture, without admission or status retention work.
  store.db.exec("BEGIN");
  try {
    for (let i = 0; i < 20000; i++) put({ ...event(10000 + i, "feed_post", N - 86400), project: "chaldea" });
    store.db.exec("COMMIT");
  } catch (error) { store.db.exec("ROLLBACK"); throw error; }
  const expected: Envelope[] = [], sequences: number[] = [];
  for (let i = 0; i < 260; i++) {
    const e = status(i);
    // Real projection validates the complete snapshot envelope.
    store.project(e, i + 1, N);
    expected.push(e);
    sequences.push(Number(store.db.prepare("SELECT seq FROM events WHERE event_id=?").get(e.event_id)!.seq));
    if (i % 32 === 0) {
      // Deliberately corrupted or foreign persisted rows must not escape scope.
      const base = status(1000 + i, "agent-a", N);
      const decoys: Envelope[] = [
        { ...base, profile: "other" }, { ...base, project: "other" },
        { ...base, source_id: "foreign--mission-control" },
        { ...base, data: { snapshot: { ...base.data.snapshot as object, schema: "mission-control.host.v2" } } },
        { ...status(2000 + i, "agent-a", N - 121) },
        { ...status(3000 + i, "agent-a", N + 1) },
        { ...base, kind: "report" },
      ];
      for (const [j, decoy] of decoys.entries())
        put({ ...decoy, event_id: event(40000 + i * 10 + j).event_id });
      put({ ...base, event_id: event(50000 + i).event_id }, N);
    }
  }
  store.checkpoint();
  return { expected, sequences };
}

test("Mission Control candidates seek constrained kind through real eventPage pagination", () => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  let observed: ReturnType<typeof capture> | undefined;
  try {
    const { expected, sequences } = fixture(store);
    observed = capture(store);
    const q = query(), results: Envelope[] = [], plans: string[][] = [];
    let firstCursor = "";
    for (let pageNumber = 0; pageNumber < 3; pageNumber++) {
      const offset = pageNumber * 128, page = eventPage(store, q, scope, N);
      const rows = [...page.rows], cursor = page.next();
      assert.deepEqual(rows, expected.slice(offset, offset + 128));
      results.push(...rows);
      const selected: Selection = observed.selections.at(-1)!;
      assert.deepEqual(selected.ids, sequences.slice(offset, offset + 129));
      assert.deepEqual(selected.params.slice(-2), [offset ? sequences[offset - 1] : 0, 129]);
      plans.push(selected.plan);
      // Compare against the same real selector without its access-path directive.
      const unforced = selected.sql.replace(" INDEXED BY events_kind_seq", "");
      assert.deepEqual(store.db.prepare(unforced).all(...selected.params).map(row => Number(row.seq)), selected.ids);
      if (pageNumber < 2) {
        assert.ok(cursor);
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        assert.equal(decoded.seq, sequences[offset + 127]);
        assert.equal(decoded.epoch, store.get("epoch"));
        if (!pageNumber) firstCursor = cursor;
        q.set("cursor", cursor);
      } else assert.equal(cursor, null);
    }
    assert.deepEqual(results, expected);
    const bound = query(); bound.set("cursor", firstCursor);
    for (const key of ["kind", "project", "from", "to", "limit"]) {
      const changed = new URLSearchParams(bound); changed.set(key, key === "limit" ? "64" : "other");
      assert.throws(() => eventPage(store, changed, scope, N), /invalid_cursor/);
    }
    assert.throws(() => eventPage(store, bound, { ...scope, missionControlSources: scope.missionControlSources!.slice(0, 1) }, N), /invalid_cursor/);
    assert.throws(() => eventPage(store, query(), { ...scope, global: true }, N), /invalid_mission_control_scope/);
    assert.throws(() => eventPage(store, query(), { ...scope, missionControlOperations: "report" }, N), /operations_selector_required/);
    const expired = eventPage(store, query(), scope, N + 3600);
    assert.deepEqual([...expired.rows], []); assert.equal(expired.next(), null);
    store.put("floor", String(sequences[128]));
    assert.throws(() => eventPage(store, bound, scope, N), /cursor_expired_reset/);
    store.put("floor", "0"); store.put("epoch", "replaced");
    assert.throws(() => eventPage(store, bound, scope, N), /cursor_expired_reset/);
    for (const plan of plans) {
      assert.ok(plan.some(detail => /SEARCH events USING INDEX events_kind_seq \(kind=\? AND seq>\?\)/.test(detail)), plan.join("\n"));
      assert.ok(plan.every(detail => !/TEMP B-TREE|events_project_seq|SCAN events/.test(detail)), plan.join("\n"));
    }
  } finally { observed?.restore(); store.close(); dir.remove(); }
});

test("generic and global kind selectors keep their own access-path choice", () => {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  const observed = capture(store);
  try {
    const { missionControlSources: _sources, ...generic } = scope;
    for (const selectedScope of [generic, { ...generic, global: true }, scope]) {
      for (const kind of ["agent_status", "report", ""]) {
        // Only the explicit Mission Control status request receives the directive.
        if (selectedScope === scope && kind === "agent_status") continue;
        const q = query(); kind ? q.set("kind", kind) : q.delete("kind");
        assert.deepEqual([...eventPage(store, q, selectedScope, N).rows], []);
        assert.doesNotMatch(observed.selections.at(-1)!.sql, /INDEXED BY/);
      }
    }
  } finally { observed.restore(); store.close(); dir.remove(); }
});
