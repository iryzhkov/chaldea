import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { collect } from "../../src/events/collector.ts";
import { Outbox } from "../../src/events/outbox.ts";
import type { Publication } from "../../src/events/publisher.ts";
import { scratchDir } from "../helpers/scratch.ts";
test("timer retries use job/invocation across collector generations and token leases", async () => {
  const f = scratchDir("timer-events"), timers = join(f.path, "timers"), seen: Publication[] = [];
  mkdirSync(timers);
  const invocation = "a".repeat(32);
  writeFileSync(join(timers, "run.jsonl"), JSON.stringify({ job: "chaldea-retention", invocation,
    host: "agent-a", timestamp: "2026-10-17T00:00:00Z", outcome: "changed" }) + "\n");
  let db = new Outbox(join(f.path, "state.db"));
  try {
    await collect({ timers, spool: join(f.path, "absent"), host: "agent-a", outbox: db,
      deliver: async e => { seen.push(e); return false; } });
    db.close(); db = new Outbox(join(f.path, "state.db"));
    await collect({ timers, spool: join(f.path, "absent"), host: "agent-a", outbox: db,
      deliver: async e => { seen.push(e); return true; } });
    assert.deepEqual(seen[0], seen[1]); assert.equal(seen[0]!.key, "chaldea-retention/" + invocation);
    assert.equal(seen[0]!.source, "agent-a.fleet");
    assert.equal(seen[0]!.payload.kind, "job_finished"); assert.equal(db.next(), null);
  } finally { db.close(); f.remove(); }
});
