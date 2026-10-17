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
export type NativeQuestion = Pick<OrchestrationV2UserInputQuestion,"id"|"allowCustomAnswer"|"multiSelect"> &
  Partial<Pick<OrchestrationV2UserInputQuestion,"header"|"question">> &
  {options:ReadonlyArray<{label:string;value?:string|undefined;description?:string|undefined}>};
export interface NativeRequest {
  id: string; nodeId?:string; itemId?:string; kind: string; status: "pending" | "resolved" | "expired" | "cancelled";
  capability: "live" | "message" | "not_resumable"; created: number;
  questions: ReadonlyArray<NativeQuestion>;
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
  snapshot(id: string,nativeRequestId?:string): Promise<WaitSnapshot | null>;
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
      return {id:r.id,nodeId:r.nodeId,...(item?{itemId:item.id}:{}),kind:r.kind,status:r.status,capability:r.responseCapability.type,
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
type TrackedNative = {request_id:string|null;turn_item:string|null;questions:string|null;created?:number;bind_until?:number;baseline?:string};
/** Point reads recover questions and resolutions omitted by bounded history.
 * The candidate ID uses pinned IdAllocator.node/turnItemFromProviderItem;
 * a returned item must match BOTH user_input_request and the exact request ID.
 */
export function nativeProjection(client:WsClient,threadId:string,snapshot:WaitSnapshot|null,tracked:readonly TrackedNative[],requestedId?:string){
  return Effect.gen(function*(){
  if(!snapshot)return null;
  const requests=snapshot.requests??[];
  const wanted=new Set(requestedId?[requestedId]:[]);
  for(const preparation of tracked.filter(p=>p.request_id===null)){
    const baseline=new Set<string>(JSON.parse(preparation.baseline??"[]"));
    const first=requests.filter(r=>r.kind==="user_input" && !baseline.has(r.id) && r.created>=(preparation.created??0) &&
      r.created<=(preparation.bind_until??Infinity)).sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id))[0];
    if(first)wanted.add(first.id);
  }
  const missing=tracked.filter(p=>p.request_id && p.turn_item && !requests.some(r=>r.id===p.request_id));
  return yield* Effect.forEach([...requests,...missing.map<NativeRequest>(p=>({id:p.request_id!,itemId:p.turn_item!,kind:"user_input",
    status:"pending" as const,capability:"not_resumable" as const,created:0,questions:[]}))],request=>{
    const policy=tracked.find(p=>p.request_id===request.id);
    if(request.kind!=="user_input" || (request.questions.length && !missing.some(p=>p.request_id===request.id)))return Effect.succeed(request);
    if(requests.includes(request) && policy?.questions){
      return Effect.succeed({...request,...(policy.turn_item?{itemId:policy.turn_item}:{}),questions:JSON.parse(policy.questions) as NativeRequest["questions"]});
    }
    if(!wanted.has(request.id) && !policy)return Effect.succeed(request);
    const candidate=request.itemId??(request.nodeId?.startsWith("node:provider:")
      ? "turn-item:"+request.nodeId.slice("node:".length):undefined);
    if(!candidate)return Effect.succeed(request);
    return client["orchestration.getTurnItem"]({threadId,itemId:candidate} as never).pipe(Effect.map(result=>{
      const item=result.item;
      if(!item || item.type!=="user_input_request" || item.requestId!==request.id || item.id!==candidate || item.threadId!==threadId)return request;
      return {...request,itemId:item.id,questions:item.questions,
        status:missing.some(p=>p.request_id===request.id)
          ? item.status==="completed"?"resolved" as const:item.status==="cancelled"?"cancelled" as const:item.status==="failed"?"expired" as const:"pending" as const
          : request.status,
        capability:item.responseMode==="message"?"message" as const:request.capability,
        created:request.created||Date.parse(DateTime.formatIso(item.startedAt??item.updatedAt))};
    }));
  },{concurrency:4}).pipe(Effect.map(values=>({...snapshot,requests:values})));
  });
}
export function createWaitT3(options: () => ConnectOptions, expectedEnvironment: string,
  tracked:(threadId:string)=>readonly TrackedNative[]=()=>[]): WaitT3 {
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
    async snapshot(id,nativeRequestId) {
      return withClient(await checked(), c => readProjection(c,id).pipe(Effect.flatMap(p=>nativeProjection(c,id,p,tracked(id),nativeRequestId))));
    },
    async observe(id, signal, onSnapshot) {
      const opts = await checked();
      await withClient({...opts,signal},c => c["orchestration.subscribeThread"]({
        threadId:id,requestCompletionMarker:true,
        // Control arrays retain pinned runs; timeline rows can be bounded.
      } as never).pipe(Stream.runForEach(item => {
        if (item.kind === "snapshot") return nativeProjection(c,id,waitSnapshot(item.projection),tracked(id)).pipe(
          Effect.tap(p=>Effect.sync(()=>onSnapshot(p,item.snapshotSequence))),Effect.asVoid);
        if (item.kind === "event" && (/^(thread|run|subagent|runtime-request)\./.test(item.event.type) ||
          (item.event.type === "turn-item.updated" && ["error","user_input_request"].includes(item.event.payload.type))))
          return readProjection(c,id).pipe(Effect.flatMap(p=>nativeProjection(c,id,p,tracked(id))),
            Effect.tap(p => Effect.sync(() => onSnapshot(p,item.sequence))), Effect.asVoid);
        return Effect.void;
      }), Effect.catchTag("OrchestrationV2GetThreadProjectionError", () =>
        readProjection(c,id).pipe(Effect.flatMap(p=>nativeProjection(c,id,p,tracked(id))),Effect.tap(p=>Effect.sync(()=>onSnapshot(p,0))),Effect.asVoid))));
    },
    async respond(payload) { return respondChaldeaDecision(await checked(),payload); },
    async dispatch(payload) {
      await dispatchChaldeaWake(await checked(), payload);
    },
  };
}
