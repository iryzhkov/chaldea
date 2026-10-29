// The only module that knows T3's wire protocol.
//
// Everything T3-specific lives here: the vendored contracts, the Effect RPC
// client, the WebSocket handshake, protocol gating and the mapping of shell
// stream items to the small domain type the quota observer consumes. The rest
// of Chaldea sees `connectShell` and the types below, nothing else.
import type { DetailEvent, Detail, Resources } from "../mission-control/details.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import WebSocket from "ws";

import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadProjection,
} from "../../vendor/t3-contracts/src/index.ts";

/** The orchestration protocol this adapter was written and tested against. */
export const SUPPORTED_PROTOCOL_VERSION = 2;

if (ORCHESTRATION_PROTOCOL_VERSION !== SUPPORTED_PROTOCOL_VERSION) {
  // The vendored contracts moved without the adapter being reviewed for it.
  throw new Error(
    `Vendored T3 contracts speak orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}; the adapter supports ${SUPPORTED_PROTOCOL_VERSION}.`,
  );
}

/** A thread as the quota observer needs to see it. Times are ISO strings. */
export interface ShellThread {
  readonly title?: string;
  readonly id: string;
  readonly status: string;
  readonly providerInstanceId: string;
  readonly modelSelection?: ModelChoice;
  readonly settled?: boolean;
  readonly pendingRequest?: boolean;
  readonly pendingRequestKind?: string;
  readonly latestRunId: string | null;
  readonly activeRunId: string | null;
  readonly latestRunStartedAt: string | null;
  readonly latestRunCompletedAt: string | null;
  readonly lastErrorClass: string | null;
  readonly usageLimitResetAt: string | null;
  readonly limitRecovery: {
    readonly runId: string;
    readonly resetAt: string;
    readonly autoResume: boolean;
    readonly requestId?: string;
    readonly snooze?: boolean;
  } | null;
  readonly relationshipToParent: "fork" | "subagent" | null;
  readonly archived: boolean;
  readonly deleted: boolean;
}

export type ShellEvent =
  | { readonly kind: "snapshot"; readonly sequence: number; readonly threads: ReadonlyArray<ShellThread> }
  | { readonly kind: "thread"; readonly sequence: number; readonly thread: ShellThread }
  | { readonly kind: "removed"; readonly sequence: number; readonly threadId: string }
  | { readonly kind: "cursor"; readonly sequence: number }
  | { readonly kind: "synchronized" };

/** T3 refused the orchestration protocol (HTTP 426) or sent data the pinned contracts reject. */
export class ProtocolIncompatibleError extends Error {
  override readonly name = "ProtocolIncompatibleError";
}

/** The bearer credential was refused (HTTP 401/403) or lacks a required scope. */
export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";
}

/** The connection could not be opened or was lost; retrying later is reasonable. */
export class TransientConnectionError extends Error {
  override readonly name = "TransientConnectionError";
}

/** The caller's AbortSignal fired; not a failure. */
export class AbortedError extends Error {
  override readonly name = "AbortedError";
}

/**
 * Reads the URL a running T3 advertises for local clients from
 * `<baseDir>/userdata/server-runtime.json`. Re-read on every reconnect because
 * the port can change when T3 restarts. Returns null when T3 is not running.
 */
export function discoverServerUrl(baseDir: string): string | null {
  try {
    const runtime = JSON.parse(readFileSync(join(baseDir, "userdata", "server-runtime.json"), "utf8"));
    return typeof runtime?.origin === "string" ? runtime.origin : null;
  } catch {
    return null;
  }
}


/** Provider routing data deliberately excludes account identities and credentials. */
export interface ModelChoice {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}
export interface SwitchProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly status: string;
  readonly availability?: string;
  readonly auth: { readonly status: string; readonly type?: "chatgpt" | "apiKey" };
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly capabilities: { readonly optionDescriptors?: ReadonlyArray<{
      readonly id: string;
      readonly type: string;
      readonly options?: ReadonlyArray<{ readonly id: string }>;
    }> } | null;
  }>;
  /** Local runtime CODEX_HOME, internal matching only; never copied to reports. */
  readonly runtimeHome?: string;
  /** Any instance environment override needs a future explicit context adapter. */
  readonly quotaContextBlocked?: boolean;
  /** Nonsecret account hash, public in capacity and routing per the 2026-10-18 decision. */
  readonly quotaAccountKey?: string;
  readonly headroom?: ReturnType<typeof import("../quota/headroom.ts").routingLanes>;
  readonly usageLimits?: {
    readonly checkedAt: string;
    readonly windows: ReadonlyArray<{ readonly usedPercent: number; readonly id?: string; readonly kind?: string; readonly windowDurationMins?: number; readonly resetsAt?: string }>;
    readonly resetCredits?: { readonly availableCount: number; readonly nextExpiresAt?: string };
    readonly unavailable?: unknown;
  };
}
export type CatalogModelPreferences = Readonly<Record<string, { readonly hiddenModels: ReadonlyArray<string> }>>;
export interface SwitchPort {
  catalog(): Promise<{ readonly providers: ReadonlyArray<SwitchProvider>; readonly autoResume: boolean;
    readonly modelPreferences?: CatalogModelPreferences | null }>;
  thread(threadId: string): Promise<ShellThread | undefined>;
  recovery(input: { threadId: string; runId: string; resetAt: string; commandId: string; autoResume: boolean; snooze?: boolean }): Promise<boolean>;
  clearRecovery(threadId: string, commandId: string): Promise<boolean>;
  delivered(threadId: string, messageId: string): Promise<boolean>;
  continue(input: { threadId: string; runId: string; commandId: string; target: ModelChoice }): Promise<boolean>;
}

