// The only module that knows T3's wire protocol.
//
// Everything T3-specific lives here: the vendored contracts, the Effect RPC
// client, the WebSocket handshake, protocol gating and the mapping of shell
// stream items to the small domain type the quota observer consumes. The rest
// of Chaldea sees `connectShell` and the types below, nothing else.
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
export interface SwitchPort {
  catalog(): Promise<{ readonly providers: ReadonlyArray<SwitchProvider>; readonly autoResume: boolean }>;
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
    if (expectedEnvironment !== undefined) {
      const config = yield* client["server.getConfig"]({});
      if (String(config.environment.environmentId) !== expectedEnvironment) return yield* Effect.fail(new Error("message_environment"));
    }
    return yield* client["orchestration.dispatchCommand"](JSON.parse(payload)).pipe(
      Effect.map(() => true),
      Effect.catchTag("OrchestrationV2DispatchCommandError", error =>
        /previously rejected/i.test(error.message + " " + (error.detail ?? ""))
          ? Effect.succeed(false) : Effect.fail(error)));
  }));
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

/** Narrow read-only detail stream for Mission Control. Never exports raw items. */
export type MissionDetailEvent =
  | { kind: "synchronized" }
  | { kind: "cursor"; sequence: number }
  | { kind: "activity"; tool: string | null }
  | { kind: "usage"; turnId: string; output: number | null; at: number; baseline: boolean };
export async function connectMissionThread(options: ConnectOptions, threadId: string,
  afterSequence: number | undefined, onEvent: (event: MissionDetailEvent) => void): Promise<void> {
  await withClient(options, client => client["orchestration.subscribeThread"]({
    threadId, ...(afterSequence === undefined ? {} : { afterSequence }),
    requestCompletionMarker: true, acceptBoundedSnapshot: true, acceptCompactTurnItems: true,
  } as never).pipe(Stream.runForEach(item => Effect.sync(() => {
    if (item.kind === "synchronized") { onEvent({ kind: "synchronized" }); return; }
    if (item.kind === "snapshot") {
      for (const turn of item.projection.providerTurns.slice(-512)) {
        onEvent({ kind: "usage", turnId: turn.id, output: turn.tokenUsage?.outputTokens ?? null,
          at: turn.tokenUsage?.updatedAt ? Date.parse(turn.tokenUsage.updatedAt) : turn.startedAt ? DateTime.toEpochMillis(turn.startedAt) : 0, baseline: true });
      }
      const recent = [...item.projection.turnItems, ...item.projection.visibleTurnItems.map(row => row.item)]
        .filter(row => row.status === "running").toSorted((a,b) => b.ordinal - a.ordinal)[0];
      if (recent) onEvent({ kind: "activity", tool: "toolName" in recent && typeof recent.toolName === "string" ? recent.toolName : null });
      onEvent({ kind: "cursor", sequence: item.snapshotSequence }); return;
    }
    if (item.kind === "unknown-event") { onEvent({ kind: "cursor", sequence: item.sequence }); return; }
    if (item.kind === "event") {
      const e = item.event;
      if (e.type === "provider-turn.updated") {
        const turn = e.payload;
        onEvent({ kind: "usage", turnId: turn.id, output: turn.tokenUsage?.outputTokens ?? null,
          at: turn.tokenUsage?.updatedAt ? Date.parse(turn.tokenUsage.updatedAt) : DateTime.toEpochMillis(e.occurredAt), baseline: false });
      } else if (e.type === "turn-item.updated" && e.payload.status === "running") {
        onEvent({ kind: "activity", tool: "toolName" in e.payload && typeof e.payload.toolName === "string" ? e.payload.toolName : null });
      }
      onEvent({ kind: "cursor", sequence: item.sequence });
    }
  }))));
}

export async function connectShell(options: ConnectOptions, subscription: ShellSubscription): Promise<void> {
  let callbackError: unknown;
  try {
    await withClient(options, (client) =>
      client["orchestration.subscribeShell"]({
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
      ),
    );
  } catch (error) {
    // Callback failures include switch RPC protocol/configuration failures.
    // Preserve their classification across Effect's callback defect boundary.
    throw callbackError ?? error;
  }
}
