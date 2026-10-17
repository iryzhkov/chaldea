// Wait-specific T3 boundary. Transcripts and credentials never enter the journal.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import { switchIds } from "../quota/switcher.ts";
import { withClient, dispatchChaldeaWake, respondChaldeaDecision, type ConnectOptions, type WsClient } from "./adapter.ts";
import type { OrchestrationV2ThreadProjection, OrchestrationV2UserInputQuestion } from "../../vendor/t3-contracts/src/index.ts";

export interface WaitRun {
  id: string; ordinal: number; status: string; started: string | null; workStarted: string | null;
  restartOf: string | null; continuationOf?: string; failure: string | null; root: string | null;
}
export interface NativeRequest {
  id: string; kind: string; status: "pending" | "resolved" | "expired" | "cancelled";
  capability: "live" | "message" | "not_resumable"; created: number;
  questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}
export interface WaitSnapshot {
  id: string; project: string; archived: boolean; deleted: boolean; settled: boolean;
  runs: WaitRun[];
  pendingRuns: Array<string | null>;
  requests?: NativeRequest[];
  children: Array<{id:string; runId:string|null; childThreadId:string|null; status:string; delivery?:string}>;
}
export interface WaitT3 {
  environment(): Promise<string>;
  snapshot(id: string): Promise<WaitSnapshot | null>;
  observe(id: string, signal: AbortSignal, onSnapshot: (snapshot: WaitSnapshot | null, cursor: number) => void): Promise<void>;
  dispatch(payload: string): Promise<void>;
  respond?(payload: string): Promise<boolean>;
}
const iso = (v: DateTime.Utc | null | undefined) => v == null ? null : DateTime.formatIso(v);
export function waitSnapshot(p: OrchestrationV2ThreadProjection): WaitSnapshot {
  return {
    id:p.thread.id,project:p.thread.projectId,archived:p.thread.archivedAt !== null,
    deleted:p.thread.deletedAt !== null,settled:p.thread.settledOverride === "settled",
    runs:p.runs.map(r => {
      const failure = p.turnItems.filter(i => i.type === "error" && i.runId === r.id && i.nodeId === r.rootNodeId && i.status === "failed")
        .toSorted((a,b) => b.ordinal-a.ordinal)[0];
      // 0.1.0 persists restart lineage but drops manual/usage continuation fields
      // from runs. These two qualified producers retain exact source identity in
      // userMessageId. Do not guess from generic newer runs or prompt text.
      const previous = p.runs.find(source => source.ordinal < r.ordinal && source.status === "failed" &&
        (r.userMessageId === switchIds(p.thread.id,source.id).dispatch ||
          r.userMessageId.startsWith("limit-resume:" + p.thread.id + ":" + source.id + ":")));
      return {...(previous ? {continuationOf:previous.id} : {}),id:r.id,ordinal:r.ordinal,status:r.status,started:iso(r.startedAt),workStarted:iso(r.workStartedAt),
        restartOf:r.restartContinuationOfRunId??null,root:r.rootNodeId,
        failure:failure?.type === "error" ? failure.failure?.class??null : null};
    }),
    requests:p.runtimeRequests.map(r => {
      const item=p.turnItems.find(i => i.type === "user_input_request" && i.requestId === r.id);
      return {id:r.id,kind:r.kind,status:r.status,capability:r.responseCapability.type,
        created:Date.parse(DateTime.formatIso(r.createdAt)),questions:item?.type === "user_input_request" ? item.questions : []};
    }),
    pendingRuns:p.runtimeRequests.filter(r => r.status === "pending").map(r => p.nodes.find(n => n.id === r.nodeId)?.runId ?? null),
    children:p.subagents.map(s => ({id:s.id,runId:s.runId,childThreadId:s.childThreadId,status:s.status,...(s.completionDelivery ? {delivery:s.completionDelivery.state} : {})})),
  };
}
/** A projection error alone is never evidence of deletion. */
export function readProjection(client: WsClient, id: string) {
  return client["orchestration.getThreadProjection"]({threadId:id} as never).pipe(
    Effect.map(waitSnapshot),
    Effect.catchTag("OrchestrationV2GetThreadProjectionError", original =>
      client["orchestration.subscribeShell"]({}).pipe(Stream.take(1),Stream.runCollect,Effect.flatMap(items => {
        const first=items[0];
        if (first?.kind !== "snapshot") return Effect.fail(original);
        const exists=[...first.snapshot.threads,...first.snapshot.archivedThreads].some(t=>t.id===id && t.deletedAt===null);
        if (exists) return Effect.fail(original);
        // 0.1.0's active stream always has archivedThreads:[]; absence there
        // alone cannot establish deletion. Verify the separate archived view.
        return client["orchestration.getArchivedShellSnapshot"]({}).pipe(
          Effect.flatMap(archived=>archived.threads.some(t=>t.id===id && t.deletedAt===null)
            ? Effect.fail(original) : Effect.succeed(null)));
      }))));
}
export function createWaitT3(options: () => ConnectOptions, expectedEnvironment: string): WaitT3 {
  const checked = async (): Promise<ConnectOptions> => {
    const opts = options();
    const environment = await withClient(opts,c => c["server.getConfig"]({}).pipe(Effect.map(c => String(c.environment.environmentId))));
    if (environment !== expectedEnvironment) throw new Error("T3 environment mismatch; work remains parked");
    return opts;
  };
  return {
    async environment() {
      await checked(); return expectedEnvironment;
    },
    async snapshot(id) {
      return withClient(await checked(), c => readProjection(c,id));
    },
    async observe(id, signal, onSnapshot) {
      const opts = await checked();
      await withClient({...opts,signal},c => c["orchestration.subscribeThread"]({
        threadId:id,requestCompletionMarker:true,
        // Request a full projection: a missing pinned run must never be mistaken for success.
      } as never).pipe(Stream.runForEach(item => {
        if (item.kind === "snapshot") return Effect.sync(() => onSnapshot(waitSnapshot(item.projection),item.snapshotSequence));
        if (item.kind === "event" && (/^(thread|run|subagent|runtime-request)\./.test(item.event.type) ||
          (item.event.type === "turn-item.updated" && ["error","user_input_request"].includes(item.event.payload.type))))
          return readProjection(c,id).pipe(
            Effect.tap(p => Effect.sync(() => onSnapshot(p,item.sequence))), Effect.asVoid);
        return Effect.void;
      }), Effect.catchTag("OrchestrationV2GetThreadProjectionError", () =>
        readProjection(c,id).pipe(Effect.tap(p=>Effect.sync(()=>onSnapshot(p,0))),Effect.asVoid))));
    },
    async respond(payload) { return respondChaldeaDecision(await checked(),payload); },
    async dispatch(payload) {
      await dispatchChaldeaWake(await checked(), payload);
    },
  };
}
