// Session-specific official T3 seam: typed launchThread and the root run result.
// Composes the public adapter client; credentials and transcripts never enter the journal.
import * as Effect from "effect/Effect";
import { withClient, type ConnectOptions } from "../t3/adapter.ts";
import { presetMessage, type SessionPreset } from "./policy.ts";

/** not_sent: no launch request left this process, so a later attempt is safe. */
export type LaunchResult =
  | { kind: "accepted"; threadId: string; resumed: boolean }
  | { kind: "rejected"; detail: string }
  | { kind: "not_sent"; detail: string };
export type ResultRead = { kind: "found"; text: string; itemId: string } | { kind: "missing" } | { kind: "ambiguous"; detail: string };
export interface SessionT3 {
  /** Resolves with a definite answer or throws when the outcome is uncertain. */
  launch(payload: string): Promise<LaunchResult>;
  result(threadId: string, runId: string): Promise<ResultRead>;
}
export interface LaunchIdentity { commandId: string; messageId: string; threadId: string; payload: string }
/** Every launch field comes from the protected preset and identities persisted before dispatch. */
export function launchPayload(sessionId: string, threadId: string, preset: SessionPreset): LaunchIdentity {
  const commandId = "chaldea-session:" + sessionId + ":launch", messageId = "chaldea-session:" + sessionId + ":message";
  const payload = JSON.stringify({
    commandId, creationSource: "server", threadId, projectId: preset.projectId, title: preset.title,
    modelSelection: { instanceId: preset.instanceId, model: preset.model, ...(preset.options ? { options: preset.options } : {}) },
    runtimeMode: preset.runtimeMode, interactionMode: preset.interactionMode, workspaceStrategy: { type: "root" },
    initialMessage: { messageId, text: presetMessage(preset), attachments: [] },
  });
  return { commandId, messageId, threadId, payload };
}
export interface ResultProjection {
  thread: { id: string };
  runs: ReadonlyArray<{ id: string; threadId: string; rootNodeId: string | null }>;
  turnItems: ReadonlyArray<{ type: string; id: string; threadId: string; runId: string | null; nodeId: string | null;
    ordinal: number; streaming?: boolean; text?: string }>;
}
/**
 * The final non-streaming assistant message of the run's ROOT node. Native
 * child nodes may share the run ID, so the node binding is required; a missing
 * or still-streaming item is reported, never replaced by another message.
 */
export function finalAssistant(p: ResultProjection, threadId: string, runId: string): ResultRead {
  if (p.thread.id !== threadId) return { kind: "ambiguous", detail: "thread_mismatch" };
  const run = p.runs.find(r => r.id === runId);
  if (!run) return { kind: "missing" };
  if (run.threadId !== threadId) return { kind: "ambiguous", detail: "run_thread_mismatch" };
  if (!run.rootNodeId) return { kind: "ambiguous", detail: "root_node_unknown" };
  const last = p.turnItems.filter(i => i.type === "assistant_message" && i.threadId === threadId && i.runId === runId &&
    i.nodeId === run.rootNodeId).toSorted((a, b) => a.ordinal - b.ordinal).at(-1);
  if (!last || typeof last.text !== "string") return { kind: "missing" };
  if (last.streaming !== false) return { kind: "ambiguous", detail: "streaming" };
  return { kind: "found", text: last.text, itemId: last.id };
}
export function createSessionT3(options: () => ConnectOptions, expectedEnvironment: string): SessionT3 {
  return {
    async launch(payload) {
      let sent = false;
      try {
        return await withClient(options(), client => Effect.gen(function* () {
          const config = yield* client["server.getConfig"]({});
          if (String(config.environment.environmentId) !== expectedEnvironment)
            return { kind: "not_sent", detail: "environment_mismatch" } as LaunchResult;
          sent = true;
          return yield* client["orchestration.launchThread"](JSON.parse(payload) as never).pipe(
            Effect.map(r => ({ kind: "accepted", threadId: String(r.threadId), resumed: r.resumed }) as LaunchResult),
            // Typed refusals are definitive: the server answered and did not launch.
            Effect.catchTag("OrchestrationV2ThreadLaunchError", e => Effect.succeed({ kind: "rejected", detail: e.message.slice(0, 256) } as LaunchResult)),
            Effect.catchTag("EnvironmentAuthorizationError", e => Effect.succeed({ kind: "rejected", detail: ("unauthorized: " + e.message).slice(0, 256) } as LaunchResult)));
        }));
      } catch (error) {
        // Before the request was written nothing can have launched; afterwards it is uncertain.
        if (!sent) return { kind: "not_sent", detail: error instanceof Error ? error.name : "connection" };
        throw error;
      }
    },
    async result(threadId, runId) {
      return withClient(options(), client => Effect.gen(function* () {
        const config = yield* client["server.getConfig"]({});
        if (String(config.environment.environmentId) !== expectedEnvironment) return yield* Effect.fail(new Error("T3 environment mismatch"));
        const projection = yield* client["orchestration.getThreadProjection"]({ threadId } as never);
        return finalAssistant(projection as unknown as ResultProjection, threadId, runId);
      }));
    },
  };
}
