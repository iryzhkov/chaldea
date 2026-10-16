import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { observe, observeThread } from "../../src/quota/observer.ts";
import { DAY_MS, emptyState, loadState, saveState } from "../../src/quota/state.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { T0, iso, limited, thread } from "../helpers/threads.ts";

const RESET = iso(T0 + 10_000);

test("a usage-limit stop with a reset is reported once as quota_parked", () => {
  const state = emptyState();
  const stop = limited("run-1", T0, RESET);
  const first = observeThread(state, stop, T0);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], {
    kind: "quota_parked",
    severity: "warn",
    threadId: "thread-a",
    runId: "run-1",
    provider: "claudeAgent",
    resetAt: RESET,
    subagent: false,
  });
  // The arm update, a repeated event and a snapshot replay add nothing.
  const armed = { ...stop, limitRecovery: { runId: "run-1", resetAt: RESET, autoResume: true } };
  assert.deepEqual(observeThread(state, armed, T0 + 3_000), []);
  assert.deepEqual(observeThread(state, stop, T0 + 4_000), []);
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 9, threads: [armed] }, T0 + 5_000), []);
});

test("the continuation run produces one quota_resumed with lateness", () => {
  const state = emptyState();
  observeThread(state, limited("run-1", T0, RESET), T0);
  const resumed = thread({
    status: "completed",
    latestRunId: "run-2",
    latestRunStartedAt: iso(T0 + 14_500),
    latestRunCompletedAt: iso(T0 + 15_000),
    limitRecovery: { runId: "run-1", resetAt: RESET, autoResume: true },
  });
  const records = observeThread(state, resumed, T0 + 15_000);
  assert.equal(records.length, 1);
  assert.equal(records[0]!.kind, "quota_resumed");
  assert.equal(records[0]!.severity, "info");
  assert.equal(records[0]!.runId, "run-1");
  assert.equal(records[0]!.continuationRunId, "run-2");
  assert.equal(records[0]!.latenessSeconds, 4.5);
  assert.equal(records[0]!.trigger, "auto_resume");
  assert.equal(state.parked.size, 0);
  assert.deepEqual(observeThread(state, resumed, T0 + 16_000), []);
});

test("a resume nobody armed is reported with trigger other", () => {
  const state = emptyState();
  observeThread(state, limited("run-1", T0, RESET), T0);
  const records = observeThread(state, thread({ status: "running", latestRunId: "run-2", latestRunStartedAt: iso(T0 + 2_000) }), T0 + 2_000);
  assert.equal(records[0]!.trigger, "other");
  assert.equal(records[0]!.latenessSeconds, -8);
});

test("a stop without a reset warns once and stays parked until a reset arrives", () => {
  const state = emptyState();
  const stop = limited("run-1", T0, null);
  const first = observeThread(state, stop, T0);
  assert.deepEqual(first.map((r) => r.kind), ["quota_reset_unknown"]);
  assert.deepEqual(observeThread(state, stop, T0 + 60_000), []);
  assert.equal(state.parked.get("thread-a")?.resetAt, null);
  // A later provider update supplies the reset for the same run.
  const patched = observeThread(state, limited("run-1", T0, RESET), T0 + 70_000);
  assert.deepEqual(patched.map((r) => r.kind), ["quota_parked"]);
  assert.equal(state.parked.get("thread-a")?.resetAt, RESET);
});

test("a second stop on the continuation run is a new park, after the resume", () => {
  const state = emptyState();
  observeThread(state, limited("run-1", T0, RESET), T0);
  const again = limited("run-2", T0 + 20_000, iso(T0 + 3_600_000));
  assert.deepEqual(observeThread(state, again, T0 + 20_000).map((r) => [r.kind, r.runId]), [
    ["quota_resumed", "run-1"],
    ["quota_parked", "run-2"],
  ]);
});

test("other failures, archived threads and stale stops are ignored", () => {
  const state = emptyState();
  assert.deepEqual(observeThread(state, limited("run-1", T0, RESET, { lastErrorClass: "provider_error" }), T0), []);
  assert.deepEqual(observeThread(state, limited("run-1", T0, RESET, { archived: true }), T0), []);
  assert.deepEqual(observeThread(state, limited("run-1", T0 - 36 * DAY_MS, RESET), T0), []);
  assert.equal(state.parked.size, 0);
  observeThread(state, limited("run-9", T0, RESET, { id: "thread-b" }), T0);
  assert.equal(state.parked.size, 1);
  observe(state, { kind: "removed", sequence: 4, threadId: "thread-b" }, T0);
  assert.equal(state.parked.size, 0);
});

test("subagent threads are reported and marked", () => {
  const state = emptyState();
  const records = observeThread(state, limited("run-1", T0, RESET, { relationshipToParent: "subagent" }), T0);
  assert.equal(records[0]!.subagent, true);
});

test("the cursor follows the stream", () => {
  const state = emptyState();
  observe(state, { kind: "snapshot", sequence: 3, threads: [] }, T0);
  assert.equal(state.cursor, 3);
  observe(state, { kind: "thread", sequence: 16, thread: thread() }, T0);
  observe(state, { kind: "cursor", sequence: 17 }, T0);
  observe(state, { kind: "synchronized" }, T0);
  assert.equal(state.cursor, 17);
});

test("a restart replaying the same events posts nothing new", () => {
  const dir = scratchDir("observer");
  try {
    const path = join(dir.path, "state.json");
    const events = [
      { kind: "thread", sequence: 25, thread: limited("run-1", T0, RESET) },
      { kind: "thread", sequence: 55, thread: thread({ status: "completed", latestRunId: "run-2", latestRunStartedAt: iso(T0 + 14_000) }) },
    ] as const;
    const before = emptyState();
    const firstRun = events.flatMap((event) => observe(before, event, T0 + 15_000));
    assert.deepEqual(firstRun.map((r) => r.kind), ["quota_parked", "quota_resumed"]);
    saveState(path, before, T0 + 15_000);
    // Crash before the cursor moved past the stop: the replay starts again at the stop.
    const after = loadState(path, T0 + 16_000);
    assert.deepEqual(events.flatMap((event) => observe(after, event, T0 + 16_000)), []);
  } finally {
    dir.remove();
  }
});
