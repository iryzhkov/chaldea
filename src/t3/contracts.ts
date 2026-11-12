// Chaldea's consumed subset of official T3 0.1.6 and 0.1.9.
// Effect owns framing, cancellation and keepalive. Objects discard extra fields;
// required decision data never defaults. Open strings preserve future values.
import * as S from "effect/Schema";
import { Rpc, RpcGroup } from "effect/rpc";

export const ThreadId = S.String.check(S.isMinLength(1), S.isTrimmed());
const id = ThreadId;
const seq = S.Number.check(S.isInt(), S.isGreaterThanOrEqualTo(0));
const time = S.DateTimeUtc;
const nullableTime = S.NullOr(time);
const opt = S.optionalKey;
const model = S.Struct({
  instanceId: id, model: id,
  options: opt(S.Array(S.Struct({ id, value: S.Union([S.String, S.Boolean]) }))),
});
const recovery = S.NullOr(S.Struct({
  runId: id, resetAt: S.String, autoResume: S.Boolean,
  requestId: opt(id), snooze: opt(S.Boolean),
}));
const lineage = S.Struct({ relationshipToParent: S.NullOr(S.String) });
const threadFields = {
  id, providerInstanceId: id, modelSelection: model,
  settledOverride: S.NullOr(S.String), limitRecovery: opt(recovery), lineage,
  archivedAt: nullableTime, deletedAt: nullableTime,
};
export const OrchestrationV2ThreadShell = S.Struct({
  ...threadFields, title: S.String, status: S.String,
  latestRunId: S.NullOr(id), activeRunId: S.NullOr(id),
  latestRunStartedAt: opt(nullableTime), latestRunCompletedAt: opt(nullableTime),
  lastErrorClass: opt(S.NullOr(S.String)), usageLimitResetAt: opt(S.NullOr(S.String)),
  pendingRuntimeRequest: S.NullOr(S.Struct({ kind: S.String })),
});
export type OrchestrationV2ThreadShell = typeof OrchestrationV2ThreadShell.Type;
const failure = S.Struct({ class: S.String, resetAt: opt(S.NullOr(S.String)) });
const itemBase = {
  id, runId: S.NullOr(id), nodeId: S.NullOr(id), status: S.String, ordinal: seq, updatedAt: time,
};
const turnItem = S.Union([
  S.Struct({ ...itemBase, type: S.Literal("error"), failure }),
  S.Struct({ ...itemBase, type: S.String.check(S.isPattern(/^(?!error$).+/)) }),
]);
export const OrchestrationV2ThreadProjection = S.Struct({
  thread: S.Struct({ ...threadFields, snoozedUntil: opt(nullableTime) }),
  runs: S.Array(S.Struct({
    id, ordinal: seq, status: S.String, rootNodeId: S.NullOr(id), providerInstanceId: id, modelSelection: model,
    startedAt: nullableTime, completedAt: nullableTime,
    userMessageId: id,
  })),
  turnItems: S.Array(turnItem),
  runtimeRequests: S.Array(S.Struct({ status: S.String, kind: S.String, nodeId: id })),
  messages: S.Array(S.Struct({ id, role: S.String, text: S.String, attachments: S.Array(S.Unknown) })),
});
export type OrchestrationV2ThreadProjection = typeof OrchestrationV2ThreadProjection.Type;
export const OrchestrationV2ShellStreamItem = S.Union([
  S.Struct({ kind: S.Literal("synchronized") }),
  S.Struct({ kind: S.Literal("snapshot"), snapshot: S.Struct({
    snapshotSequence: seq,
    threads: S.Array(OrchestrationV2ThreadShell),
    archivedThreads: S.Array(OrchestrationV2ThreadShell),
  }) }),
  S.Struct({ kind: S.Literal("thread.updated"), sequence: seq, thread: OrchestrationV2ThreadShell }),
  S.Struct({ kind: S.Literal("thread.removed"), sequence: seq, threadId: id }),
  S.Struct({ kind: S.Literals(["project.updated", "project.removed"]), sequence: seq }),
]);
// Unknown shell variants, including snapshot-required, refuse the stream without
// advancing its cursor. We never request HTTP snapshot fallback.
export type OrchestrationV2ShellStreamItem = typeof OrchestrationV2ShellStreamItem.Type;
const descriptor = S.Union([
  S.Struct({ id, type: S.Literal("select"), options: S.Array(S.Struct({ id })) }),
  S.Struct({ id, type: S.String.check(S.isPattern(/^(?!select$).+/)) }),
]);
export const ServerProvider = S.Struct({
  instanceId: id, driver: S.String, enabled: S.Boolean, installed: S.Boolean,
  status: S.String, availability: opt(S.String),
  auth: S.Struct({ status: S.String, type: opt(S.String), workspaceId: opt(S.String) }),
  runtimePaths: opt(S.Struct({ homePath: S.String, shadowHomePath: S.NullOr(S.String) })),
  models: S.Array(S.Struct({ slug: id, capabilities: S.NullOr(S.Struct({
    optionDescriptors: opt(S.Array(descriptor)),
  })) })),
  usageLimits: opt(S.Struct({
    checkedAt: S.String,
    credentialFingerprint: opt(S.String),
    windows: S.Array(S.Struct({
      id, kind: S.String,
      usedPercent: S.Number.check(S.isGreaterThanOrEqualTo(0), S.isLessThanOrEqualTo(100)),
      resetsAt: opt(S.String), windowDurationMins: opt(S.Number),
    })),
    resetCredits: opt(S.Struct({ availableCount: seq, nextExpiresAt: opt(S.String) })),
    unavailable: opt(S.Struct({ reason: S.String })),
  })),
});
export type ServerProvider = typeof ServerProvider.Type;
const settings = S.Struct({
  autoResumeLimitedThreads: S.Boolean,
  sidebarAutoSettleOnMerge: S.Boolean,
  providerModelPreferences: S.NullOr(S.Record(S.String, S.Struct({ hiddenModels: S.Array(S.String) }))),
  providerInstances: S.Record(S.String, S.Struct({ environment: opt(S.Array(S.Unknown)) })),
});
const config = S.Struct({
  environment: S.Struct({ environmentId: id }),
  providers: S.Array(ServerProvider), settings,
});
const configEvent = S.Union([
  S.Struct({ type: S.Literal("snapshot"), config }),
  S.Struct({ type: S.Literal("providerStatuses"), payload: S.Struct({ providers: S.Array(ServerProvider) }) }),
  S.Struct({ type: S.Literal("settingsUpdated"), payload: S.Struct({ settings }) }),
  S.Struct({ type: S.String.check(S.isPattern(/^(?!snapshot$|providerStatuses$|settingsUpdated$).+/)) }),
]);
const authError = S.Struct({ _tag: S.Literal("EnvironmentAuthorizationError"), message: S.String });
const taggedError = <T extends string>(tag: T) => S.Struct({
  _tag: S.Literal(tag), message: opt(S.String), detail: opt(S.String),
  settingsPath: opt(S.String), configPath: opt(S.String), operation: opt(S.String),
  cause: opt(S.Unknown),
});
const configError = S.Union([authError, taggedError("KeybindingsConfigParseError"), taggedError("ServerSettingsError")]);
export const WsRpcGroup = RpcGroup.make(
  Rpc.make("server.getConfig", { payload: S.Struct({}), success: config, error: configError }),
  Rpc.make("subscribeServerConfig", { payload: S.Struct({}), success: configEvent, error: configError, stream: true }),
  Rpc.make("orchestration.getThreadProjection", {
    payload: S.Struct({ threadId: id }), success: OrchestrationV2ThreadProjection,
    error: S.Union([authError, taggedError("OrchestrationV2GetThreadProjectionError")]),
  }),
  Rpc.make("orchestration.dispatchCommand", {
    // Dispatch bytes are immutable journal records. The server validates the
    // command union; keeping unknown fields here preserves replay exactly.
    payload: S.Record(S.String, S.Unknown), success: S.Struct({ sequence: seq }),
    error: S.Union([authError, taggedError("OrchestrationV2DispatchCommandError")]),
  }),
  Rpc.make("orchestration.subscribeShell", {
    payload: S.Struct({ afterSequence: opt(seq), requestCompletionMarker: opt(S.Boolean) }),
    success: OrchestrationV2ShellStreamItem,
    error: S.Union([authError, taggedError("OrchestrationV2GetShellSnapshotError")]), stream: true,
  }),
  // Test fixture settings writer; production never changes native resume settings.
  Rpc.make("server.updateSettings", {
    payload: S.Struct({ patch: S.Record(S.String, S.Unknown) }), success: settings, error: configError,
  }),
);