/** Safe domain projection; auth labels, identities and reset redemption IDs stay in T3. */
export function toSwitchProvider(p: import("../../vendor/t3-contracts/src/index.ts").ServerProvider): SwitchProvider {
  return {
    instanceId: p.instanceId, driver: p.driver, enabled: p.enabled, installed: p.installed,
    status: p.status, auth: { status: p.auth.status,
      ...(p.auth.type === "chatgpt" || p.auth.type === "apiKey" ? { type: p.auth.type } : {}) },
    ...(p.auth.workspaceId ? { quotaAccountKey: createHash("sha256").update(p.auth.workspaceId).digest("hex") } : {}),
    ...(p.runtimePaths === undefined ? {} : { runtimeHome: p.runtimePaths.shadowHomePath ?? p.runtimePaths.homePath }),
    ...(p.availability === undefined ? {} : { availability: p.availability }),
    models: p.models.map((m) => ({
      slug: m.slug, capabilities: m.capabilities === null ? null : {
        ...(m.capabilities.optionDescriptors === undefined ? {} : {
          optionDescriptors: m.capabilities.optionDescriptors.map((d) => ({
            id: d.id, type: d.type,
            ...(d.type === "select" ? { options: d.options.map((o) => ({ id: o.id })) } : {}),
          })),
        }),
      },
    })),
    ...(p.usageLimits === undefined ? {} : { usageLimits: {
      checkedAt: p.usageLimits.checkedAt,
      windows: p.usageLimits.windows.map((w) => ({
        id: w.id, kind: w.kind, usedPercent: w.usedPercent,
        ...(w.windowDurationMins === undefined ? {} : { windowDurationMins: w.windowDurationMins }),
        ...(w.resetsAt === undefined ? {} : { resetsAt: w.resetsAt }),
      })),
      ...(p.usageLimits.resetCredits === undefined ? {} : { resetCredits: {
        availableCount: p.usageLimits.resetCredits.availableCount,
        ...(p.usageLimits.resetCredits.nextExpiresAt === undefined ? {} : { nextExpiresAt: p.usageLimits.resetCredits.nextExpiresAt }),
      } }),
      ...(p.usageLimits.unavailable === undefined ? {} : { unavailable: { reason: p.usageLimits.unavailable.reason } }),
    } }),
  };
}

/** Cached config read followed by provider-status notifications; never refreshes a provider. */
export async function connectUsage(
  options: ConnectOptions,
  onProviders: (providers: ReadonlyArray<SwitchProvider>) => void,
): Promise<void> {
  await withClient(options, (client) => Effect.gen(function* () {
    const config = yield* client["server.getConfig"]({}).pipe(Effect.timeout("5 seconds"));
    let providers = config.providers, settings = config.settings;
    const publish = () => onProviders(providers.map(p => ({
      ...toSwitchProvider(p),
      quotaContextBlocked: (settings.providerInstances[p.instanceId]?.environment?.length ?? 0) > 0,
    })));
    publish();
    yield* client.subscribeServerConfig({}).pipe(Stream.runForEach((event) => Effect.sync(() => {
      if (event.type === "snapshot") { providers = event.config.providers; settings = event.config.settings; }
      else if (event.type === "providerStatuses") providers = event.payload.providers;
      else if (event.type === "settingsUpdated") settings = event.payload.settings;
      else return;
      publish();
    })));
  }));
}

/** Each call is scoped; a failed transport can be retried using the identical command. */
export function switchPort(options: ConnectOptions): SwitchPort {
  const request = <A>(use: (client: WsClient) => Effect.Effect<A, unknown>) =>
    withClient(options, (client) => use(client).pipe(Effect.timeout("5 seconds")));
  const dispatch = (command: Parameters<WsClient["orchestration.dispatchCommand"]>[0]) =>
    request((client) => client["orchestration.dispatchCommand"](command).pipe(
      Effect.map(() => true),
      Effect.catchTag("OrchestrationV2DispatchCommandError", () => Effect.succeed(false)),
    ));
  return {
    catalog: () => request((client) => client["server.getConfig"]({}).pipe(
      Effect.map((config) => ({
        providers: config.providers.map(toSwitchProvider),
        modelPreferences: config.settings.providerModelPreferences,
        autoResume: config.settings.autoResumeLimitedThreads,
      })),
    )),
    thread: (threadId) => request((client) =>
      client["orchestration.getThreadProjection"]({ threadId } as never).pipe(
        Effect.map(toSwitchThread),
        Effect.catchTag("OrchestrationV2GetThreadProjectionError", () => Effect.succeed(undefined)),
      )),
    delivered: (threadId, messageId) => request((client) =>
      client["orchestration.getThreadProjection"]({ threadId } as never).pipe(
        Effect.map((projection) => projection.messages.some((m) => m.id === messageId)),
      )),
    recovery: (input) => dispatch({
      type: "thread.metadata.update", commandId: input.commandId, threadId: input.threadId,
      limitRecovery: { runId: input.runId, resetAt: input.resetAt, autoResume: input.autoResume,
        ...(input.snooze === undefined ? {} : { snooze: input.snooze }) },
    } as never),
    clearRecovery: (threadId, commandId) => dispatch({
      type: "thread.metadata.update", commandId, threadId, limitRecovery: null,
    } as never),
    continue: (input) => dispatch({
      type: "message.dispatch", commandId: input.commandId, messageId: input.commandId,
      threadId: input.threadId, manualContinuationOfRunId: input.runId, modelSelection: input.target,
      text: "Continue where you left off.", attachments: [],
      dispatchMode: { type: "start_immediately" }, createdBy: "user", creationSource: "server",
    } as never),
  };
}

export interface ConnectOptions {
  /** Base URL of the T3 server, such as `http://127.0.0.1:3773`. */
  readonly serverUrl: string;
  /** Bearer credential. Never logged. */
  readonly token: string;
  readonly signal?: AbortSignal;
}

export interface ShellSubscription {
  /** Resume after this shell sequence; omit for a full snapshot first. */
  readonly afterSequence?: number;
  /** Called for every item in order; the next item waits for the promise. */
  readonly onEvent: (event: ShellEvent) => Promise<void> | void;
  readonly onResources?: (resources: Resources) => void;
  readonly onProviderCatalog?: (providers: ReadonlyArray<{instanceId:string;driver:string}>) => void;
}

export function socketUrl(serverUrl: string): string {
  const url = new URL("/ws", serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(SUPPORTED_PROTOCOL_VERSION));
  url.searchParams.set("clientSurface", "cli");
  return url.toString();
}

interface HandshakeFailure {
  readonly status: number;
  readonly code: string | null;
}

const MAX_HANDSHAKE_BODY = 4096;

/**
 * A `ws` constructor that sends the bearer header and records why a handshake
 * was refused, so a 426 can be told apart from a network failure.
 */
function makeConstructor(token: string, onRefused: (failure: HandshakeFailure) => void) {
  return (url: string) => {
    const socket = new WebSocket(url, { headers: { authorization: `Bearer ${token}` } });
    socket.on("unexpected-response", (request, response) => {
      const chunks: Array<Buffer> = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        if (size < MAX_HANDSHAKE_BODY) chunks.push(chunk);
        size += chunk.length;
      });
      response.on("end", () => {
        let code: string | null = null;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8").slice(0, MAX_HANDSHAKE_BODY));
          if (typeof body?.code === "string") code = body.code;
        } catch {
          // Not JSON; the status alone classifies it.
        }
        onRefused({ status: response.statusCode ?? 0, code });
        request.destroy();
        socket.terminate();
      });
    });
    return socket as unknown as globalThis.WebSocket;
  };
}

