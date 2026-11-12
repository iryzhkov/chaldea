import assert from "node:assert/strict";
import { test } from "node:test";
import * as S from "effect/Schema";
import * as DateTime from "effect/DateTime";
import { ServerProvider, OrchestrationV2ThreadShell, OrchestrationV2ThreadProjection,
  OrchestrationV2ShellStreamItem } from "../../src/t3/contracts.ts";
import { toSwitchProvider } from "../../src/t3/adapter.ts";

const provider = {
  instanceId: "future", driver: "futureDriver", enabled: true, installed: true,
  status: "futureStatus", auth: { status: "futureAuth" },
  models: [{ slug: "future", capabilities: null }],
  usageLimits: { checkedAt: "2026-11-12T00:00:00Z", windows: [
    { id: "w", kind: "futureWindow", usedPercent: 37 },
  ], unavailable: { reason: "futureReason" } },
};
test("provider decoder ignores additions and preserves unknown values without granting capacity", () => {
  const decoded = S.decodeUnknownSync(ServerProvider)({ ...provider, privateField: "discard" });
  assert.equal("privateField" in decoded, false);
  const domain = toSwitchProvider(decoded);
  assert.equal(domain.driver, "futureDriver");
  assert.equal(domain.status, "futureStatus");
  assert.equal(domain.usageLimits?.windows[0]?.kind, "futureWindow");
  assert.deepEqual(domain.usageLimits?.unavailable, { reason: "futureReason" });
});
test("provider decision fields are required and malformed windows are never silently dropped", () => {
  for (const key of ["instanceId", "driver", "enabled", "installed", "status", "auth", "models"]) {
    const bad: Record<string, unknown> = { ...provider }; delete bad[key];
    assert.throws(() => S.decodeUnknownSync(ServerProvider)(bad), key);
  }
  for (const usedPercent of [-1, 101, "50", null]) {
    assert.throws(() => S.decodeUnknownSync(ServerProvider)({
      ...provider, usageLimits: { ...provider.usageLimits, windows: [{ id: "w", kind: "session", usedPercent }] },
    }));
  }
  assert.throws(() => S.decodeUnknownSync(ServerProvider)({
    ...provider, models: [{ slug: "m" }],
  }));
});
const shell = {
  id: "t", providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "m" },
  settledOverride: null, lineage: { relationshipToParent: null },
  archivedAt: null, deletedAt: null, title: "t", status: "futureStatus",
  latestRunId: null, activeRunId: null, pendingRuntimeRequest: null,
};
test("shell decoder accepts official optional fields but requires switching preflight data", () => {
  assert.equal(S.decodeUnknownSync(OrchestrationV2ThreadShell)(shell).status, "futureStatus");
  for (const key of ["id", "modelSelection", "settledOverride", "lineage", "archivedAt", "deletedAt", "pendingRuntimeRequest"]) {
    const bad: Record<string, unknown> = { ...shell }; delete bad[key];
    assert.throws(() => S.decodeUnknownSync(OrchestrationV2ThreadShell)(bad), key);
  }
});
test("unknown shell variants and HTTP fallback cannot advance a cursor", () => {
  for (const kind of ["future-event", "snapshot-required"]) {
    assert.throws(() => S.decodeUnknownSync(OrchestrationV2ShellStreamItem)({ kind, sequence: 9 }));
  }
  for (const sequence of [-1, 0.5, "1"]) {
    assert.throws(() => S.decodeUnknownSync(OrchestrationV2ShellStreamItem)({ kind: "thread.removed", threadId: "t", sequence }));
  }
  const value = S.decodeUnknownSync(OrchestrationV2ShellStreamItem)({
    kind: "snapshot", snapshot: { snapshotSequence: 7, threads: [shell], archivedThreads: [shell], projects: [] },
  });
  assert.equal(value.kind, "snapshot");
});
test("projection decoding rejects missing arrays and malformed error variants", () => {
  const projection = { thread: shell, runs: [], turnItems: [], runtimeRequests: [], nodes: [], messages: [] };
  S.decodeUnknownSync(OrchestrationV2ThreadProjection)(projection);
  for (const key of ["runs", "turnItems", "runtimeRequests", "messages", "nodes"]) {
    const bad: Record<string, unknown> = { ...projection }; delete bad[key];
    assert.throws(() => S.decodeUnknownSync(OrchestrationV2ThreadProjection)(bad), key);
  }
  const errorItem = { id: "i", runId: null, nodeId: null, type: "error", status: "failed",
    ordinal: 0, updatedAt: DateTime.makeUnsafe("2026-11-12T00:00:00Z"), failure: { class: "usage_limit", resetAt: null } };
  const decoded = S.decodeUnknownSync(OrchestrationV2ThreadProjection)({ ...projection, turnItems: [errorItem] });
  assert.equal("failure" in decoded.turnItems[0]! && decoded.turnItems[0].failure.resetAt, null);
  assert.throws(() => S.decodeUnknownSync(OrchestrationV2ThreadProjection)({
    ...projection, turnItems: [{ id: "i", runId: null, nodeId: null, type: "error", status: "failed",
      ordinal: 0, updatedAt: DateTime.makeUnsafe("2026-11-12T00:00:00Z") }],
  }));
});
