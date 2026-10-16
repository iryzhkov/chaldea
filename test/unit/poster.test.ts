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

function memoryLogger(): Logger & { lines: Array<{ level: string; message: string }> } {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    info: (message) => lines.push({ level: "info", message }),
    warn: (message) => lines.push({ level: "warn", message }),
    error: (message) => lines.push({ level: "error", message }),
  };
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

test("a feed outage is retried a bounded number of times, then dropped", async () => {
  const dir = scratchDir("poster");
  try {
    process.env.FEED_RECORDER_LOG = join(dir.path, "feed.jsonl");
    process.env.FEED_RECORDER_FAIL_FILE = join(dir.path, "down");
    writeFileSync(process.env.FEED_RECORDER_FAIL_FILE, "");
    const logger = memoryLogger();
    const poster = new FeedPoster({ command: recorder, host: "h", logger, attemptDelaysMs: [0, 10, 10] });
    poster.enqueue(record);
    await poster.idle();
    assert.equal(recorded(process.env.FEED_RECORDER_LOG).length, 0);
    assert.equal(logger.lines.filter((l) => l.message === "feed post failed").length, 3);
    assert.equal(logger.lines.at(-1)?.message, "dropping feed record after bounded retries");
  } finally {
    delete process.env.FEED_RECORDER_LOG;
    delete process.env.FEED_RECORDER_FAIL_FILE;
    dir.remove();
  }
});

test("a missing feed command is logged and dropped, not thrown", async () => {
  const logger = memoryLogger();
  const poster = new FeedPoster({ command: "/nonexistent/feed", host: "h", logger, attemptDelaysMs: [0] });
  poster.enqueue(record);
  await poster.idle();
  assert.equal(logger.lines.at(-1)?.level, "error");
});

test("the queue is bounded", async () => {
  const logger = memoryLogger();
  const poster = new FeedPoster({ command: "/nonexistent/feed", host: "h", logger, attemptDelaysMs: [0] });
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
});