function classifyRefusal(failure: HandshakeFailure): Error {
  if (failure.status === 426) {
    return new ProtocolIncompatibleError(
      `T3 refused orchestration protocol ${SUPPORTED_PROTOCOL_VERSION} (HTTP 426${failure.code ? `, ${failure.code}` : ""}).`,
    );
  }
  if (failure.status === 401 || failure.status === 403) {
    return new AuthenticationError(`T3 refused the credential (HTTP ${failure.status}).`);
  }
  return new TransientConnectionError(`T3 refused the WebSocket handshake (HTTP ${failure.status}).`);
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value == null ? null : DateTime.formatIso(value);
}

/** Conservative per-thread preflight from the public projection, never a fleet snapshot. */
export function toSwitchThread(projection: OrchestrationV2ThreadProjection): ShellThread {
  const { thread } = projection;
  // Any newer active/queued run prevents a switch, even if the shell still presents a limit.
  const run = projection.runs.reduce<OrchestrationV2ThreadProjection["runs"][number] | null>(
    (latest, candidate) => latest === null || candidate.ordinal > latest.ordinal ? candidate : latest, null);
  const active = projection.runs.find((r) => ["preparing", "starting", "running", "waiting"].includes(r.status));
  const errors = projection.turnItems.filter((i) =>
    i.type === "error" && i.status === "failed" && i.runId === run?.id && i.nodeId === run?.rootNodeId);
  const failureItem = errors.toSorted((a, b) =>
    DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) || b.ordinal - a.ordinal ||
    String(b.id).localeCompare(String(a.id)))[0];
  const failure = run?.status === "failed" && failureItem?.type === "error" ? failureItem.failure : null;
  const recovery = thread.limitRecovery;
  return {
    id: thread.id, status: run?.status ?? "idle", providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection, settled: thread.settledOverride === "settled",
    pendingRequest: projection.runtimeRequests.some((r) => r.status === "pending"),
    latestRunId: run?.id ?? null, activeRunId: active?.id ?? null,
    latestRunStartedAt: isoOrNull(run?.startedAt), latestRunCompletedAt: isoOrNull(run?.completedAt),
    lastErrorClass: failure?.class ?? null,
    usageLimitResetAt: failure?.class === "usage_limit" ? failure.resetAt ?? null : null,
    limitRecovery: recovery == null ? null : {
      runId: recovery.runId, resetAt: recovery.resetAt, autoResume: recovery.autoResume,
      ...(recovery.snooze === undefined ? {} : { snooze: recovery.snooze }),
      ...(recovery.requestId === undefined ? {} : { requestId: recovery.requestId }),
    },
    relationshipToParent: thread.lineage.relationshipToParent,
    archived: thread.archivedAt !== null, deleted: thread.deletedAt !== null,
  };
}

export function toShellThread(thread: OrchestrationV2ThreadShell): ShellThread {
  const recovery = thread.limitRecovery ?? null;
  return {
    id: thread.id,
    title: thread.title,
    status: thread.status,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    settled: thread.settledOverride === "settled",
    pendingRequest: thread.pendingRuntimeRequest !== null,
    ...(thread.pendingRuntimeRequest?{pendingRequestKind:thread.pendingRuntimeRequest.kind}:{}),
    latestRunId: thread.latestRunId,
    activeRunId: thread.activeRunId,
    latestRunStartedAt: isoOrNull(thread.latestRunStartedAt),
    latestRunCompletedAt: isoOrNull(thread.latestRunCompletedAt),
    lastErrorClass: thread.lastErrorClass ?? null,
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    limitRecovery: recovery === null
      ? null
      : { runId: recovery.runId, resetAt: recovery.resetAt, autoResume: recovery.autoResume, ...(recovery.snooze === undefined ? {} : { snooze: recovery.snooze }), ...(recovery.requestId === undefined ? {} : { requestId: recovery.requestId }) },
    relationshipToParent: thread.lineage.relationshipToParent,
    archived: thread.archivedAt !== null,
    deleted: thread.deletedAt !== null,
  };
}

export function toShellEvent(item: OrchestrationV2ShellStreamItem): ShellEvent {
  switch (item.kind) {
    case "synchronized":
      return { kind: "synchronized" };
    case "snapshot":
      return {
        kind: "snapshot",
        sequence: item.snapshot.snapshotSequence,
        threads: [...item.snapshot.threads, ...item.snapshot.archivedThreads].map(toShellThread),
      };
    case "thread.updated":
      return { kind: "thread", sequence: item.sequence, thread: toShellThread(item.thread) };
    case "thread.removed":
      return { kind: "removed", sequence: item.sequence, threadId: item.threadId };
    case "project.updated":
    case "project.removed":
      return { kind: "cursor", sequence: item.sequence };
  }
}

const makeWsClient = RpcClient.make(WsRpcGroup);
export type WsClient = typeof makeWsClient extends Effect.Effect<infer Client, any, any> ? Client : never;

function describe(cause: unknown): string {
  if (cause instanceof Error) return `${cause.name}: ${cause.message}`;
  try {
    return JSON.stringify(cause).slice(0, 500);
  } catch {
    return String(cause);
  }
}

/**
 * True for every failure that means T3 sent something the pinned contracts or
 * the RPC wire format cannot decode: a `SchemaError` from a schema, or an
 * `RpcClientDefect` (Effect's classification of malformed or incompatible
 * protocol data, such as a frame that is not JSON).
 */
function isContractFailure(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const failure = cause as { name?: unknown; _tag?: unknown; reason?: { _tag?: unknown } | null };
  return (
    failure.name === "SchemaError" ||
    failure.name === "ParseError" ||
    failure._tag === "RpcClientDefect" ||
    failure.reason?._tag === "RpcClientDefect"
  );
}

/**
 * Opens one authenticated RPC connection and runs `use` with the client. Test
 * helpers use this seam to drive a disposable T3; production code calls
 * `connectShell`.
 */
