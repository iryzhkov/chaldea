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
import { join } from "node:path";
import WebSocket from "ws";

import {
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  WsRpcGroup,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
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
  readonly id: string;
  readonly status: string;
  readonly providerInstanceId: string;
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

export function toShellThread(thread: OrchestrationV2ThreadShell): ShellThread {
  const recovery = thread.limitRecovery ?? null;
  return {
    id: thread.id,
    status: thread.status,
    providerInstanceId: thread.providerInstanceId,
    latestRunId: thread.latestRunId,
    activeRunId: thread.activeRunId,
    latestRunStartedAt: isoOrNull(thread.latestRunStartedAt),
    latestRunCompletedAt: isoOrNull(thread.latestRunCompletedAt),
    lastErrorClass: thread.lastErrorClass ?? null,
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    limitRecovery: recovery === null
      ? null
      : { runId: recovery.runId, resetAt: recovery.resetAt, autoResume: recovery.autoResume },
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

function isDecodeFailure(text: string): boolean {
  return /SchemaError|ParseError|Expected .* but got|Missing key|is missing/i.test(text);
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
    if (isDecodeFailure(text)) {
      throw new ProtocolIncompatibleError(`T3 sent data the pinned contracts reject: ${text}`);
    }
    throw new TransientConnectionError(text);
  }
}

/**
 * Subscribes to the shell stream and delivers mapped events until the stream
 * ends, the signal aborts, or the connection fails. Resolves when the server
 * ends the stream; rejects with one of the error classes above otherwise.
 */
export function connectShell(options: ConnectOptions, subscription: ShellSubscription): Promise<void> {
  return withClient(options, (client) =>
    client["orchestration.subscribeShell"]({
      ...(subscription.afterSequence === undefined ? {} : { afterSequence: subscription.afterSequence }),
      requestCompletionMarker: true,
    }).pipe(
      Stream.runForEach((item) => Effect.promise(async () => subscription.onEvent(toShellEvent(item)))),
    ),
  );
}
