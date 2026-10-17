import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { normalize, type Identity } from "../../src/akasha/schema.ts";
import { toolPayload, timerPublication, collect } from "../../src/events/collector.ts";
import { Outbox } from "../../src/events/outbox.ts";
import { FeedPoster, quotaPublication } from "../../src/feed/poster.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
import { scratchDir } from "../helpers/scratch.ts";
const logger = { info() {}, warn() {}, error() {} };
const identity: Identity = { issuer: "i", profile: "p", project: "project", source: "agent-a.toolfeedback",
  host: "agent-a", run_id: "lease", source_id: "agent-a-toolfeedback" };
const base = { ts: "2026-10-17T00:00:00Z", host: "agent-a", session: "", client: "codex", proc: "proc", seq: 1,
  tool: "read", ok: true };
const record: QuotaRecord = { kind: "quota_reset_unknown", severity: "warn", threadId: "t", runId: "r",
  provider: "codex", resetAt: null, subagent: false };
test("argumentless Go records and shell records satisfy the accepted service schema", () => {
  for (const raw of [base, { ...base, args: [], outcome: "ok", exit: 0 }, { ...base, args: ["query"], ok: false, err: "local-io" }]) {
    const p = toolPayload(raw, Buffer.from(JSON.stringify(raw)), "agent99", "agent-a");
    const normalized = normalize(p, identity, false);
    assert.ok(Array.isArray(normalized.data.args)); assert.equal(normalized.kind, "tool_call");
  }
  const q = quotaPublication(record, "agent-a");
  assert.equal(normalize(q.payload, { ...identity, source: q.source }, false).kind, record.kind);
  const timer = timerPublication({ job: "chaldea-retention", invocation: "a".repeat(32),
    host: "agent-a", timestamp: base.ts, outcome: "failed", changed: 1, task: "safe task", reason: "safe reason" }, "agent-a");
  assert.equal(normalize(timer.payload, { ...identity, source: timer.source }, false).kind, "job_finished");
});
test("collector ignores root transcript indexes and deeper trees, including retention", async () => {
  const f = scratchDir("spool-layout"), db = new Outbox(join(f.path, "state.db"));
  const spool = join(f.path, "spool"); mkdirSync(join(spool, "tool", "deeper"), { recursive: true });
  const index = join(spool, "transcripts.jsonl"), nested = join(spool, "tool", "deeper", "private.jsonl");
  writeFileSync(index, '{"transcript":"/private/transcript","cwd":"/private"}\n');
  writeFileSync(nested, '{"output":"PRIVATE"}\n');
  const old = new Date(Date.now() - 91 * 86400_000); utimesSync(index, old, old); utimesSync(nested, old, old);
  writeFileSync(join(spool, "tool", "day.jsonl"), JSON.stringify(base) + "\n");
  try {
    let count = 0;
    await collect({ spool, host: "agent-a", outbox: db, deliver: async () => { count++; return true; } });
    assert.equal(count, 1); assert.ok(existsSync(index)); assert.ok(existsSync(nested));
    assert.equal(db.counters().rejected, 0); assert.equal(db.counters().expired_unshipped, 0);
  } finally { db.close(); f.remove(); }
});
test("legacy mode attempts the selected feed command once; scoped failure never calls it", async () => {
  const f = scratchDir("quota-cutover"), log = join(f.path, "calls"), command = join(f.path, "legacy");
  writeFileSync(command, '#!/bin/sh\ncat >/dev/null\nprintf call >> "$LEGACY_LOG"\nexit 1\n', { mode: 0o700 });
  const names = ["LEGACY_LOG", "AKASHA_URL", "AKASHA_TOKEN_HELPER", "FEED_TOKEN"];
  const old = Object.fromEntries(names.map(n => [n, process.env[n]]));
  delete process.env.AKASHA_URL; delete process.env.AKASHA_TOKEN_HELPER;
  process.env.LEGACY_LOG = log;
  try {
    let ack = 0;
    const legacy = new FeedPoster({ command, host: "agent-a", logger, retryMs: 10 });
    legacy.enqueue(record, () => { ack++; }); await legacy.idle();
    await new Promise(r => setTimeout(r, 25)); assert.equal(ack, 1); assert.equal(readFileSync(log, "utf8"), "call"); legacy.close();
    process.env.AKASHA_URL = "https://akasha.test";
    process.env.AKASHA_TOKEN_HELPER = "/missing/scoped-helper";
    process.env.FEED_TOKEN = "shared-must-not-be-used";
    const scoped = new FeedPoster({ command, host: "agent-a", logger });
    scoped.enqueue(record, () => { ack++; }); await scoped.idle(); scoped.close();
    assert.equal(ack, 1); assert.equal(readFileSync(log, "utf8"), "call");
  } finally { for (const name of names) { if (old[name] === undefined) delete process.env[name]; else process.env[name] = old[name]; } f.remove(); }
});