export async function withClient<A>(
  options: ConnectOptions,
  use: (client: WsClient) => Effect.Effect<A, unknown>,
): Promise<A> {
  let refusal: HandshakeFailure | null = null;
  const constructorLayer = Layer.succeed(
    Socket.WebSocketConstructor,
    makeConstructor(options.token, (failure) => {
      refusal = failure;
    }) as unknown as Socket.WebSocketConstructor["Service"],
  );
  const protocolLayer = Layer.effect(
    RpcClient.Protocol,
    RpcClient.makeProtocolSocket({ retryTransientErrors: false, pingTimeout: "15 seconds" }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Socket.layerWebSocket(socketUrl(options.serverUrl), { openTimeout: "10 seconds" }).pipe(
          Layer.provide(constructorLayer),
        ),
        RpcSerialization.layerJson,
      ),
    ),
  );
  const program = Effect.gen(function* () {
    const client = yield* makeWsClient;
    return yield* use(client);
  }).pipe(Effect.scoped, Effect.provide(protocolLayer));
  try {
    return await Effect.runPromise(program as Effect.Effect<A, unknown, never>, options.signal ? { signal: options.signal } : undefined);
  } catch (cause) {
    if (options.signal?.aborted) throw new AbortedError("The connection was closed on request.");
    const failure = refusal as HandshakeFailure | null;
    if (failure !== null) throw classifyRefusal(failure);
    const text = describe(cause);
    if (/EnvironmentAuthorizationError|insufficient_scope|forbidden/i.test(text)) {
      throw new AuthenticationError(`T3 refused the request: ${text}`);
    }
    if (isContractFailure(cause)) {
      throw new ProtocolIncompatibleError(`T3 sent data the pinned contracts reject: ${text}`);
    }
    throw new TransientConnectionError(text);
  }
}

/**
 * The sole wake delivery seam. Pinned 0.1.0 rewrites createdBy to user at WS
 * intake and rejects notification payloads. Igor explicitly approved one marked,
 * queued user message per item. Keep the journal's command bytes immutable:
 * RPC success confirms the durable receipt; ambiguous calls replay the same ID.
 * Switch to native notifications here when a qualified T3 version permits them.
 */
export class WakeRejectedError extends Error {
  override readonly name = "WakeRejectedError";
}
/** Only a replayed durable rejection is definitive; intake/internal failures are ambiguous. */
export async function respondChaldeaDecision(options: ConnectOptions, payload: string): Promise<boolean> {
  return withClient(options,client => client["orchestration.dispatchCommand"](JSON.parse(payload)).pipe(
    Effect.map(() => true),
    Effect.catchTag("OrchestrationV2DispatchCommandError",error =>
      /previously rejected/i.test(error.message + " " + (error.detail ?? ""))
        ? Effect.succeed(false) : Effect.fail(error))));
}
export async function dispatchChaldeaWake(options: ConnectOptions, payload: string, expectedEnvironment?: string): Promise<void> {
  const accepted = await withClient(options, client => Effect.gen(function* () {
    const command=JSON.parse(payload);
    if (expectedEnvironment !== undefined || command.externalWake !== undefined) {
      const config = yield* client["server.getConfig"]({});
      if (expectedEnvironment !== undefined && String(config.environment.environmentId) !== expectedEnvironment)
        return yield* Effect.fail(new Error("message_environment"));
      // Schema acceptance is insufficient: older servers silently drop unknown fields.
      if (command.externalWake !== undefined && config.externalWakeGuardVersion !== 1)
        return "unsupported_guard" as const;
    }
    return yield* client["orchestration.dispatchCommand"](JSON.parse(payload)).pipe(
      Effect.map(() => true),
      Effect.catchTag("OrchestrationV2DispatchCommandError", error =>
        /previously rejected/i.test(error.message + " " + (error.detail ?? ""))
          ? Effect.succeed(false) : Effect.fail(error)));
  }));
  if (accepted === "unsupported_guard") throw new ProtocolIncompatibleError("T3 external wake admission guard is unsupported");
  if (!accepted) throw new WakeRejectedError("T3 durably rejected this wake; operator attention required");
}

/**
 * Sets T3's server-scoped `autoResumeLimitedThreads` through the public
 * `server.updateSettings` RPC, so T3 persists it with its own writer. Needs a
 * bearer with the `settings:write` scope. Resolves to the value T3 reports back.
 */
export async function setAutoResumeLimitedThreads(options: ConnectOptions, enabled: boolean): Promise<boolean> {
  const settings = await withClient(options, (client) =>
    client["server.updateSettings"]({ patch: { autoResumeLimitedThreads: enabled } }),
  );
  return settings.autoResumeLimitedThreads;
}

/**
 * Subscribes to the shell stream and delivers mapped events until the stream
 * ends, the signal aborts, or the connection fails. Resolves when the server
 * ends the stream; rejects with one of the error classes above otherwise.
 */

/** Narrow read-only detail stream for Mission Control. Raw content is sanitized by its model before export. */
export type MissionDetailEvent =
  | DetailEvent
  | { kind: "synchronized" }
  | { kind: "cursor"; sequence: number }
  | { kind: "activity"; tool: string | null }
  | { kind: "usage"; turnId: string; output: number | null; at: number; baseline: boolean; startedAt?: number | null };
