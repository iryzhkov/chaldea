import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, utimesSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Outbox } from "../../src/events/outbox.ts";
import { collect } from "../../src/events/collector.ts";
import { scratchDir } from "../helpers/scratch.ts";
const raw = { ts: "2026-10-17T00:00:00Z", host: "agent-a", session: "s", client: "codex", proc: "p",
  seq: 1, tool: "read", ok: true };
test("metadata-only touches never replay delivered tool lines", async () => {
  const f = scratchDir("collector-touch"), spool = join(f.path, "spool"), db = new Outbox(join(f.path, "state.db"));
  mkdirSync(join(spool, "tool"), { recursive: true });
  const path = join(spool, "tool", "day.jsonl"); writeFileSync(path, JSON.stringify(raw) + "\n");
  let delivered = 0;
  const options = { spool, outbox: db, host: "agent-a", deliver: async () => { delivered++; return true; } };
  try {
    await collect(options);
    utimesSync(path, new Date(Date.now() + 1000), new Date(Date.now() + 1000));
    await collect(options); assert.equal(delivered, 1);
  } finally { db.close(); f.remove(); }
});
test("retention reaches past 5000 raw files while delivery is unavailable", async () => {
  const f = scratchDir("collector-many"), spool = join(f.path, "spool"), db = new Outbox(join(f.path, "state.db"));
  mkdirSync(join(spool, "tool"), { recursive: true });
  // This case measures scan completeness; durability has separate receipt/crash tests.
  db.db.exec("PRAGMA synchronous=OFF");
  const old = new Date(Date.now() - 91 * 86400_000);
  for (let i = 0; i < 5001; i++) {
    const path = join(spool, "tool", i + ".jsonl");
    writeFileSync(path, "{}\n"); utimesSync(path, old, old);
  }
  try {
    await collect({ spool, outbox: db, host: "agent-a", deliver: async () => false });
    assert.equal(readdirSync(join(spool, "tool")).length, 0);
    assert.equal(db.counters().expired_unshipped, 5001);
  } finally { db.close(); f.remove(); }
});
