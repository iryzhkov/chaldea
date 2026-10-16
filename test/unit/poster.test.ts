import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { FEED_SOURCE, FEED_TAGS, FeedPoster, MAX_QUEUED_RECORDS } from "../../src/feed/poster.ts";
import { MAX_LINES_PER_MINUTE, createLogger, type Logger } from "../../src/log.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
import { scratchDir } from "../helpers/scratch.ts";

const recorder = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/feed-recorder");

const record: QuotaRecord = {
  kind: "quota_parked",
  severity: "warn",
  threadId: "thread:project:p:7d3137c2-e415-428a-9630-a4773d64d14c",
  runId: "run:1",
  provider: "claudeAgent",
  resetAt: "2026-10-16T23:03:20.000Z",
  subagent: false,
};

function memoryLogger(): Logger & { lines: Array<{ level: string; message: string; fields: string }> } {
  const lines: Array<{ level: string; message: string; fields: string }> = [];
  const push = (level: string) => (message: string, fields?: unknown) => void lines.push({ level, message, fields: JSON.stringify(fields ?? {}) });
  return { lines, info: push("info"), warn: push("warn"), error: push("error") };
}

function recorded(log: string): Array<{ args: Array<string>; body: string }> {
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("posts with the source, tags, host and a JSON body of identifiers only", async () => {
  const dir = scratchDir("poster");
  try {
    process.env.FEED_RECORDER_LOG = join(dir.path, "feed.jsonl");
    const poster = new FeedPoster({ command: recorder, host: "omarchy-pc", logger: memoryLogger() });
    poster.enqueue(record);
    await poster.idle();
    const [entry] = recorded(process.env.FEED_RECORDER_LOG);
    assert.ok(entry);
    assert.equal(entry.args[0], "post");
    assert.match(entry.args[1]!, /^quota_parked: claudeAgent thread .* until 2026-10-16T23:03:20.000Z$/);
    const flag = (name: string) => entry.args[entry.args.indexOf(name) + 1];
    assert.equal(flag("--severity"), "warn");
    assert.equal(flag("--source"), FEED_SOURCE);
    assert.equal(flag("--tag"), FEED_TAGS);
    assert.equal(flag("--host"), "omarchy-pc");
    assert.equal(flag("--body-file"), "-");
    assert.deepEqual(Object.keys(JSON.parse(entry.body)).sort(), ["host", "kind", "provider", "resetAt", "runId", "severity", "subagent", "threadId"]);
  } finally {
    delete process.env.FEED_RECORDER_LOG;
    dir.remove();
  }
});

test("a feed outage costs the record, after exactly one attempt", async () => {
  const dir = scratchDir("poster");
  try {
    process.env.FEED_RECORDER_LOG = join(dir.path, "feed.jsonl");
    process.env.FEED_RECORDER_FAIL_FILE = join(dir.path, "down");
    writeFileSync(process.env.FEED_RECORDER_FAIL_FILE, "");
    const logger = memoryLogger();
    const poster = new FeedPoster({ command: recorder, host: "h", logger });
    poster.enqueue(record);
    await poster.idle();
    assert.equal(recorded(process.env.FEED_RECORDER_LOG).length, 0);
    assert.deepEqual(logger.lines.map((l) => [l.level, l.message]), [["error", "feed post failed; record dropped"]]);
  } finally {
    delete process.env.FEED_RECORDER_LOG;
    delete process.env.FEED_RECORDER_FAIL_FILE;
    dir.remove();
  }
});

test("a post the server accepted but reported as failed is not repeated, and its stderr is not logged", async () => {
  const dir = scratchDir("poster");
  try {
    process.env.FEED_RECORDER_LOG = join(dir.path, "feed.jsonl");
    process.env.FEED_RECORDER_FAIL_AFTER_RECORD = "1";
    const logger = memoryLogger();
    const poster = new FeedPoster({ command: recorder, host: "h", logger });
    poster.enqueue(record);
    await poster.idle();
    assert.equal(recorded(process.env.FEED_RECORDER_LOG).length, 1);
    const [line] = logger.lines;
    assert.equal(logger.lines.length, 1);
    assert.equal(line!.level, "error");
    const fields = JSON.parse(line!.fields);
    assert.equal(fields.exitCode, 1);
    assert.ok(fields.stderrBytes > 0);
    for (const secret of ["someone@example.com", "SECRET-TOKEN-VALUE", "feed.example"]) {
      assert.ok(!line!.fields.includes(secret), `log fields contain ${secret}`);
    }
  } finally {
    delete process.env.FEED_RECORDER_LOG;
    delete process.env.FEED_RECORDER_FAIL_AFTER_RECORD;
    dir.remove();
  }
});

test("a missing feed command is logged and dropped, not thrown", async () => {
  const logger = memoryLogger();
  const poster = new FeedPoster({ command: "/nonexistent/feed", host: "h", logger });
  poster.enqueue(record);
  await poster.idle();
  assert.equal(logger.lines.at(-1)?.level, "error");
  assert.equal(JSON.parse(logger.lines.at(-1)!.fields).spawnError, "ENOENT");
});

test("the queue is bounded", async () => {
  const logger = memoryLogger();
  const poster = new FeedPoster({ command: "/nonexistent/feed", host: "h", logger });
  for (let i = 0; i < MAX_QUEUED_RECORDS + 10; i += 1) poster.enqueue(record);
  assert.ok(logger.lines.filter((l) => l.message === "feed queue full; dropping record").length >= 9);
  await poster.idle();
});

test("log output is rate limited", () => {
  const lines: Array<string> = [];
  const logger = createLogger((line) => lines.push(line));
  for (let i = 0; i < MAX_LINES_PER_MINUTE + 50; i += 1) logger.info("x", { i });
  assert.equal(lines.length, MAX_LINES_PER_MINUTE);
  assert.equal(JSON.parse(lines[0]!).level, "info");
  // Error lines are exempt from the cap.
  logger.error("disk full");
  assert.equal(JSON.parse(lines.at(-1)!).message, "disk full");
});
