import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { collect } from "../../src/events/collector.ts";
import { Outbox } from "../../src/events/outbox.ts";
import { scratchDir } from "../helpers/scratch.ts";

test("recent spool files are delivered before historical backlog without losing offsets", async () => {
  const f = scratchDir("collector-visible"), spool = join(f.path, "spool");
  const db = new Outbox(join(f.path, "state.db"));
  const now = Date.now(), seen: string[] = [];
  const raw = { host: "agent-a", session: "s", proc: "p", client: "codex", tool: "read", ok: true, seq: 1 };
  mkdirSync(join(spool, "huyang"), { recursive: true });
  const old = join(spool, "huyang", "old.jsonl"), recent = join(spool, "huyang", "recent.jsonl");
  writeFileSync(old, JSON.stringify({ ...raw, ts: new Date(now - 86400_000).toISOString() }) + "\n");
  writeFileSync(recent, JSON.stringify({ ...raw, ts: new Date(now).toISOString() }) + "\n");
  utimesSync(old, new Date(now - 86400_000), new Date(now - 86400_000));
  utimesSync(recent, new Date(now), new Date(now));
  const deliver = async (e: import("../../src/events/publisher.ts").Publication) => { seen.push(String(e.payload.occurred_at)); return true; };
  try {
    await collect({ spool, outbox: db, host: "agent-a", deliver, maxEvents: 1 });
    assert.deepEqual(seen, [new Date(now).toISOString()]);
    await collect({ spool, outbox: db, host: "agent-a", deliver });
    assert.deepEqual(seen, [new Date(now).toISOString(), new Date(now - 86400_000).toISOString()]);
    assert.equal(db.next(), null);
  } finally { db.close(); f.remove(); }
});

test("a collector slice delivers multiple slow receipts and stops at durable boundaries", async () => {
  const f = scratchDir("collector-throughput"), spool = join(f.path, "spool");
  const db = new Outbox(join(f.path, "state.db"));
  let now = Date.now(), delivered = 0;
  mkdirSync(join(spool, "huyang"), { recursive: true });
  const path = join(spool, "huyang", "today.jsonl");
  const line = JSON.stringify({ ts: new Date(now).toISOString(), host: "agent-a", session: "s", proc: "p", client: "codex", tool: "read", ok: true, seq: 1 }) + "\n";
  writeFileSync(path, line.repeat(20));
  try {
    await collect({ spool, outbox: db, host: "agent-a", now: () => now,
      deliver: async () => { now += 3000; delivered++; return true; } });
    assert.ok(delivered >= 6 && delivered <= 10, String(delivered));
    assert.equal(db.cursor("tool/huyang/today.jsonl")!.offset, Buffer.byteLength(line) * delivered);
    assert.equal(db.next(), null);
  } finally { db.close(); f.remove(); }
});
