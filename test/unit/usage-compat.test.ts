// Synthetic config values from official T3 v0.1.0 and v0.1.5 contracts.
// v0.1.5: 6d450a4284852af137b2f3407fddd89eb76e7644, packages/contracts/src/keybindings.ts.
// The F6 rules reproduce the native 0.1.5 keybindings migration.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { WebSocketServer } from "ws";
import {
  AbortedError, ProtocolIncompatibleError, connectUsage, withClient,
  type SwitchProvider,
} from "../../src/t3/adapter.ts";

const stamp = "2026-10-29T22:00:00.000Z";
const legacyRules = [{ key: "b", command: "threadPanel.toggle", whenAst: { type: "identifier", name: "terminalFocus" } }];
const addedRules = [
  { key: "f6", command: "workspace.focusNext" },
  { key: "f6", command: "workspace.focusPrevious", shiftKey: true },
  { key: "f6", command: "workspace.focusNext", modKey: true },
  { key: "f6", command: "workspace.focusPrevious", modKey: true, shiftKey: true },
  { key: "ArrowUp", command: "composer.increaseEffort", modKey: true },
  { key: "ArrowDown", command: "composer.decreaseEffort", modKey: true },
];
function configFor(version: "0.1.0" | "0.1.5") {
  return {
    environment: { environmentId: "fixture", label: "Fixture",
      platform: { os: "linux", arch: "x64" }, serverVersion: version,
      capabilities: { repositoryIdentity: false } },
    auth: { policy: "loopback-browser", bootstrapMethods: [], sessionMethods: [], sessionCookieName: "fixture" },
    cwd: "/fixture", keybindingsConfigPath: "/fixture/keys",
    keybindings: [...legacyRules, ...(version === "0.1.5" ? addedRules : [])].map(rule => ({
      command: rule.command,
      shortcut: { key: rule.key, metaKey: false, ctrlKey: false, altKey: false,
        shiftKey: "shiftKey" in rule ? rule.shiftKey : false,
        modKey: "modKey" in rule ? rule.modKey : false },
      ...("whenAst" in rule ? { whenAst: rule.whenAst } : {}),
    })),
    issues: [], availableEditors: [],
    observability: { logsDirectoryPath: "/fixture/logs", localTracingEnabled: false,
      otlpTracesEnabled: false, otlpMetricsEnabled: false },
    providers: [{
      instanceId: "codex", driver: "codex", enabled: true, installed: true,
      version: "fixture", status: "ready", auth: { status: "authenticated", type: "chatgpt", email: "private@example.invalid" },
      checkedAt: stamp,
      models: [{ slug: "fixture-model", name: "Fixture model", isCustom: false, capabilities: null }],
      usageLimits: { checkedAt: stamp, credentialFingerprint: "private-fingerprint",
        windows: [{ id: "primary", kind: "session", label: "Session", usedPercent: 25, windowDurationMins: 300 }],
        resetCredits: { availableCount: 1, nextCreditId: "private-credit" } },
    }],
    settings: { providerInstances: {
      codex: { driver: "codex", enabled: true, config: { preservedProfile: "private-profile" } },
    } },
  };
}

async function serve(config: ReturnType<typeof configFor>) {
  const server = createServer(), wss = new WebSocketServer({ server });
  const requests: string[] = [];
  wss.on("connection", socket => socket.on("message", data => {
    const request = JSON.parse(String(data));
    if (request._tag === "Ping") { socket.send(JSON.stringify({ _tag: "Pong" })); return; }
    if (request._tag !== "Request") return;
    requests.push(request.tag);
    if (request.tag === "server.getConfig") {
      socket.send(JSON.stringify({ _tag: "Exit", requestId: request.id, exit: { _tag: "Success", value: config } }));
    } else if (request.tag === "subscribeServerConfig") {
      const updated = structuredClone(config.providers);
      updated[0]!.usageLimits.windows[0]!.usedPercent = 60;
      socket.send(JSON.stringify({ _tag: "Chunk", requestId: request.id, values: [
        { version: 1, type: "snapshot", config },
        { version: 1, type: "providerStatuses", payload: { providers: updated } },
        { version: 1, type: "settingsUpdated", payload: { settings: { providerInstances: {
          codex: { ...config.settings.providerInstances.codex,
            environment: [{ name: "CODEX_HOME", value: "/fixture/protected-profile" }] },
        } } } },
      ] }));
    }
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    serverUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests,
    close: () => { for (const socket of wss.clients) socket.terminate(); wss.close(); server.close(); },
  };
}

for (const version of ["0.1.0", "0.1.5"] as const) {
  test(`official T3 ${version} config decodes and connectUsage publishes cached and streamed providers`, async () => {
    const config = configFor(version), fixture = await serve(config);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const options = { serverUrl: fixture.serverUrl, token: "synthetic", signal: controller.signal };
    try {
      const decoded = await withClient(options, client => client["server.getConfig"]({}));
      assert.deepEqual(decoded.keybindings.map(rule => rule.command), config.keybindings.map(rule => rule.command));
      const publications: ReadonlyArray<SwitchProvider>[] = [];
      await assert.rejects(connectUsage(options, providers => {
        publications.push(providers);
        if (publications.length === 4) controller.abort();
      }), AbortedError);
      assert.equal(publications.length, 4, "getConfig, snapshot, providerStatuses and settingsUpdated all publish");
      assert.deepEqual(publications.map(providers => providers[0]?.usageLimits?.windows[0]?.usedPercent), [25, 25, 60, 60]);
      assert.deepEqual(publications.map(providers => providers[0]?.quotaContextBlocked), [false, false, false, true]);
      assert.equal(publications[0]![0]!.models[0]!.slug, "fixture-model");
      assert.equal(publications[0]![0]!.usageLimits!.resetCredits!.availableCount, 1);
      assert.doesNotMatch(JSON.stringify(publications), /private-|private@|protected-profile/);
      assert.deepEqual(fixture.requests, ["server.getConfig", "server.getConfig", "subscribeServerConfig"]);
    } finally { clearTimeout(timer); controller.abort(); fixture.close(); }
  });
}

test("unknown keybinding commands still fail closed before provider publication", async () => {
  const config = configFor("0.1.5");
  config.keybindings[0]!.command = "workspace.unknown";
  const fixture = await serve(config);
  let publications = 0;
  try {
    await assert.rejects(connectUsage({
      serverUrl: fixture.serverUrl, token: "synthetic", signal: AbortSignal.timeout(5000),
    }, () => { publications++; }), ProtocolIncompatibleError);
    assert.equal(publications, 0);
    assert.deepEqual(fixture.requests, ["server.getConfig"]);
  } finally { fixture.close(); }
});
