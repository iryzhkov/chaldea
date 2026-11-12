// Run inside a Chaldea scratch HOME, against an official release and a packaged client.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { startDisposableT3, t3Version } from "./disposable-t3.ts";
import { withClient, switchPort } from "../../src/t3/adapter.ts";
import { ShellWatcher, waitFor, dispatchMessage } from "./e2e.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { writeJson } from "../../src/route/cache.ts";

assert.equal(homedir(), "/work/.scratch/home");
assert.equal(t3Version(), "t3 v" + (process.env.CHALDEA_SMOKE_VERSION ?? "0.1.6"));
const packaged = resolve(process.argv[2]!);
const base = join(homedir(), "official-smoke"); mkdirSync(base, { recursive: true });
const t3 = await startDisposableT3({ scratchRoot: base, scenario: "no-reset", autoResume: false,
  codex: "available", claudeModel: "claude-opus-5-5" });
let watcher: ShellWatcher | undefined;
try {
  const token = t3.issueToken(["orchestration:read", "orchestration:operate", "settings:write"]);
  const options = { serverUrl: t3.serverUrl, token, signal: AbortSignal.timeout(30000) };
  const config = await withClient(options, c => c["server.getConfig"]({}));
  assert.ok(config.providers.length > 0);
  const event = await withClient(options, c => c.subscribeServerConfig({}).pipe(Stream.take(1), Stream.runCollect));
  assert.equal(event[0]?.type, "snapshot");
  watcher = new ShellWatcher(t3.serverUrl, token);
  const threadId = await waitFor("bootstrap thread", () => watcher!.firstThreadId(), 30000);
  await dispatchMessage(t3, token, threadId, "official smoke", "smoke");
  const p = await withClient(options, c => c["orchestration.getThreadProjection"]({ threadId }));
  assert.ok(p.messages.some(m => m.id === "e2e-message-smoke"));
  const port = switchPort(options);
  assert.ok((await port.catalog()).providers.length > 0);
  await withClient(options, c => c["server.updateSettings"]({ patch: { autoResumeLimitedThreads: false } }).pipe(Effect.asVoid));
  const tokenFile = join(base, "token"), stateFile = join(base, "quota.json"), cacheDir = join(base, "cache");
  writeFileSync(tokenFile, token, { mode: 0o600 }); saveState(stateFile, emptyState(), Date.now());
  writeJson(join(cacheDir, "slopalytics.json"), { attemptedAt: Date.now(), fetchedAt: new Date().toISOString(),
    value: { fetchedAt: new Date().toISOString(), sourceFetchedAt: new Date().toISOString(),
      endExclusive: new Date().toISOString(), models: {} } });
  const configPath = join(base, "route.json");
  writeFileSync(configPath, JSON.stringify({ t3BaseDir: t3.baseDir, tokenFile, stateFile, cacheDir }));
  const run = (args: string[], input?: string) => {
    const result = spawnSync(process.execPath, [join(packaged, "bin/chaldea"), ...args], {
      encoding: "utf8", timeout: 30000, env: { ...process.env, CHALDEA_ROUTE_CONFIG: configPath },
      ...(input === undefined ? {} : { input }),
    });
    assert.equal(result.status, 0, result.stderr + result.stdout);
    return result.stdout;
  };
  const route = JSON.parse(run(["route", "--role", "general"])); assert.ok(route.model);
  run(["quota", "status", "--state-file", stateFile]);
  const list = JSON.parse(run(["mcp", "--config", configPath],
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n"));
  assert.deepEqual(list.result.tools.map((t: { name: string }) => t.name),
    ["chaldea_route", "chaldea_route_review_pair"]);
  console.log(JSON.stringify({ version: t3Version(), packaged, route: route.model,
    configStream: true, projection: true, dispatch: true, shell: true, settings: true, tools: 2 }));
} finally { await watcher?.close(); await t3.stop(); }
