import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { observe, observeThread } from "../../src/quota/observer.ts";
import { DAY_MS, MAX_POSTED_KEYS, emptyState, loadState, prune, recordKey, saveState } from "../../src/quota/state.ts";
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
  assert.deepEqual(observeThread(state, limited("run-1", T0 - 36 * DAY_MS, iso(T0 - 36 * DAY_MS + 10_000)), T0), []);
  assert.deepEqual(observeThread(state, limited("run-1", T0 - 36 * DAY_MS, null), T0), []);
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

test("a stop whose key was evicted at the cap is not reported again", () => {
  const state = emptyState();
  const stop = limited("run-1", T0, RESET);
  assert.equal(observeThread(state, stop, T0).length, 1);
  // 10,000 newer stops push the first key out.
  for (let i = 0; i < MAX_POSTED_KEYS; i += 1) state.posted.set(recordKey("quota_parked", `t${i}`, "r"), T0 + 60_000 + i);
  prune(state, T0 + 120_000);
  assert.equal(state.posted.has(recordKey("quota_parked", "thread-a", "run-1")), false);
  assert.equal(state.evictedThrough, Date.parse(RESET));
  state.parked.clear();
  assert.deepEqual(observeThread(state, stop, T0 + 120_000), []);
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 1, threads: [stop] }, T0 + 120_000), []);
  // A genuinely newer stop is still reported.
  const newer = limited("run-2", T0 + 200_000, iso(T0 + 300_000), { id: "thread-b" });
  assert.deepEqual(observeThread(state, newer, T0 + 200_000).map((r) => r.kind), ["quota_parked"]);
});

test("a snapshot reconciles a stop and resume that happened while the observer was away", () => {
  const state = emptyState();
  state.cursor = 40;
  const resumed = thread({
    status: "completed",
    latestRunId: "run-2",
    latestRunStartedAt: iso(T0 + 13_000),
    latestRunCompletedAt: iso(T0 + 14_000),
    limitRecovery: { runId: "run-1", resetAt: RESET, autoResume: true },
  });
  const records = observe(state, { kind: "snapshot", sequence: 90, threads: [resumed] }, T0 + 20_000);
  assert.deepEqual(records.map((r) => [r.kind, r.runId, r.reconciled]), [
    ["quota_parked", "run-1", true],
    ["quota_resumed", "run-1", true],
  ]);
  assert.equal(records[1]!.continuationRunId, "run-2");
  assert.equal(records[1]!.latenessSeconds, 3);
  assert.equal(records[1]!.trigger, "auto_resume");
  // Replays, later snapshots and the live event add nothing.
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 91, threads: [resumed] }, T0 + 21_000), []);
  assert.deepEqual(observe(state, { kind: "thread", sequence: 92, thread: resumed }, T0 + 21_000), []);
});

test("a snapshot after a cached park also reconciles a later stop the observer missed", () => {
  // Cached park for run A; while away: A continued as B, B limited, B continued as C.
  const state = emptyState();
  state.cursor = 10;
  const resetA = RESET;
  const resetB = iso(T0 + 60_000);
  assert.deepEqual(observeThread(state, limited("run-A", T0, resetA), T0).map((r) => r.kind), ["quota_parked"]);
  const snapshot = thread({
    status: "completed",
    latestRunId: "run-C",
    latestRunStartedAt: iso(T0 + 63_000),
    latestRunCompletedAt: iso(T0 + 64_000),
    limitRecovery: { runId: "run-B", resetAt: resetB, autoResume: true },
  });
  const records = observe(state, { kind: "snapshot", sequence: 99, threads: [snapshot] }, T0 + 70_000);
  assert.deepEqual(records.map((r) => [r.kind, r.runId]), [
    ["quota_resumed", "run-A"],
    ["quota_parked", "run-B"],
    ["quota_resumed", "run-B"],
  ]);
  assert.equal(records[2]!.continuationRunId, "run-C");
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 100, threads: [snapshot] }, T0 + 71_000), []);
});

test("the first snapshot on a host reports no history and starts from there", () => {
  const state = emptyState();
  const resumedLongAgo = thread({
    id: "thread-old",
    status: "completed",
    latestRunId: "run-2",
    latestRunStartedAt: iso(T0 + 13_000),
    limitRecovery: { runId: "run-1", resetAt: RESET, autoResume: true },
  });
  const parkedNow = limited("run-5", T0, iso(T0 + 600_000), { id: "thread-now" });
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 50, threads: [resumedLongAgo, parkedNow] }, T0 + 20_000), []);
  assert.equal(state.cursor, 50);
  // The thread parked at that moment is remembered: its resume is reported, its park never is.
  assert.deepEqual(observe(state, { kind: "thread", sequence: 51, thread: parkedNow }, T0 + 21_000), []);
  const resumed = thread({ id: "thread-now", status: "running", latestRunId: "run-6", latestRunStartedAt: iso(T0 + 602_000) });
  assert.deepEqual(observe(state, { kind: "thread", sequence: 52, thread: resumed }, T0 + 602_000).map((r) => [r.kind, r.runId]), [["quota_resumed", "run-5"]]);
  // Later snapshots do not revive the first snapshot's history.
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 60, threads: [resumedLongAgo] }, T0 + 603_000), []);
});

test("a thread parked with no reset at first start gets its one quota_reset_unknown", () => {
  const state = emptyState();
  const resetless = limited("run-7", T0, null, { id: "thread-resetless" });
  const continued = thread({
    id: "thread-old",
    status: "completed",
    latestRunId: "run-2",
    latestRunStartedAt: iso(T0 + 13_000),
    limitRecovery: { runId: "run-1", resetAt: RESET, autoResume: true },
  });
  const first = observe(state, { kind: "snapshot", sequence: 70, threads: [continued, resetless] }, T0 + 1_000);
  assert.deepEqual(first.map((r) => [r.kind, r.threadId, r.runId, r.reconciled]), [["quota_reset_unknown", "thread-resetless", "run-7", true]]);
  // A thread update and a snapshot fallback add nothing; the continued stop stays silent.
  assert.deepEqual(observe(state, { kind: "thread", sequence: 71, thread: resetless }, T0 + 2_000), []);
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 72, threads: [continued, resetless] }, T0 + 3_000), []);
});

test("reconciliation respects keys already posted and the age cut-off", () => {
  const state = emptyState();
  state.cursor = 1;
  observeThread(state, limited("run-1", T0, RESET), T0);
  state.parked.clear(); // As if the parked entry had been evicted at its cap.
  const resumed = thread({ status: "idle", latestRunId: "run-2", latestRunStartedAt: iso(T0 + 12_000), limitRecovery: { runId: "run-1", resetAt: RESET, autoResume: true } });
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 5, threads: [resumed] }, T0 + 13_000).map((r) => r.kind), ["quota_resumed"]);
  const old = thread({ id: "thread-old", latestRunId: "run-9", limitRecovery: { runId: "run-8", resetAt: iso(T0 - 36 * DAY_MS), autoResume: true } });
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 6, threads: [old] }, T0), []);
  // A thread whose armed run is still the latest is handled by the live path, not reconciled.
  const waiting = limited("run-3", T0, RESET, { id: "thread-c", limitRecovery: { runId: "run-3", resetAt: RESET, autoResume: true } });
  assert.deepEqual(observe(state, { kind: "snapshot", sequence: 7, threads: [waiting] }, T0).map((r) => [r.kind, r.reconciled]), [["quota_parked", undefined]]);
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
