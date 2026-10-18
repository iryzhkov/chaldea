import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectorMain, collect } from "../../src/events/collector.ts";
import { Outbox } from "../../src/events/outbox.ts";
import { scratchDir } from "../helpers/scratch.ts";

test("ship preview neither initializes durable state nor prunes old input", async () => {
  const f = scratchDir("collector-preview"), spool = join(f.path, "spool"), state = join(f.path, "state.db");
  mkdirSync(join(spool, "tool"), { recursive: true });
  const path = join(spool, "tool", "day.jsonl"); writeFileSync(path, "{}\n");
  const before = { ...process.env };
  try {
    process.env.AKASHA_SPOOL = spool; process.env.AKASHA_STATE_FILE = state;
    await collectorMain(["--dry-run", "--url", "https://example.test"]);
    assert.equal(existsSync(state), false);
    assert.equal(readFileSync(path, "utf8"), "{}\n");
    for (const args of [["--max-age", "0"], ["--max-age", "91"], ["--url", "http://example.test"]])
      await assert.rejects(collectorMain(args));
  } finally { process.env = before; f.remove(); }
});

test("shorter ship window retains input and only delivers recent tool calls", async () => {
  const f = scratchDir("collector-window"), spool = join(f.path, "spool");
  mkdirSync(join(spool, "tool"), { recursive: true });
  const now = Date.now(), raw = { host: "agent-a", session: "s", proc: "p", client: "codex", tool: "read", ok: true };
  const lines = [2, 0].map((days, seq) => JSON.stringify({ ...raw, seq, ts: new Date(now - days * 86400_000).toISOString() })).join("\n") + "\n";
  const path = join(spool, "tool", "day.jsonl"); writeFileSync(path, lines);
  const outbox = new Outbox(join(f.path, "state.db")); let sent = 0;
  try {
    const options = { outbox, spool, host: "agent-a", now: () => now, maxAgeDays: 1, deliver: async () => { sent++; return true; } };
    await collect(options); await collect(options);
    assert.equal(sent, 1); assert.equal(outbox.counters().outside_ship_window, 1);
    assert.equal(readFileSync(path, "utf8"), lines);
  } finally { outbox.close(); f.remove(); }
});
