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
export interface ResultItem {
  type: string; id: string; threadId: string; runId: string | null; nodeId: string | null;
  ordinal: number; status?: string; streaming?: boolean; text?: string;
}
export interface ResultProjection {
  thread: { id: string };
  runs: ReadonlyArray<{ id: string; threadId: string; rootNodeId: string | null; status?: string }>;
  nodes?: ReadonlyArray<{ id: string; threadId: string; runId: string | null; kind: string;
    rootNodeId: string; parentNodeId: string | null; status: string }>;
  turnItems: ReadonlyArray<ResultItem>;
}
type Candidate = Exclude<ResultRead, { kind: "found" }> | { kind: "candidate"; item: ResultItem };
/**
 * Official 0.1.0 assistant items belong to a completed assistant_message node
 * directly under the completed run root. Never walk through a native child.
 * Missing timeline IDs stay unavailable; do not infer an ID or use latest message.
 */
function finalCandidate(p: ResultProjection, threadId: string, runId: string): Candidate {
  if (p.thread.id !== threadId) return { kind: "ambiguous", detail: "thread_mismatch" };
  const runs = p.runs.filter(r => r.id === runId), run = runs[0];
  if (!run) return { kind: "missing" };
  if (runs.length !== 1) return { kind: "ambiguous", detail: "duplicate_run" };
  if (run.threadId !== threadId) return { kind: "ambiguous", detail: "run_thread_mismatch" };
  if (!run.rootNodeId) return { kind: "ambiguous", detail: "root_node_unknown" };
  if (run.status !== "completed") return { kind: "ambiguous", detail: "run_not_completed" };
  const roots = p.nodes?.filter(n => n.id === run.rootNodeId) ?? [], root = roots[0];
  if (roots.length !== 1 || !root || root.threadId !== threadId || root.runId !== runId ||
      root.kind !== "root_turn" || root.parentNodeId !== null || root.rootNodeId !== root.id || root.status !== "completed")
    return { kind: "ambiguous", detail: "root_node_invalid" };
  const owns = (nodeId: string | null): boolean => {
    if (nodeId === root.id) return true;
    const nodes = p.nodes?.filter(n => n.id === nodeId) ?? [], node = nodes[0];
    return nodes.length === 1 && node !== undefined && node.threadId === threadId && node.runId === runId &&
      node.kind === "assistant_message" && node.rootNodeId === root.id && node.parentNodeId === root.id;
  };
  const items = p.turnItems.filter(i => i.type === "assistant_message" && i.threadId === threadId &&
    i.runId === runId && owns(i.nodeId)).toSorted((a, b) => b.ordinal - a.ordinal);
  const last = items[0];
  if (!last) return { kind: "missing" };
  if (!last.id || !Number.isSafeInteger(last.ordinal) || last.ordinal < 0 ||
      items.some((i, index) => index > 0 && (i.id === last.id || i.ordinal === last.ordinal)))
    return { kind: "ambiguous", detail: "item_identity_ambiguous" };
  if (last.status !== "completed" || p.nodes!.find(n => n.id === last.nodeId)!.status !== "completed")
    return { kind: "ambiguous", detail: "item_not_completed" };
  if (last.streaming !== false) return { kind: "ambiguous", detail: "streaming" };
  return { kind: "candidate", item: last };
}
export function finalAssistant(p: ResultProjection, threadId: string, runId: string): ResultRead {
  const candidate = finalCandidate(p, threadId, runId);
  if (candidate.kind !== "candidate") return candidate;
  const item = candidate.item;
  return typeof item.text === "string" ? { kind: "found", text: item.text, itemId: item.id } : { kind: "missing" };
}
/** Public point read of the selected ID only. Transport errors propagate to the existing retry path. */
export async function readFinalAssistant(p: ResultProjection, threadId: string, runId: string,
  getItem: (threadId: string, itemId: string) => Promise<ResultItem | null>): Promise<ResultRead> {
  const candidate = finalCandidate(p, threadId, runId);
  if (candidate.kind !== "candidate") return candidate;
  const expected = candidate.item, item = await getItem(threadId, expected.id);
  if (item === null) return { kind: "missing" };
  if (item.id !== expected.id || item.threadId !== threadId || item.runId !== runId ||
      item.nodeId !== expected.nodeId || item.type !== "assistant_message" || item.ordinal !== expected.ordinal)
    return { kind: "ambiguous", detail: "item_read_mismatch" };
  if (item.status !== "completed") return { kind: "ambiguous", detail: "item_not_completed" };
  if (item.streaming !== false) return { kind: "ambiguous", detail: "streaming" };
  return typeof item.text === "string" ? { kind: "found", text: item.text, itemId: item.id } : { kind: "missing" };
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
        return yield* Effect.promise(() => readFinalAssistant(projection as unknown as ResultProjection, threadId, runId,
          (threadId, itemId) => Effect.runPromise(client["orchestration.getTurnItem"]({ threadId, itemId } as never)
            .pipe(Effect.map(r => r.item as ResultItem | null)))));
      }));
    },
  };
}
