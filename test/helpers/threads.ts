import type { ShellThread } from "../../src/t3/adapter.ts";

export const T0 = Date.parse("2026-10-16T12:00:00.000Z");

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export function thread(overrides: Partial<ShellThread> = {}): ShellThread {
  return {
    id: "thread-a",
    status: "idle",
    providerInstanceId: "claudeAgent",
    latestRunId: null,
    activeRunId: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    lastErrorClass: null,
    usageLimitResetAt: null,
    limitRecovery: null,
    relationshipToParent: null,
    archived: false,
    deleted: false,
    ...overrides,
  };
}

/** A thread whose run `runId` stopped on a usage limit at `atMs`. */
export function limited(runId: string, atMs: number, resetAt: string | null, overrides: Partial<ShellThread> = {}): ShellThread {
  return thread({
    status: "failed",
    latestRunId: runId,
    latestRunStartedAt: iso(atMs - 1_000),
    latestRunCompletedAt: iso(atMs),
    lastErrorClass: "usage_limit",
    usageLimitResetAt: resetAt,
    ...overrides,
  });
}