export async function connectMissionThread(options: ConnectOptions, threadId: string,
  afterSequence: number | undefined, onEvent: (event: MissionDetailEvent) => void): Promise<void> {
  // Retain at most 128 owner IDs: item overflow cannot evict a running root.
  const mainRoots=new Set<string>(),mainOwners=new Map<string,string>();
  const rememberRoot=(root:string)=>{
    mainRoots.delete(root);mainRoots.add(root);
    if(mainRoots.size>64){
      const oldest=mainRoots.values().next().value!;mainRoots.delete(oldest);
      for(const [id,owner] of mainOwners)if(owner===oldest)mainOwners.delete(id);
    }
  };
  const rememberOwner=(id:string,root:string)=>{
    rememberRoot(root);
    mainOwners.delete(id);
    if(mainOwners.size>=64)mainOwners.delete(mainOwners.keys().next().value!);
    mainOwners.set(id,root);
  };
  const activeCommands=new Map<string,string|null>();
  const terminalRuns=new Set<string>();
  const nativeKey=(driver:string,instance:string,provider:string,task:string)=>JSON.stringify(["native",driver,instance,provider,task]);
  const childKey=(id:string)=>JSON.stringify(["child",id]);
  const providers=new Map<string,{owner:string;updatedAt:number;reported:unknown;context:Detail["context"];tasks:{keys:string[];kind:string}[]}>();
  const children=new Map<string,{status:string;keys:string[];origin:string}>();
  const metadata=()=>{
    const rows=[...providers.values()],latest=rows.toSorted((a,b)=>a.updatedAt-b.updatedAt).at(-1);
    const counts={active:0,queued:0,completed:0},delegates={...counts},subagents={...counts};
    const seen=new Set<string>();
    for(const c of [...children.values()].sort((a,b)=>Number(b.origin==="app_owned")-Number(a.origin==="app_owned"))){
      const duplicate=c.keys.some(key=>seen.has(key));for(const key of c.keys)seen.add(key);if(duplicate)continue;
      const state=c.status==="pending"?"queued":["running","waiting"].includes(c.status)?"active":c.status==="completed"?"completed":null;
      if(state){counts[state]++;(c.origin==="app_owned"?delegates:subagents)[state]++;}
    }
    const tasks=rows.flatMap(p=>p.tasks),taskSeen=new Set<string>();let monitors=0,background=0;
    for(const t of tasks){
      const duplicate=t.keys.some(key=>taskSeen.has(key));for(const key of t.keys)taskSeen.add(key);if(duplicate)continue;
      if(t.kind==="subagent"&&!t.keys.some(key=>seen.has(key))){for(const key of t.keys)seen.add(key);counts.active++;subagents.active++;}
      if(t.kind==="monitor")monitors++;if(t.kind==="background_task")background++;
    }
    onEvent({kind:"metadata",reported:latest?.reported,context:latest?.context??null,work:{
      children:counts,delegates,subagents,monitors:tasks.length?monitors:null,background:tasks.length?background:null,
      durableWaits:null,coverage:"observed bounded roster"}});
  };
  const provider=(p:OrchestrationV2ThreadProjection["providerThreads"][number],snapshotOwner=false)=>{
    if(p.appThreadId!==threadId||p.ownerNodeId===null||!(snapshotOwner||mainRoots.has(p.ownerNodeId)||providers.get(p.id)?.owner===p.ownerNodeId))return;
    if(!providers.has(p.id)&&providers.size>=16)return;
    providers.set(p.id,{owner:p.ownerNodeId,updatedAt:DateTime.toEpochMillis(p.updatedAt),reported:p.nativeMetadata?.modelSelection,
      context:p.contextUsage?{used:p.contextUsage.usedTokens,max:p.contextUsage.maxTokens??null}:null,
      tasks:(p.pendingBackgroundTasks??[]).slice(0,128).map(t=>({keys:[nativeKey(p.driver,p.providerInstanceId,p.id,t.taskId),...("childThreadId" in t&&t.childThreadId?[childKey(String(t.childThreadId))]:[])],kind:t.kind}))});
  };
  const child=(c:OrchestrationV2ThreadProjection["subagents"][number])=>{
    const scope=c.providerThreadId??[...providers].find(([,p])=>p.owner===c.parentNodeId)?.[0];
    const ref=c.nativeTaskRef;
    const keys=[...(c.childThreadId?[childKey(c.childThreadId)]:[]),...(scope&&ref?.nativeId&&ref.strength!=="none"?[nativeKey(ref.driver,c.providerInstanceId,scope,ref.nativeId)]:[])];
    if(children.has(c.id)||children.size<128)children.set(c.id,{status:c.status,keys:keys.length?keys:[JSON.stringify(["node",c.id])],origin:c.origin});
  };

  // Usage has its own finite proof window. This never enrolls a provider in
  // metadata, activity ownership or the child roster.
  type Projection=OrchestrationV2ThreadProjection;
  type UsageProvider=Pick<Projection["providerThreads"][number],"id"|"appThreadId"|"ownerNodeId"|"providerInstanceId">;
  type UsageNode=Pick<Projection["nodes"][number],"id"|"threadId"|"kind"|"parentNodeId"|"rootNodeId"|"runId"|"providerThreadId"|"providerTurnId">;
  type UsageRun=Pick<Projection["runs"][number],"id"|"threadId"|"rootNodeId"|"providerThreadId"|"providerInstanceId">;
  type UsageAttempt=Pick<Projection["attempts"][number],"id"|"runId"|"rootNodeId"|"providerThreadId"|"providerInstanceId"|"providerTurnId">;
  type UsageTurn=Pick<Projection["providerTurns"][number],"id"|"nodeId"|"providerThreadId"|"runAttemptId"|"turnTokenUsage"|"completedAt">;
  const usageProviders=new Map<string,UsageProvider|null>(),usageNodes=new Map<string,UsageNode|null>(),usageRuns=new Map<string,UsageRun|null>(),usageAttempts=new Map<string,UsageAttempt|null>();
  const usageTurns=new Map<string,{turn:UsageTurn|null;at:number;published:boolean}>();
  let usageOverflow=false,usagePartial=false;
  const usageTurnProofs=new Map<string,Pick<UsageTurn,"id"|"nodeId"|"providerThreadId"|"runAttemptId">|null>();
  const pinnedUsage=(map:Map<string,unknown>,id:string)=>{
    for(const [turnId,{turn}] of usageTurns){
      if(!turn)continue;
      const n=usageNodes.get(turn.nodeId),p=usageProviders.get(turn.providerThreadId);
      const a=turn.runAttemptId?usageAttempts.get(turn.runAttemptId):undefined;
      if(map===usageProviders&&id===turn.providerThreadId
        ||map===usageNodes&&(id===turn.nodeId||id===p?.ownerNodeId)
        ||map===usageRuns&&(id===n?.runId||id===a?.runId)
        ||map===usageAttempts&&id===turn.runAttemptId
        ||map===usageTurnProofs&&(id===turnId||id===n?.providerTurnId||id===a?.providerTurnId))return true;
    }
    return false;
  };
  const makeUsageRoom=(map:Map<string,unknown>,id:string,limit:number)=>{
    if(map.has(id)||map.size<limit)return true;
    // Rotate ordinary history, keeping retained dependencies and every poison.
    const evict=[...map].find(([key,value])=>value!==null&&!pinnedUsage(map,key));
    if(evict){map.delete(evict[0]);usagePartial=true;return true;}
    usageOverflow=true;return false;
  };
  const retain=<T extends {id:string}>(map:Map<string,T|null>,value:T,limit:number,identity:(v:T)=>unknown= v=>v,nullable=false)=>{
    if(map.has(value.id)&&map.get(value.id)===null)return;
    const old=map.get(value.id);
    if(old){
      const before=identity(old),after=identity(value);
      const conflict=nullable&&Array.isArray(before)&&Array.isArray(after)
        ?before.some((field,i)=>field!=null&&after[i]!=null&&field!==after[i])
        :JSON.stringify(before)!==JSON.stringify(after);
      if(conflict){map.set(value.id,null);return;}
    }
    if(!makeUsageRoom(map,value.id,limit))return;
    const retained={...value};
    if(nullable&&old)for(const key in old)if(retained[key]==null&&old[key]!=null)retained[key]=old[key];
    map.set(value.id,retained);
  };
  const usageProvider=(p:Projection["providerThreads"][number])=>retain(usageProviders,{id:p.id,appThreadId:p.appThreadId,ownerNodeId:p.ownerNodeId,providerInstanceId:p.providerInstanceId},16,p=>[p.appThreadId,p.providerInstanceId,p.ownerNodeId],true);
  const usageNode=(n:Projection["nodes"][number])=>{
    if(n.kind==="root_turn"||n.kind==="subagent"||usageNodes.has(n.id)||[...usageProviders.values()].some(p=>p?.ownerNodeId===n.id)||[...usageTurns.values()].some(t=>t.turn?.nodeId===n.id))
      retain(usageNodes,{id:n.id,threadId:n.threadId,kind:n.kind,parentNodeId:n.parentNodeId,rootNodeId:n.rootNodeId,runId:n.runId,providerThreadId:n.providerThreadId,providerTurnId:n.providerTurnId},64,n=>[n.threadId,n.kind,n.parentNodeId,n.rootNodeId,n.providerThreadId],true);
  };
  const usageRun=(r:Projection["runs"][number])=>retain(usageRuns,{id:r.id,threadId:r.threadId,rootNodeId:r.rootNodeId,providerThreadId:r.providerThreadId,providerInstanceId:r.providerInstanceId},128,r=>[r.threadId,r.rootNodeId,r.providerThreadId,r.providerInstanceId],true);
  const usageAttempt=(a:Projection["attempts"][number])=>retain(usageAttempts,{id:a.id,runId:a.runId,rootNodeId:a.rootNodeId,providerThreadId:a.providerThreadId,providerInstanceId:a.providerInstanceId,providerTurnId:a.providerTurnId},128,a=>[a.runId,a.rootNodeId,a.providerThreadId,a.providerInstanceId],true);
  const ownsUsage=(t:UsageTurn,snapshot?:Projection)=>{
    const resolve=<T extends {id:string}>(rows:readonly T[]|undefined,map:Map<string,T|null>,id:string):T|null|undefined=>{
      if(!rows)return map.get(id);
      const matches=rows.filter(r=>r.id===id);return matches.length>1?null:matches[0];
    };
    const p=resolve(snapshot?.providerThreads,usageProviders,t.providerThreadId),n=resolve(snapshot?.nodes,usageNodes,t.nodeId);
    if(!p||p.appThreadId!==threadId||!n||n.threadId!==threadId||n.kind!=="root_turn"||n.parentNodeId!==null||n.rootNodeId!==n.id||n.providerThreadId!==p.id)return false;
    const same=(actual:unknown,expected:unknown)=>actual==null||expected==null||actual===expected;
    const reverse=(id:string|null,attemptId?:string)=>{
      if(id===null)return true;
      const turn=resolve(snapshot?.providerTurns,usageTurnProofs,id);
      // Reverse IDs are latest pointers, not one-to-one historical links.
      return turn!==null&&(!turn||turn.providerThreadId===p.id&&turn.nodeId===n.id&&(attemptId===undefined||turn.runAttemptId===attemptId));
    };
    if(!reverse(n.providerTurnId))return false;
    if((snapshot?.nodes??[...usageNodes.values()]).some(other=>other&&other.id!==n.id&&other.providerTurnId===t.id))return false;
    if(p.ownerNodeId!==null){
      const owner=resolve(snapshot?.nodes,usageNodes,p.ownerNodeId);
      if(owner===null||owner&&(owner.threadId!==threadId||owner.kind!=="root_turn"||owner.parentNodeId!==null||owner.rootNodeId!==owner.id||owner.providerThreadId!==p.id))return false;
    }
    const attempt=t.runAttemptId?resolve(snapshot?.attempts,usageAttempts,t.runAttemptId):undefined;
    if(attempt===null||attempt&&(!same(attempt.runId,n.runId)||!same(attempt.rootNodeId,n.id)||!same(attempt.providerThreadId,p.id)||!same(attempt.providerInstanceId,p.providerInstanceId)||!reverse(attempt.providerTurnId,attempt.id)))return false;
    for(const id of [n.runId,attempt?.runId]){
      const r=id?resolve(snapshot?.runs,usageRuns,id):undefined;
      if(r===null||r&&(!same(r.threadId,threadId)||!same(r.rootNodeId,n.id)||!same(r.providerThreadId,p.id)||!same(r.providerInstanceId,p.providerInstanceId)))return false;
    }
    return resolve(snapshot?.providerTurns,usageTurnProofs,t.id)!==null;
  };
  const unavailable=(id:string,at:number)=>onEvent({kind:"turn-usage",id,usage:{usageScope:"main_agent",usageStatus:"unavailable",hasSubagents:false},at,partial:usagePartial||usageOverflow});
  const reconcileUsage=()=>{
    if(usageOverflow)usagePartial=true;
    for(const [id,entry] of usageTurns){
      if(!usageOverflow&&entry.turn&&ownsUsage(entry.turn)){
        onEvent({kind:"turn-usage",id,usage:entry.turn.turnTokenUsage??{usageScope:"main_agent",usageStatus:"unavailable",hasSubagents:false},at:entry.at,partial:usagePartial});entry.published=true;
      }else {unavailable(id,entry.at);entry.published=false;}
    }
  };
  const rememberTurn=(t:Projection["providerTurns"][number],stamp:number)=>{
    retain(usageTurnProofs,{id:t.id,nodeId:t.nodeId,providerThreadId:t.providerThreadId,runAttemptId:t.runAttemptId},128);
    const old=usageTurns.get(t.id);if(old?.turn===null)return;
    const n=usageNodes.get(t.nodeId),p=usageProviders.get(t.providerThreadId);
    // Known children/foreign turns cannot consume the main-agent window.
    if(n&&(n.threadId!==threadId||n.kind!=="root_turn"||n.parentNodeId!==null||n.rootNodeId!==n.id)||p&&p.appThreadId!==threadId)return;
    if(!old&&usageTurns.size>=8){
      const id=[...usageTurns].find(([,entry])=>!entry.turn||!ownsUsage(entry.turn))?.[0]??usageTurns.keys().next().value!;
      const evicted=usageTurns.get(id)!;if(evicted.published)unavailable(id,evicted.at);
      usageTurns.delete(id);usagePartial=true;
    }
    usageTurns.set(t.id,{turn:{id:t.id,nodeId:t.nodeId,providerThreadId:t.providerThreadId,runAttemptId:t.runAttemptId,...(t.turnTokenUsage?{turnTokenUsage:t.turnTokenUsage}:{}),completedAt:t.completedAt},at:t.completedAt?DateTime.toEpochMillis(t.completedAt):stamp,published:old?.published??false});
  };

  const node=(n:OrchestrationV2ThreadProjection["nodes"][number])=>{
    if(n.threadId!==threadId)return;
    if(n.kind==="root_turn"){rememberRoot(n.id);return;}
    const rootKnown=mainRoots.has(n.rootNodeId);
    if(["assistant_message","reasoning","tool_call"].includes(n.kind)&&rootKnown
      &&(n.parentNodeId===null||n.parentNodeId===n.rootNodeId||mainOwners.get(n.parentNodeId)===n.rootNodeId)
      &&(n.providerThreadId===null||providers.has(n.providerThreadId)))rememberOwner(n.id,n.rootNodeId);
  };
  const activity=(r:OrchestrationV2ThreadProjection["turnItems"][number])=>{
    // Preserve legacy capture even when bounded ownership evidence is unavailable.
    if(r.threadId!==threadId)return;
    const recentOwner=(r.nodeId!==null?(mainRoots.has(r.nodeId)||mainOwners.has(r.nodeId)):r.providerThreadId!=null&&providers.has(r.providerThreadId))
      &&(r.providerThreadId==null||providers.has(r.providerThreadId));
    if(recentOwner&&(r.type==="assistant_message"||r.type==="command_execution")){
      const status=["running","completed","failed","cancelled"].includes(r.status)?r.status as "running"|"completed"|"failed"|"cancelled":"unknown";
      onEvent({kind:"recent-item",id:r.id,ordinal:r.ordinal,type:r.type==="assistant_message"?"assistant":"command",text:r.type==="assistant_message"?r.text:r.input,at:DateTime.toEpochMillis(r.updatedAt),status:status==="running"&&r.runId&&terminalRuns.has(r.runId)?"unknown":status==="completed"&&r.type==="command_execution"&&(r.outputIndicatesFailure===true||r.exitCode!==undefined&&r.exitCode!==0)?"failed":status});
    }
    if(["reasoning","command_execution","tool_call"].includes(r.type))onEvent({kind:"activity-state",id:r.id,type:r.type==="reasoning"?"thinking":"working",running:r.status==="running"&&!(r.runId&&terminalRuns.has(r.runId))});
    if(r.type==="command_execution"){
      const running=r.status==="running"&&!(r.runId&&terminalRuns.has(r.runId));
      if(running&&(activeCommands.has(r.id)||activeCommands.size<32))activeCommands.set(r.id,r.runId);else if(!running)activeCommands.delete(r.id);
      onEvent({kind:"command",id:r.id,input:r.input,running});
    }
    if(r.type==="assistant_message")onEvent({kind:"assistant",text:r.text,at:DateTime.toEpochMillis(r.updatedAt)});
    if(r.status==="running")onEvent({kind:"activity",tool:r.type==="command_execution"?"command_execution":"toolName" in r&&typeof r.toolName==="string"?r.toolName:null});
  };
  let sequence=afterSequence;
  await withClient(options, client => client["orchestration.subscribeThread"]({
    // Each reconnect rebuilds bounded active state; stable usage IDs deduplicate in the model.
    threadId,
    requestCompletionMarker: true, acceptBoundedSnapshot: true, acceptCompactTurnItems: true,
  } as never).pipe(Stream.runForEach(item => Effect.sync(() => {
    if(item.kind==="synchronized"){onEvent({kind:"synchronized"});return;}
    if(item.kind==="snapshot"){
      providers.clear();children.clear();mainRoots.clear();mainOwners.clear();activeCommands.clear();terminalRuns.clear();onEvent({kind:"reset"});
      usageProviders.clear();usageNodes.clear();usageRuns.clear();usageAttempts.clear();usageTurns.clear();
      usageTurnProofs.clear();usageOverflow=false;usagePartial=false;
      if(item.projection.thread.id!==threadId)return;
      const projection=item.projection;
      // Qualify against the entire envelope before selecting a bounded window.
      const owned=projection.providerTurns.filter(t=>ownsUsage(t,projection));
      if(owned.length>8)usagePartial=true;
      if(projection.providerTurns.some(t=>{
        const n=projection.nodes.find(n=>n.id===t.nodeId);
        return n?.threadId===threadId&&n.kind==="root_turn"&&!owned.includes(t);
      }))usagePartial=true;
      // Retain already-observed contradictions even when their turns are not selected.
      // Missing forward evidence stays pending; only fully linked rejected roots poison.
      for(const t of projection.providerTurns){
        if(owned.includes(t))continue;
        const n=projection.nodes.find(n=>n.id===t.nodeId),p=projection.providerThreads.find(p=>p.id===t.providerThreadId);
        if(n?.threadId===threadId&&n.kind==="root_turn"&&n.parentNodeId===null&&n.rootNodeId===n.id
          &&n.providerThreadId===t.providerThreadId&&p?.appThreadId===threadId){
          if(!makeUsageRoom(usageTurnProofs,t.id,128))break;
          usageTurnProofs.set(t.id,null);
        }
      }
      const selected=owned.slice(-8);
      for(const t of selected){
        const p=projection.providerThreads.find(p=>p.id===t.providerThreadId)!;
        usageProvider(p);
        const n=projection.nodes.find(n=>n.id===t.nodeId)!;
        usageNode(n);
        if(p.ownerNodeId){const owner=projection.nodes.find(n=>n.id===p.ownerNodeId);if(owner)usageNode(owner);}
        const r=projection.runs.find(r=>r.id===n.runId);if(r)usageRun(r);
        const attempt=projection.attempts.find(a=>a.id===t.runAttemptId);if(attempt)usageAttempt(attempt);
        for(const id of [n.providerTurnId,attempt?.providerTurnId]){
          const reverse=projection.providerTurns.find(t=>t.id===id);
          if(reverse)retain(usageTurnProofs,{id:reverse.id,nodeId:reverse.nodeId,providerThreadId:reverse.providerThreadId,runAttemptId:reverse.runAttemptId},128);
        }
        rememberTurn(t,DateTime.toEpochMillis(projection.updatedAt));
        if(!ownsUsage(t,projection))usageTurnProofs.set(t.id,null);
      }
      // Carry duplicate identity poison until replacement snapshot or fail-closed overflow.
      const poison=<T extends {id:string}>(rows:readonly T[],map:Map<string,unknown>,limit:number)=>{
        for(const row of rows)if(rows.some(other=>other!==row&&other.id===row.id)){
          if(!makeUsageRoom(map,row.id,limit))break;map.set(row.id,null);
        }
      };
      poison(projection.providerThreads,usageProviders,16);poison(projection.nodes,usageNodes,64);
      poison(projection.runs,usageRuns,128);poison(projection.attempts,usageAttempts,128);poison(projection.providerTurns,usageTurnProofs,128);
      reconcileUsage();
      for(const run of item.projection.runs.slice(-128))if(["completed","failed","cancelled","interrupted"].includes(run.status))terminalRuns.add(run.id);
      for(const n of item.projection.nodes)if(n.kind==="root_turn")node(n);
      // Provider creation can predate the retained owner window. Verify against
      // the actual snapshot, without retaining all historical roots.
      for(const p of item.projection.providerThreads)provider(p,item.projection.nodes.some(n=>n.id===p.ownerNodeId&&n.kind==="root_turn"&&n.threadId===threadId));
      for(const n of item.projection.nodes)if(n.kind!=="root_turn")node(n);
      for(const c of item.projection.subagents)child(c);
      metadata();

      // Iterate oldest first; model deduplicates assistant updates by source timestamp.
      const items=new Map([...item.projection.turnItems,...item.projection.visibleTurnItems.map(r=>r.item)].map(r=>[r.id,r]));
      for(const r of [...items.values()].toSorted((a,b)=>a.ordinal-b.ordinal))activity(r as OrchestrationV2ThreadProjection["turnItems"][number]);
      const assistant=item.projection.messages.filter(m=>m.role==="assistant"&&m.text.trim()).toSorted((a,b)=>DateTime.toEpochMillis(a.updatedAt)-DateTime.toEpochMillis(b.updatedAt)).at(-1);
      if(assistant)onEvent({kind:"assistant",text:assistant.text,at:DateTime.toEpochMillis(assistant.updatedAt)});
      sequence=item.snapshotSequence;onEvent({kind:"cursor",sequence});return;
    }
    if(sequence!==undefined&&item.sequence<=sequence)return;
    sequence=item.sequence;
    if(item.kind==="event"){
      const e=item.event;
      if(e.threadId!==threadId)return;
      if(e.type==="run.updated")usageRun(e.payload);
      else if(e.type==="run-attempt.updated")usageAttempt(e.payload);
      else if(e.type==="provider-turn.updated")rememberTurn(e.payload,DateTime.toEpochMillis(e.occurredAt));
      else if(e.type==="node.updated")usageNode(e.payload);
      else if(e.type==="provider-thread.updated")usageProvider(e.payload);
      if(["run.updated","run-attempt.updated","provider-turn.updated","node.updated","provider-thread.updated"].includes(e.type))reconcileUsage();
      if(e.type==="run.updated"&&["completed","failed","cancelled","interrupted"].includes(e.payload.status)){
        onEvent({kind:"clear-activity"});
        if(terminalRuns.size>=128)terminalRuns.delete(terminalRuns.values().next().value!);terminalRuns.add(e.payload.id);
        for(const [id,run] of activeCommands)if(run===e.payload.id){activeCommands.delete(id);onEvent({kind:"command",id,input:"",running:false});onEvent({kind:"activity-state",id,type:"working",running:false});}
      }

      else if(e.type==="turn-item.updated")activity(e.payload);
      else if(e.type==="message.updated"&&e.payload.role==="assistant")onEvent({kind:"assistant",text:e.payload.text,at:DateTime.toEpochMillis(e.payload.updatedAt)});
      else if(e.type==="node.updated")node(e.payload);
      else if(e.type==="provider-thread.updated"){provider(e.payload);metadata();}
      else if(e.type==="subagent.updated"){child(e.payload);metadata();}
    }
    onEvent({kind:"cursor",sequence:item.sequence});
  }))));
}

