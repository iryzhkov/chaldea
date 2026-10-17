import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { dispatchMessage, FEED_RECORDER, readFeed, ShellWatcher, waitFor, writePrivateFile } from "../helpers/e2e.ts";
import { scratchDir, SCRATCH_ROOT } from "../helpers/scratch.ts";
import { createLogger } from "../../src/log.ts";
import { captureRestart, recoverPlannedRestarts, RestartJournal, restartConfig } from "../../src/t3/restart.ts";
import { restartMessageId, restartProjection } from "../../src/t3/restart-port.ts";
import { withClient } from "../../src/t3/adapter.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";

const skip = t3Version() === "t3 v0.1.0" ? false : "needs pinned T3";
if (skip && process.env.CHALDEA_REQUIRE_E2E === "1") throw new Error(skip);
const logger = createLogger(() => {});

async function fixture(native = false) {
  const dir = scratchDir("restart");
  const t3 = await startDisposableT3({ scratchRoot: SCRATCH_ROOT, scenario: "no-reset", autoResume: false, restartContinuation: native });
  const token = t3.issueToken(["orchestration:read", "orchestration:operate"]);
  const tokenFile = join(dir.path, "token");
  writePrivateFile(tokenFile, token);
  const watcher = new ShellWatcher(t3.serverUrl, token);
  const thread = await waitFor("bootstrap thread", () => watcher.firstThreadId(), 30_000);
  const config = { ...restartConfig(), journalPath: join(dir.path, "restart.sqlite") };
  const options = { t3BaseDir: t3.baseDir, tokenFile, config, logger };
  const journal = new RestartJournal(config.journalPath);
  const records: QuotaRecord[] = [];
  const poster = { enqueue(record: QuotaRecord, ack?: () => boolean | void) { records.push(record); ack?.(); } };
  const command = (c: unknown) => withClient({ serverUrl: t3.serverUrl, token },
    client => client["orchestration.dispatchCommand"](c as never) as Effect.Effect<unknown, unknown>);
  const projection = () => restartProjection({ serverUrl: t3.serverUrl, token }, thread);
  return {
    dir, t3, token, tokenFile, thread, config, options, journal, records, poster, command, projection,
    async start(text = "chaldea-restart-hold") {
      await dispatchMessage(t3, token, thread, text, "restart-first");
      await waitFor("provider receives first turn", () => t3.fakeClaudeEvents().some(e => e.kind === "turn" || e.kind === "native_question"), 30_000);
      return (await projection())!.run!;
    },
    async restart() { await watcher.close(); await t3.stopServer(); await t3.startServer(); },
    async close() { journal.close(); await watcher.close(); await t3.stop(); dir.remove(); },
  };
}

