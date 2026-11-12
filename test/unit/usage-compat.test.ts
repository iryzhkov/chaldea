import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import * as Stream from "effect/Stream";
import { withClient, connectUsage, TransientConnectionError, AuthenticationError,
  ProtocolIncompatibleError, AbortedError, type SwitchProvider } from "../../src/t3/adapter.ts";

// Raw Effect RPC frames deliberately bypass our schemas to exercise official encoded errors.
async function fake(use: (request: any) => unknown[], run: (url: string) => Promise<void>) {
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data));
    if (request._tag === "Ping") socket.send(JSON.stringify({ _tag: "Pong" }));
    if (request._tag === "Request") for (const frame of use(request)) socket.send(JSON.stringify(frame));
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { for (const socket of wss.clients) socket.terminate(); await new Promise<void>(resolve => wss.close(() => server.close(() => resolve()))); }
}
const exit = (request: any, value: unknown) => ({
  _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value },
});
const settings = { autoResumeLimitedThreads: false, sidebarAutoSettleOnMerge: false,
  providerModelPreferences: null, providerInstances: {} };
const provider = (percent: number) => ({
  instanceId: "codex", driver: "codex", enabled: true, installed: true, status: "ready",
  auth: { status: "authenticated", type: "chatgpt", workspaceId: "private-workspace",
    accountId: "private-account", email: "private@example.com", plan: "private-plan" },
  models: [{ slug: "gpt-6.1", capabilities: null }], profile: { name: "private-profile" },
  usageLimits: { checkedAt: "2026-11-12T00:00:00Z",
    windows: [{ id: "session", kind: "session", usedPercent: percent }],
    resetCredits: { availableCount: 2, redemptionId: "private-redemption" } },
});
const config = { environment: { environmentId: "e" }, settings, providers: [provider(10)] };
const errors = [
  { _tag: "ServerSettingsError", settingsPath: "/scratch/settings.json", operation: "read-file",
    cause: { _tag: "Error", message: "EIO" } },
  { _tag: "ServerSettingsError", settingsPath: "/scratch/settings.json", operation: "write-managed-setting",
    managedSetting: "autoResumeLimitedThreads", managedBy: "organization" },
  { _tag: "KeybindingsConfigParseError", configPath: "/scratch/keybindings.json",
    detail: "invalid JSON", cause: { _tag: "Error", message: "parse failed" } },
];
for (const error of errors) for (const method of ["server.getConfig", "subscribeServerConfig", "server.updateSettings"] as const) {
  test(`${method}: official ${error._tag} ${"operation" in error ? error.operation : ""} without message is transient`, async () => {
    await fake(request => [{
      _tag: "Exit", requestId: request.id,
      exit: { _tag: "Failure", cause: [{ _tag: "Fail", error }] },
    }], async serverUrl => {
      await assert.rejects(withClient({ serverUrl, token: "t", signal: AbortSignal.timeout(5000) }, client =>
        method === "subscribeServerConfig" ? client[method]({}).pipe(Stream.runDrain)
          : method === "server.updateSettings" ? client[method]({ patch: { autoResumeLimitedThreads: true } })
          : client[method]({})), TransientConnectionError);
    });
  });
}
test("schema failure mentioning an auth union tag stays protocol incompatible", async () => {
  await fake(request => [exit(request, { malformed: "EnvironmentAuthorizationError forbidden" })], async serverUrl => {
    await assert.rejects(withClient({ serverUrl, token: "t" }, c => c["server.getConfig"]({})), ProtocolIncompatibleError);
  });
});
test("official authorization failure remains authentication failure", async () => {
  await fake(request => [{ _tag: "Exit", requestId: request.id,
    exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: {
      _tag: "EnvironmentAuthorizationError", message: "denied", requiredScope: "settings:write",
    } }] } }], async serverUrl => {
    await assert.rejects(withClient({ serverUrl, token: "t" }, c => c["server.getConfig"]({})), AuthenticationError);
  });
});
test("usage publishes getConfig, snapshot, providerStatuses and settingsUpdated with redaction", async () => {
  await fake(request => request.tag === "server.getConfig" ? [exit(request, config)] : [
    { _tag: "Chunk", requestId: request.id, values: [
      { type: "snapshot", config: { ...config, providers: [provider(20)] } },
      { type: "providerStatuses", payload: { providers: [provider(30)] } },
      { type: "settingsUpdated", payload: { settings: { ...settings,
        providerInstances: { codex: { environment: [{ key: "CODEX_HOME", value: "/private-profile" }] } } } } },
    ] },
  ], async serverUrl => {
    const seen: ReadonlyArray<SwitchProvider>[] = [];
    const controller = new AbortController();
    await assert.rejects(connectUsage({ serverUrl, token: "t", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) },
      providers => { seen.push(providers); if (seen.length === 4) controller.abort(); }), AbortedError);
    assert.deepEqual(seen.map(p => p[0]?.usageLimits?.windows[0]?.usedPercent), [10, 20, 30, 30]);
    assert.deepEqual(seen.map(p => p[0]?.quotaContextBlocked), [false, false, false, true]);
    for (const providers of seen) {
      assert.match(providers[0]!.quotaAccountKey!, /^[0-9a-f]{64}$/);
      assert.doesNotMatch(JSON.stringify(providers), /private-|private@|redemptionId|accountId|email|profile/);
      assert.equal(providers[0]?.usageLimits?.resetCredits?.availableCount, 2);
    }
  });
});
