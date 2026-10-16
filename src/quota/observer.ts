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
import type { ShellEvent, ShellThread } from "../t3/adapter.ts";
import { MAX_STOP_AGE_MS, recordKey, type ObserverState, type RecordKind } from "./state.ts";

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
}

function claim(state: ObserverState, kind: RecordKind, threadId: string, runId: string, nowMs: number): boolean {
  const key = recordKey(kind, threadId, runId);
  if (state.posted.has(key)) return false;
  state.posted.set(key, nowMs);
  return true;
}

function isUsageLimitStop(thread: ShellThread): boolean {
  return thread.status === "failed" && thread.lastErrorClass === "usage_limit" && thread.latestRunId !== null;
}

function tooOld(thread: ShellThread, nowMs: number): boolean {
  const completed = thread.latestRunCompletedAt === null ? Number.NaN : Date.parse(thread.latestRunCompletedAt);
  return Number.isFinite(completed) && nowMs - completed > MAX_STOP_AGE_MS;
}

function secondsBetween(fromIso: string | null, toIso: string | null): number | null {
  if (fromIso === null || toIso === null) return null;
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / 100) / 10;
}

/** Applies one thread observation and returns the records it newly calls for. */
export function observeThread(state: ObserverState, thread: ShellThread, nowMs: number): Array<QuotaRecord> {
  const records: Array<QuotaRecord> = [];
  const subagent = thread.relationshipToParent === "subagent";

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
    if (claim(state, "quota_resumed", thread.id, parked.runId, nowMs)) {
      records.push({
        kind: "quota_resumed",
        severity: "info",
        threadId: thread.id,
        runId: parked.runId,
        provider: parked.provider,
        resetAt: parked.resetAt,
        continuationRunId: thread.latestRunId,
        continuationStartedAt: thread.latestRunStartedAt,
        latenessSeconds: secondsBetween(parked.resetAt, thread.latestRunStartedAt),
        trigger: armed ? "auto_resume" : "other",
        subagent,
      });
    }
  }

  if (!isUsageLimitStop(thread) || tooOld(thread, nowMs)) return records;
  const runId = thread.latestRunId!;
  const resetAt = thread.usageLimitResetAt;
  const current = state.parked.get(thread.id);
  if (current === undefined || current.runId !== runId || current.resetAt !== resetAt) {
    state.parked.set(thread.id, {
      runId,
      resetAt,
      provider: thread.providerInstanceId,
      seenAt: current?.runId === runId ? current.seenAt : nowMs,
    });
  }
  const kind: RecordKind = resetAt === null ? "quota_reset_unknown" : "quota_parked";
  if (claim(state, kind, thread.id, runId, nowMs)) {
    records.push({
      kind,
      severity: "warn",
      threadId: thread.id,
      runId,
      provider: thread.providerInstanceId,
      resetAt,
      subagent,
    });
  }
  return records;
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
      // A snapshot replaces the replay when T3 cannot serve the cursor. Threads
      // missing from it are not treated as removed: enrichment snapshots can be partial.
      const records = event.threads.flatMap((thread) => observeThread(state, thread, nowMs));
      state.cursor = event.sequence;
      return records;
    }
  }
}