for (const native of [false, true]) test(`planned restart gives exactly one continuation (native=${native})`, { skip, timeout: 120_000 }, async () => {
  const f = await fixture(native);
  const service = createServer(async (_req, res) => {
    try { await f.restart(); res.end("restarted"); } catch { res.writeHead(500).end(); }
  });
  try {
    const run = await f.start();
    await new Promise<void>(resolve => service.listen(0, "127.0.0.1", resolve));
    const address = service.address() as { port: number };
    const configFile = join(f.dir.path, "config.json"), feed = join(f.dir.path, "feed.jsonl");
    writeFileSync(configFile, JSON.stringify({ ...f.config,
      command: ["curl", "--silent", "--fail", "--request", "POST", `http://127.0.0.1:${address.port}`] }));
    // Child CLI is given a fixture feed executable and its own HOME.
    const result = await new Promise<{ code: number | null; stderr: string }>(resolve => {
      const child = spawn(process.execPath, ["src/cli.ts", "t3", "restart",
        "--t3-base-dir", f.t3.baseDir, "--token-file", f.tokenFile, "--restart-config", configFile,
        "--feed-command", FEED_RECORDER], {
        env: { PATH: process.env.PATH!, HOME: f.dir.path, TMPDIR: f.dir.path, FEED_RECORDER_LOG: feed },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let stderr = ""; child.stderr.on("data", c => { stderr += c; });
      child.on("exit", code => resolve({ code, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    await recoverPlannedRestarts(f.options, f.journal, f.poster);
    const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
      c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
    assert.equal(p.runs.length, 2);
    assert.equal(p.runs.filter(r => r.restartContinuationOfRunId === run.id).length, 1);
    if (!native) assert.equal(p.messages.filter(m => m.id === restartMessageId(run.id)).length, 1);
    assert.equal(readFeed(feed).filter(e => e.body.kind === "restart_resumed").length, 1);
    assert.equal(f.records.length, 0, "CLI feed receipt was durable");
  } finally { service.close(); await f.close(); }
});

for (const boundary of ["dispatching", "resumed"]) test(`observer recovers process death at ${boundary} without a duplicate`, { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const run = await f.start();
    await captureRestart(f.options, f.journal);
    await f.restart();
    // Fresh child dies exactly after the RPC acceptance/readback, before saving
    // resumed or posting a record. Its committed dispatching intent survives.
    const result = await new Promise<number | null>(resolve => {
      const child = spawn(process.execPath, ["test/helpers/crash-restart.ts", f.config.journalPath, f.t3.baseDir, f.tokenFile, boundary], {
        env: { PATH: process.env.PATH!, HOME: f.dir.path, TMPDIR: f.dir.path }, stdio: "ignore",
      });
      child.on("exit", resolve);
    });
    assert.equal(result, 73);
    // Use the real observer startup/reconnect path and scoped feed recorder.
    const { ObserverProcess } = await import("../helpers/e2e.ts");
    const feed = join(f.dir.path, "observer-feed.jsonl"), config = join(f.dir.path, "observer-config.json");
    writeFileSync(config, JSON.stringify(f.config));
    const observer = new ObserverProcess({ t3BaseDir: f.t3.baseDir, tokenFile: f.tokenFile,
      statePath: join(f.dir.path, "quota.json"), feedLog: feed, scratch: f.dir.path, restartConfig: config });
    try {
      await waitFor("restart feed", () => readFeed(feed).some(e => e.body.kind === "restart_resumed"), 30_000);
      await recoverPlannedRestarts(f.options, f.journal, f.poster);
      const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
        c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
      assert.equal(p.runs.length, 2);
      assert.equal(p.messages.filter(m => m.id === restartMessageId(run.id)).length, 1);
      assert.equal(readFeed(feed).filter(e => e.body.kind === "restart_resumed").length, 1);
    } finally { await observer.stop(); }
  } finally { await f.close(); }
});

for (const mode of ["cancel", "quota", "question", "archived", "settled", "completed", "provider", "disabled"] as const) {
  test(`restart never continues ${mode}`, { skip, timeout: 120_000 }, async () => {
    const f = await fixture();
    try {
      const text = mode === "quota" ? f.t3.trigger : mode === "question" ? "chaldea-native-question" :
        mode === "completed" ? "Finish now" : mode === "provider" ? "chaldea-provider-crash" : "chaldea-restart-hold";
      const run = await f.start(text);
      // Capture before cancellation/metadata mutation, covering the restart race.
      await captureRestart(f.options, f.journal);
      if (mode === "cancel") await f.command({ type: "run.interrupt", commandId: "cancel", threadId: f.thread, runId: run.id, reason: "user stop", holdQueue: true });
      if (mode === "archived") await f.command({ type: "thread.archive", commandId: "archive", threadId: f.thread });
      if (mode === "disabled") f.config.enabled = false;
      await f.restart();
      if (mode === "settled") await f.command({ type: "thread.settle", commandId: "settled", threadId: f.thread });
      await recoverPlannedRestarts(f.options, f.journal, f.poster);
      const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
        c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
      assert.equal(p.runs.length, 1);
      assert.equal(f.records.length, 0);
    } finally { await f.close(); }
  });
}
