// T3-specific restart reads and command construction stay at the adapter boundary.
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { AbortedError, connectShell, toSwitchThread, withClient,
  type ConnectOptions, type ModelChoice, type ShellThread } from "./adapter.ts";

export const RESTART_TEXT = "T3 restarted while this turn was running. Check the current state before repeating any action, then continue the task.";
// Share the pinned server's identity: its native recovery can win the race too.
export const restartMessageId = (runId: string) => `message:restart-continuation:${runId}`;
export const restartCommandId = (runId: string) => `command:restart-continuation:${runId}`;

export async function restartSnapshot(options: ConnectOptions): Promise<ReadonlyArray<ShellThread>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  const threads = new Map<string, ShellThread>();
  let synchronized = false;
  try {
    await connectShell({ ...options, signal: controller.signal }, { onEvent(event) {
      if (event.kind === "snapshot") for (const thread of event.threads) threads.set(thread.id, thread);
      if (event.kind === "thread") threads.set(event.thread.id, event.thread);
      if (event.kind === "removed") threads.delete(event.threadId);
      if (event.kind === "synchronized") { synchronized = true; controller.abort(); }
    } });
  } catch (error) {
    if (!(error instanceof AbortedError) || !synchronized) throw error;
  } finally { clearTimeout(timer); }
  if (!synchronized) throw new Error("T3 shell did not synchronize");
  return [...threads.values()];
}

export async function restartProjection(options: ConnectOptions, threadId: string, runId?: string) {
  return withClient(options, client => client["orchestration.getThreadProjection"]({ threadId } as never).pipe(
    Effect.map(p => {
      const thread = toSwitchThread(p);
      const run = p.runs.find(r => r.id === (runId ?? thread.activeRunId ?? thread.latestRunId));
      let chain = 0;
      for (let r = run; r?.restartContinuationOfRunId && chain < 3; chain++)
        r = p.runs.find(candidate => candidate.id === r!.restartContinuationOfRunId);
      const sourceMessage = p.messages.find(m => m.id === run?.userMessageId);
      const blocked = chain >= 3 ||
        (p.thread.snoozedUntil != null && DateTime.toEpochMillis(p.thread.snoozedUntil) > Date.now()) ||
        (sourceMessage?.attachments.length === 0 && ["/compact", "/logout"].includes(sourceMessage.text.trim().toLowerCase()));
      return {
        thread, run, blocked,
        continued: runId !== undefined && (p.messages.some(m => m.id === restartMessageId(runId)) ||
          p.runs.some(r => r.restartContinuationOfRunId === runId)),
        interrupted: p.turnItems.some(i => i.runId === run?.id && i.type === "run_interrupt_request"),
        // A live callback can expire during shutdown; that is still an unanswered question.
        waitingForUser: p.runtimeRequests.some(r => p.nodes.some(n => n.id === r.nodeId && n.runId === run?.id) &&
          r.kind !== "dynamic_tool_call" && r.kind !== "auth_refresh" &&
          (r.status === "pending" || r.status === "expired" || r.status === "cancelled")) ||
          p.turnItems.some(i => i.runId === run?.id && i.type === "secret_request" &&
            ["pending", "cancelled"].includes(i.secretStatus)),
      };
    }),
    Effect.catchTag("OrchestrationV2GetThreadProjectionError", () => Effect.succeed(undefined)),
    Effect.timeout("5 seconds"),
  ));
}

export function restartPayload(threadId: string, runId: string, model: ModelChoice): string {
  return JSON.stringify({
    type: "message.dispatch", commandId: restartCommandId(runId),
    messageId: restartMessageId(runId), threadId, restartContinuationOfRunId: runId,
    modelSelection: model, text: RESTART_TEXT, attachments: [],
    dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "server",
  });
}