export async function connectShell(options: ConnectOptions, subscription: ShellSubscription): Promise<void> {
  let callbackError: unknown;
  try {
    await withClient(options, (client) => {
      const shell=client["orchestration.subscribeShell"]({
        ...(subscription.afterSequence === undefined ? {} : { afterSequence: subscription.afterSequence }),
        requestCompletionMarker: true,
      }).pipe(
        Stream.runForEach((item) => Effect.promise(async () => {
          try {
            await subscription.onEvent(toShellEvent(item));
          } catch (error) {
            callbackError = error;
            throw error;
          }
        })),
      );
      const catalog=subscription.onProviderCatalog?Effect.gen(function*(){
        const publish=(providers:ReadonlyArray<{instanceId:string;driver:string}>)=>subscription.onProviderCatalog!(providers.slice(0,128).map(p=>({instanceId:p.instanceId,driver:p.driver})));
        // The official subscription starts with its config snapshot; no separate getter/poll.
        yield* client.subscribeServerConfig({}).pipe(Stream.runForEach(event=>Effect.sync(()=>{
          if(event.type==="snapshot")publish(event.config.providers);
          else if(event.type==="providerStatuses")publish(event.payload.providers);
        })));
        yield* Effect.never;
      }).pipe(Effect.catchCause(()=>Effect.gen(function*(){subscription.onProviderCatalog!([]);yield* Effect.never;}))):Effect.never;
      const shellAndCatalog=Effect.raceFirst(shell,catalog);
      if(!subscription.onResources)return shellAndCatalog;
      const sample=Effect.gen(function*(){
        while(true){
          const resources=yield* client["server.getHostResources"]({}).pipe(
            Effect.timeout("3 seconds"),
            Effect.map(sample=>({state:"reported" as const,sample})),
            Effect.catchCause(()=>Effect.succeed({state:"unavailable" as const,sample:null})));
          subscription.onResources!(resources);
          yield* Effect.sleep("5 seconds");
        }
      });
      return Effect.raceFirst(shellAndCatalog,sample.pipe(Effect.catchCause(()=>Effect.gen(function*(){
        yield* Effect.sync(()=>subscription.onResources!({state:"unavailable",sample:null})).pipe(Effect.catchCause(()=>Effect.void));
        yield* Effect.never;
      }))));
    });
  } catch (error) {
    // Callback failures include switch RPC protocol/configuration failures.
    // Preserve their classification across Effect's callback defect boundary.
    throw callbackError ?? error;
  }
}
