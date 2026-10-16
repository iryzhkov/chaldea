// The observer loop's handling of a state file it cannot write.
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { MAX_QUEUED_RECORDS } from "../../src/feed/poster.ts";
import type { Logger } from "../../src/log.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
import { EventSink, runObserver } from "../../src/quota/run.ts";
import { emptyState, loadState, type ObserverState } from "../../src/quota/state.ts";
import type { ShellEvent } from "../../src/t3/adapter.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { iso, limited } from "../helpers/threads.ts";

function memoryLogger(): Logger & { lines: Array<[string, string]> } {
  const lines: Array<[string, string]> = [];
  return {
    lines,
    info: (message) => void lines.push(["info", message]),
    warn: (message) => void lines.push(["warn", message]),
    error: (message) => void lines.push(["error", message]),
  };
}

/** A state whose first snapshot has been seen, so events are reported. */
function started(): ObserverState {
  const state = emptyState();
  state.cursor = 0;
  return state;
}

function stopEvent(sequence: number, threadId = "thread-a"): ShellEvent {
  const now = Date.now();
  return { kind: "thread", sequence, thread: limited("run-1", now, iso(now + 10_000), { id: threadId }) };
}

/** A regular file where the state directory should be makes every write fail. */
function blockedStatePath(dir: string): { path: string; unblock: () => void } {
  const blocker = join(dir, "state");
  writeFileSync(blocker, "");
  return { path: join(blocker, "quota-observer.json"), unblock: () => rmSync(blocker) };
}

const NEVER = [3_600_000];

test("a record whose claim could not be saved waits, and is posted once the next event saves", () => {
  const dir = scratchDir("run");
  try {
    const blocked = blockedStatePath(dir.path);
    const queued: Array<QuotaRecord> = [];
    const logger = memoryLogger();
    const sink = new EventSink(started(), blocked.path, { enqueue: (record) => void queued.push(record) }, logger, NEVER);
    sink.handle(stopEvent(1));
    sink.handle(stopEvent(2, "thread-b"));
    assert.equal(queued.length, 0);
    assert.equal(sink.pending, 2);
    assert.equal(sink.dirty, true);
    assert.equal(logger.lines.filter(([level]) => level === "error").length, 1);

    blocked.unblock();
    sink.handle({ kind: "cursor", sequence: 3 });
    assert.equal(sink.dirty, false);
    assert.equal(sink.pending, 0);
    assert.deepEqual(queued.map((r) => r.threadId), ["thread-a", "thread-b"]);
    assert.ok(existsSync(blocked.path));
    sink.close();
  } finally {
    dir.remove();
  }
});

test("while dirty, one backoff timer retries the save without new events", async () => {
  const dir = scratchDir("run");
  try {
    const blocked = blockedStatePath(dir.path);
    const queued: Array<QuotaRecord> = [];
    const sink = new EventSink(started(), blocked.path, { enqueue: (record) => void queued.push(record) }, memoryLogger(), [20]);
    sink.handle(stopEvent(1));
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(sink.dirty, true);
    assert.deepEqual(queued, []);
    blocked.unblock();
    await new Promise((r) => setTimeout(r, 70));
    assert.equal(sink.dirty, false);
    assert.equal(queued.length, 1);
    sink.close();
  } finally {
    dir.remove();
  }
});

test("a failed save followed by a crash and restart posts the record exactly once", () => {
  const dir = scratchDir("run");
  try {
    const blocked = blockedStatePath(dir.path);
    const posted: Array<QuotaRecord> = [];
    const enqueue = (record: QuotaRecord) => void posted.push(record);
    const first = new EventSink(started(), blocked.path, { enqueue }, memoryLogger(), NEVER);
    first.handle({ kind: "snapshot", sequence: 0, threads: [] });
    first.handle(stopEvent(1));
    // Crash: the first process vanishes without a save; the disk recovers.
    blocked.unblock();
    const second = new EventSink(loadState(blocked.path, Date.now()), blocked.path, { enqueue }, memoryLogger(), NEVER);
    // T3 replays from the last durable cursor (none), so the stop arrives again.
    second.state.cursor = 0;
    second.handle(stopEvent(1));
    second.handle(stopEvent(1));
    assert.deepEqual(posted.map((r) => [r.kind, r.threadId]), [["quota_parked", "thread-a"]]);
    second.close();
  } finally {
    dir.remove();
  }
});

test("pending records are bounded", () => {
  const dir = scratchDir("run");
  try {
    const blocked = blockedStatePath(dir.path);
    const logger = memoryLogger();
    const sink = new EventSink(started(), blocked.path, { enqueue: () => {} }, logger, NEVER);
    for (let i = 0; i < MAX_QUEUED_RECORDS + 3; i += 1) sink.handle(stopEvent(i + 1, `thread-${i}`));
    assert.equal(sink.pending, MAX_QUEUED_RECORDS);
    assert.equal(logger.lines.filter(([, message]) => message.startsWith("pending record dropped")).length, 3);
    sink.close();
    assert.equal(sink.pending, 0);
    assert.deepEqual(logger.lines.at(-1), ["error", "records not posted: their claims could not be saved before shutdown"]);
  } finally {
    dir.remove();
  }
});

test("a failed final save does not change a normal shutdown's exit status", async () => {
  const dir = scratchDir("run");
  try {
    const blocked = blockedStatePath(dir.path);
    const logger = memoryLogger();
    const controller = new AbortController();
    controller.abort();
    const code = await runObserver({
      t3BaseDir: join(dir.path, "t3"),
      tokenFile: join(dir.path, "token"),
      statePath: blocked.path,
      feedCommand: "/nonexistent/feed",
      host: "h",
      logger,
      signal: controller.signal,
    });
    assert.equal(code, 0);
    assert.ok(logger.lines.some(([level]) => level === "error"));
    assert.deepEqual(logger.lines.at(-1), ["info", "quota observer stopped"]);
  } finally {
    dir.remove();
  }
});

test("the observer keeps retrying while T3 is not running, instead of failing closed", async () => {
  const dir = scratchDir("run");
  try {
    const tokenFile = join(dir.path, "token");
    writeFileSync(tokenFile, "token\n", { mode: 0o600 });
    const logger = memoryLogger();
    const controller = new AbortController();
    const running = runObserver({
      t3BaseDir: join(dir.path, "t3-not-started"),
      tokenFile,
      statePath: join(dir.path, "state.json"),
      feedCommand: "/nonexistent/feed",
      host: "h",
      logger,
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 1_500));
    controller.abort();
    assert.equal(await running, 0);
    assert.ok(logger.lines.filter(([, message]) => message === "T3 connection failed").length >= 1);
  } finally {
    dir.remove();
  }
});
