import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { EventStore } from "../../src/akasha/store.ts";
import { Outbox } from "../../src/events/outbox.ts";
import { event, scratch, N, project } from "./helpers.ts";

const retiredTable = "mission_control_status"; // R7: keep existing projection rows for rollback; runtime never reads or writes them.

test("reopening either database preserves retired projection rows and ordinary delivery", () => {
  const dir = scratch();
  try {
    for (const collector of [false, true]) {
      const path = join(dir.path, collector ? "collector.db" : "events.db");
      const open = () => collector ? new Outbox(path) : new EventStore(path, { initialize: true });
      let db = open();
      db.db.exec(`CREATE TABLE ${retiredTable}(slot INTEGER PRIMARY KEY CHECK(slot=1), value TEXT NOT NULL)`);
      db.db.prepare(`INSERT INTO ${retiredTable} VALUES(1,?)`).run("opaque retained payload");
      db.close();
      db = collector ? new Outbox(path) : new EventStore(path);
      try {
        if (db instanceof EventStore) {
          const e = event(1);
          db.admit(e, "request", N); project(db);
          assert.equal(db.receipt(e.event_id)?.state, "visible");
          assert.equal(db.scalar("SELECT count(*) FROM feed_entries"), 1);
        } else {
          const cursor = { generation: "g", dev: "1", ino: "1", offset: 1, prefix: "", prefixLength: 0, tail: "" };
          assert.equal(db.admit({ key: "ordinary", source: "feed", host: "agent-a", payload: {} }, "file", cursor), true);
          db.acknowledge("ordinary");
          assert.equal(db.next(), null);
        }
        assert.deepEqual({ ...db.db.prepare(`SELECT * FROM ${retiredTable}`).get()! }, { slot: 1, value: "opaque retained payload" });
      } finally { db.close(); }
    }
  } finally { dir.remove(); }
});
