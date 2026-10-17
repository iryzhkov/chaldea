import assert from "node:assert/strict";
import { test } from "node:test";
import { FeedPoster, quotaKey, quotaPublication, MAX_QUEUED_RECORDS } from "../../src/feed/poster.ts";
import { MAX_LINES_PER_MINUTE, createLogger, type Logger } from "../../src/log.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
const record: QuotaRecord = { kind: "quota_parked", severity: "warn", threadId: "thread-1",
  runId: "run-1", provider: "claudeAgent", resetAt: "2026-10-16T23:03:20.000Z", subagent: false };
const logger: Logger = { info() {}, warn() {}, error() {} };
test("quota uses structured service publication and a logical key independent of payload/token", () => {
  const e = quotaPublication(record, "agent-a");
  assert.equal(e.payload.kind, "quota_parked");
  assert.equal(e.source, "chaldea-quota");
  assert.equal((e.payload.data as Record<string, unknown>).run_id, "run-1");
  assert.equal(quotaKey(record), quotaKey({ ...record, resetAt: "2026-10-17T00:00:00Z" }));
  assert.notEqual(quotaKey(record), quotaKey({ ...record, runId: "run-2" }));
});
test("an ambiguous delivery remains queued and retries the same payload and key", async () => {
  const seen: string[] = []; let up = false, ack = 0;
  const poster = new FeedPoster({ command: "/must/not/be/run", host: "agent-a", logger, retryMs: 10,
    deliver: async e => { seen.push(JSON.stringify(e)); return up; } });
  try {
    poster.enqueue(record, () => { ack++; });
    await poster.idle(); assert.equal(ack, 0); up = true;
    await new Promise(r => setTimeout(r, 40)); await poster.idle();
    assert.equal(ack, 1); assert.ok(seen.length >= 2); assert.equal(new Set(seen).size, 1);
  } finally { poster.close(); }
});
test("delivery does not block enqueue; a full worker retains the caller's durable intents", async () => {
  let finish!: (v: boolean) => void; let ack = 0, warnings = 0;
  const poster = new FeedPoster({ command: "", host: "agent-a",
    logger: { ...logger, warn() { warnings++; } },
    deliver: () => new Promise(resolve => { finish = resolve; }) });
  poster.enqueue(record, () => { ack++; });
  for (let i = 0; i < MAX_QUEUED_RECORDS + 5; i++) poster.enqueue({ ...record, threadId: "t" + i });
  assert.equal(ack, 0); assert.ok(warnings > 0);
  poster.close(); finish(false); await poster.idle();
});
test("log output is rate limited", () => {
  const lines: string[] = [], l = createLogger(line => lines.push(line));
  for (let i = 0; i < MAX_LINES_PER_MINUTE + 50; i++) l.info("x", { i });
  assert.equal(lines.length, MAX_LINES_PER_MINUTE); l.error("disk full");
  assert.equal(JSON.parse(lines.at(-1)!).message, "disk full");
});
