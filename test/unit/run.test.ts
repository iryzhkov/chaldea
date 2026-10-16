// The observer loop's handling of a state file it cannot write.
import assert from "node:assert/strict";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import type { Logger } from "../../src/log.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
import { EventSink, runObserver } from "../../src/quota/run.ts";
import { emptyState } from "../../src/quota/state.ts";
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

test("a failed state write still queues the record, logs once, and is retried on the next event", () => {
  const dir = scratchDir("run");
  try {
    // A regular file where the state directory should be makes every write fail.
    const blocker = join(dir.path, "state");
    writeFileSync(blocker, "");
    const statePath = join(blocker, "quota-observer.json");
    const queued: Array<QuotaRecord> = [];
    const logger = memoryLogger();
    const sink = new EventSink(emptyState(), statePath, { enqueue: (record) => void queued.push(record) }, logger);
    const now = Date.now();
    sink.handle({ kind: "thread", sequence: 1, thread: limited("run-1", now, iso(now + 10_000)) });
    sink.handle({ kind: "thread", sequence: 2, thread: limited("run-1", now, null, { id: "thread-b" }) });
    assert.deepEqual(queued.map((r) => r.kind), ["quota_parked", "quota_reset_unknown"]);
    assert.equal(sink.dirty, true);
    assert.deepEqual(logger.lines.filter(([level]) => level === "error").length, 1);

    rmSync(blocker);
    sink.handle({ kind: "cursor", sequence: 3 });
    assert.equal(sink.dirty, false);
    assert.ok(existsSync(statePath));
    assert.deepEqual(logger.lines.at(-1), ["info", "state file written again"]);
  } finally {
    dir.remove();
  }
});

test("a failed final save does not change a normal shutdown's exit status", async () => {
  const dir = scratchDir("run");
  try {
    const blocker = join(dir.path, "state");
    writeFileSync(blocker, "");
    const logger = memoryLogger();
    const controller = new AbortController();
    controller.abort();
    const code = await runObserver({
      t3BaseDir: join(dir.path, "t3"),
      tokenFile: join(dir.path, "token"),
      statePath: join(blocker, "quota-observer.json"),
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
