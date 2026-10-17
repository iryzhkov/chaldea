// The quota observer's state machine.
//
// T3 resumes limited threads itself (`autoResumeLimitedThreads`); this module
// only notices what happened and decides which feed records to emit:
//
//   failed + usage_limit + reset known   -> quota_parked        (warn)
//   failed + usage_limit + no reset      -> quota_reset_unknown (warn)
//   parked thread starts a newer run     -> quota_resumed       (info)
//
// Each record is claimed in `state.posted` under (kind, thread, run) before it
// is returned, so a record is emitted at most once even across restarts,
// reconnects and snapshot replays. The function is pure apart from mutating
// `state`; persistence and delivery belong to the caller.
//
// The first snapshot on a host (no cursor yet) reports nothing: the observer
// starts from that point. When T3 later answers a resumed subscription with a
// snapshot instead of a replay, intermediate events are gone. A thread's `limitRecovery` still names the run
// T3 armed for recovery, so a snapshot showing that run already superseded is
// reconciled into the park and resume the observer missed.
import type { ShellEvent, ShellThread } from "../t3/adapter.ts";
import { MAX_STOP_AGE_MS, belowWatermark, recordKey, type ObserverState, type RecordKind } from "./state.ts";

export interface QuotaRecord {
  readonly kind: RecordKind;
  readonly severity: "info" | "warn";
  readonly threadId: string;
  readonly runId: string;
  readonly provider: string;
  readonly resetAt: string | null;
  /** quota_resumed only: the run that continued the thread. */
  readonly continuationRunId?: string;
  /** quota_resumed only: when that run started. */
  readonly continuationStartedAt?: string | null;
  /** quota_resumed only: seconds between the reset and the continuation start. */
  readonly latenessSeconds?: number | null;
  /** quota_resumed only: whether T3's armed auto-resume for this run was in place. */
  readonly trigger?: "auto_resume" | "other";
  /** Set for delegated child threads, which T3 auto-resumes like any other thread. */
  readonly subagent: boolean;
  /** Set when the record was reconstructed from a snapshot after the observer missed the events. */
  readonly reconciled?: true;
  readonly fromProvider?: string;
  readonly fromModel?: string;
  readonly toProvider?: string;
  readonly toModel?: string;
}

/**
 * The time a stop is filed under for age limits and eviction: its reset when
 * known, otherwise the failed run's completion. Both the live path and
 * snapshot reconciliation can compute it for the same stop.
 */
export function stopTime(resetAt: string | null, completedAt: string | null, nowMs: number): number {
  for (const value of [resetAt, completedAt]) {
    const ms = value === null ? Number.NaN : Date.parse(value);
    if (Number.isFinite(ms)) return ms;
  }
  return nowMs;
}

export function claim(state: ObserverState, kind: RecordKind, threadId: string, runId: string, stopAt: number, nowMs: number): boolean {
  if (nowMs - stopAt > MAX_STOP_AGE_MS || belowWatermark(state, stopAt)) return false;
  // A switched stop has no reset lateness. Its switch claim survives reconnects.
  if (kind === "quota_resumed" && [...state.switches.values()].some((intent) =>
    intent.threadId === threadId && intent.runId === runId &&
    (intent.phase === "switched" || intent.phase === "dispatching"))) return false;
  const key = recordKey(kind, threadId, runId);
  if (state.posted.has(key)) return false;
  state.posted.set(key, stopAt);
  return true;
}

function isUsageLimitStop(thread: ShellThread): boolean {
  return thread.status === "failed" && thread.lastErrorClass === "usage_limit" && thread.latestRunId !== null;
}

function secondsBetween(fromIso: string | null, toIso: string | null): number | null {
  if (fromIso === null || toIso === null) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 100) / 10;
}

function resumedRecord(
  thread: ShellThread,
  parked: { readonly runId: string; readonly resetAt: string | null; readonly provider: string },
  armed: boolean,
): QuotaRecord {
  return {
    kind: "quota_resumed",
    severity: "info",
    threadId: thread.id,
    runId: parked.runId,
    provider: parked.provider,
    resetAt: parked.resetAt,
    continuationRunId: thread.latestRunId!,
    continuationStartedAt: thread.latestRunStartedAt,
    latenessSeconds: secondsBetween(parked.resetAt, thread.latestRunStartedAt),
    trigger: armed ? "auto_resume" : "other",
    subagent: thread.relationshipToParent === "subagent",
  };
}

/** A snapshot shows a run T3 armed for recovery already superseded: report what was missed. */
function reconcile(state: ObserverState, thread: ShellThread, nowMs: number): Array<QuotaRecord> {
  const recovery = thread.limitRecovery;
  if (recovery === null || thread.latestRunId === null || recovery.runId === thread.latestRunId) return [];
  const stopAt = stopTime(recovery.resetAt, null, nowMs);
  const parked = { runId: recovery.runId, resetAt: recovery.resetAt, provider: thread.providerInstanceId };
  const records: Array<QuotaRecord> = [];
  if (claim(state, "quota_parked", thread.id, recovery.runId, stopAt, nowMs)) {
    records.push({
      kind: "quota_parked",
      severity: "warn",
      threadId: thread.id,
      runId: recovery.runId,
      provider: thread.providerInstanceId,
      resetAt: recovery.resetAt,
      subagent: thread.relationshipToParent === "subagent",
      reconciled: true,
    });
  }
  if (claim(state, "quota_resumed", thread.id, recovery.runId, stopAt, nowMs)) {
    records.push({ ...resumedRecord(thread, parked, recovery.autoResume), reconciled: true });
  }
  return records;
}

/** Applies one thread observation and returns the records it newly calls for. */
export function observeThread(
  state: ObserverState,
  thread: ShellThread,
  nowMs: number,
  options: { readonly fromSnapshot?: boolean } = {},
): Array<QuotaRecord> {
  const records: Array<QuotaRecord> = [];

  if (thread.deleted || thread.archived) {
    state.parked.delete(thread.id);
    return records;
  }

  const parked = state.parked.get(thread.id);
  if (parked !== undefined && thread.latestRunId !== null && thread.latestRunId !== parked.runId) {
    // A newer run exists, so the parked run was continued: natively, or by hand.
    state.parked.delete(thread.id);
    const recovery = thread.limitRecovery;
    const armed = recovery !== null && recovery.runId === parked.runId && recovery.autoResume;
    if (claim(state, "quota_resumed", thread.id, parked.runId, parked.stopAt, nowMs)) {
      records.push(resumedRecord(thread, parked, armed));
    }
  }
  if (options.fromSnapshot === true) {
    // limitRecovery may name a later stop than the cached park (stop A,
    // continuation, stop B, continuation, all while away); dedupe makes
    // reconciling the cached run again harmless.
    records.push(...reconcile(state, thread, nowMs));
  }

  if (!isUsageLimitStop(thread)) return records;
  const runId = thread.latestRunId!;
  const resetAt = thread.usageLimitResetAt;
  const stopAt = stopTime(resetAt, thread.latestRunCompletedAt, nowMs);
  if (nowMs - stopAt > MAX_STOP_AGE_MS) return records;
  const current = state.parked.get(thread.id);
  if (current === undefined || current.runId !== runId || current.resetAt !== resetAt) {
    state.parked.set(thread.id, {
      runId,
      resetAt,
      provider: thread.providerInstanceId,
      stopAt,
      seenAt: current?.runId === runId ? current.seenAt : nowMs,
    });
  }
  const kind: RecordKind = resetAt === null ? "quota_reset_unknown" : "quota_parked";
  if (claim(state, kind, thread.id, runId, stopAt, nowMs)) {
    records.push({
      kind,
      severity: "warn",
      threadId: thread.id,
      runId,
      provider: thread.providerInstanceId,
      resetAt,
      subagent: thread.relationshipToParent === "subagent",
    });
  }
  return records;
}

/**
 * Absorbs one thread of the first snapshot: keys for history are claimed
 * silently so later snapshots cannot reconcile it, and a thread parked at this
 * moment is cached so its resume is still reported. The one exception is a
 * thread parked right now with no reset: it stays parked until a later event
 * supplies one, so its single warning is posted rather than suppressed.
 */
function seed(state: ObserverState, thread: ShellThread, nowMs: number): Array<QuotaRecord> {
  if (thread.deleted || thread.archived) return [];
  // A stop already continued is history: claim what a later snapshot would reconcile.
  const recovery = thread.limitRecovery;
  if (recovery !== null && thread.latestRunId !== null && recovery.runId !== thread.latestRunId) {
    const stopAt = stopTime(recovery.resetAt, null, nowMs);
    claim(state, "quota_parked", thread.id, recovery.runId, stopAt, nowMs);
    claim(state, "quota_resumed", thread.id, recovery.runId, stopAt, nowMs);
  }
  if (!isUsageLimitStop(thread)) return [];
  const runId = thread.latestRunId!;
  const resetAt = thread.usageLimitResetAt;
  const stopAt = stopTime(resetAt, thread.latestRunCompletedAt, nowMs);
  if (nowMs - stopAt > MAX_STOP_AGE_MS) return [];
  state.parked.set(thread.id, { runId, resetAt, provider: thread.providerInstanceId, stopAt, seenAt: nowMs });
  if (resetAt !== null) {
    claim(state, "quota_parked", thread.id, runId, stopAt, nowMs);
    return [];
  }
  if (!claim(state, "quota_reset_unknown", thread.id, runId, stopAt, nowMs)) return [];
  return [{
    kind: "quota_reset_unknown",
    severity: "warn",
    threadId: thread.id,
    runId,
    provider: thread.providerInstanceId,
    resetAt: null,
    subagent: thread.relationshipToParent === "subagent",
    reconciled: true,
  }];
}

/** Applies one shell event, advancing the cursor, and returns new records. */
export function observe(state: ObserverState, event: ShellEvent, nowMs: number): Array<QuotaRecord> {
  switch (event.kind) {
    case "synchronized":
      return [];
    case "cursor":
      state.cursor = Math.max(state.cursor ?? 0, event.sequence);
      return [];
    case "removed":
      state.parked.delete(event.threadId);
      state.cursor = Math.max(state.cursor ?? 0, event.sequence);
      return [];
    case "thread": {
      const records = observeThread(state, event.thread, nowMs);
      state.cursor = Math.max(state.cursor ?? 0, event.sequence);
      return records;
    }
    case "snapshot": {
      if (state.cursor === null) {
        // First run on this host: start from now. History is not reported;
        // threads parked at this moment are remembered so their resume is,
        // and a resetless one gets its single warning.
        const records = event.threads.flatMap((thread) => seed(state, thread, nowMs));
        state.cursor = event.sequence;
        return records;
      }
      // A snapshot replaces the replay when T3 cannot serve the cursor. Threads
      // missing from it are not treated as removed: enrichment snapshots can be partial.
      const records = event.threads.flatMap((thread) => observeThread(state, thread, nowMs, { fromSnapshot: true }));
      state.cursor = event.sequence;
      return records;
    }
  }
}
