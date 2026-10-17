import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { dispatchMessage, FEED_RECORDER, readFeed, ShellWatcher, waitFor, writePrivateFile } from "../helpers/e2e.ts";
import { scratchDir, SCRATCH_ROOT } from "../helpers/scratch.ts";
import { createLogger } from "../../src/log.ts";
import { captureRestart, recoverPlannedRestarts, RestartJournal, restartConfig, restartT3, runtimeEpoch, waitForRestart } from "../../src/t3/restart.ts";
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
      await waitFor("provider receives first turn", () => t3.fakeClaudeEvents().some(e => e.kind === "turn" || e.kind === "native_question" || e.kind === "secret_requested"), 30_000);
      if (text.includes("chaldea-native-secret")) {
        const deadline = Date.now() + 10_000;
        while (!(await projection())?.waitingForUser) {
          if (Date.now() > deadline) throw new Error("Secret card did not appear: " + JSON.stringify(t3.fakeClaudeEvents().filter(e => e.kind !== "spawn")));
          await new Promise(r => setTimeout(r, 100));
        }
      }
      return (await projection())!.run!;
    },
    async restart(prepare?: () => void) {
      const epoch = runtimeEpoch(t3.baseDir);
      await watcher.close(); await t3.stopServer(); prepare?.(); await t3.startServer();
      await waitForRestart(options, epoch);
    },
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
    // dispatching dies before send; resumed dies after acceptance/readback but
    // before acknowledgement. Both recover from the committed capture.
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

test("failed restart command cannot arm a later unplanned restart", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await f.start();
    f.config.command = [process.execPath, "-e", "process.exit(19)"];
    await assert.rejects(restartT3(f.options), /restart command failed/);
    assert.equal(f.journal.entries(f.t3.baseDir).length, 0);
    await f.restart();
    await recoverPlannedRestarts(f.options, f.journal, f.poster);
    assert.equal((await f.projection())!.thread.latestRunId, (await f.projection())!.run!.id);
    const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
      c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
    assert.equal(p.runs.length, 1);
  } finally { await f.close(); }
});

test("an unobserved expired intent cannot revive after a later boot", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await f.start(); await captureRestart(f.options, f.journal); await f.restart();
    // Advance the fixture journal beyond its admission deadline without a real
    // ninety-second sleep. No recovery process observed this first new boot.
    f.journal.db.prepare("UPDATE restarts SET captured_at = ?, expires_at = ?")
      .run(Date.now() - 200_000, Date.now() - 1);
    await f.restart(); await recoverPlannedRestarts(f.options, f.journal, f.poster);
    const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
      c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
    assert.equal(p.runs.length, 1); assert.equal(f.records.length, 0);
    assert.equal(f.journal.entries(f.t3.baseDir).length, 0);
  } finally { await f.close(); }
});

test("auth retry cannot drift into another observed boot", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await f.start(); await captureRestart(f.options, f.journal); await f.restart();
    const readonly = join(f.dir.path, "read-token");
    writePrivateFile(readonly, f.t3.issueToken(["orchestration:read"]));
    await recoverPlannedRestarts({ ...f.options, tokenFile: readonly }, f.journal, f.poster);
    assert.ok(f.journal.entries(f.t3.baseDir)[0]!.retry_at > Date.now());
    await f.restart(); await recoverPlannedRestarts(f.options, f.journal, f.poster);
    assert.equal(f.records.length, 0); assert.equal(f.journal.entries(f.t3.baseDir).length, 0);
  } finally { await f.close(); }
});

test("unavailable restart journal does not stop quota observation", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const { ObserverProcess } = await import("../helpers/e2e.ts");
  let observer: InstanceType<typeof ObserverProcess> | undefined;
  try {
    const config = join(f.dir.path, "bad-config.json"), feed = join(f.dir.path, "feed.jsonl");
    writeFileSync(config, JSON.stringify({ ...f.config, journalPath: f.dir.path }));
    observer = new ObserverProcess({ t3BaseDir: f.t3.baseDir, tokenFile: f.tokenFile,
      statePath: join(f.dir.path, "quota.json"), feedLog: feed, scratch: f.dir.path, restartConfig: config });
    await waitFor("quota subscription despite bad journal", () => observer!.subscriptions() === 1, 30_000);
    await dispatchMessage(f.t3, f.token, f.thread, f.t3.trigger, "bad-restart-journal");
    await waitFor("quota observation", () => readFeed(feed).some(e => e.body.kind === "quota_reset_unknown"), 30_000);
    assert.equal(observer.subscriptions(), 1);
  } finally { await observer?.stop(); await f.close(); }
});

test("provider disabled during restart is terminal and never retries a continuation", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await f.start(); await captureRestart(f.options, f.journal);
    await f.restart(() => {
      const settings = JSON.parse(readFileSync(f.t3.settingsPath, "utf8"));
      settings.providerInstances.claudeAgent.enabled = false;
      writeFileSync(f.t3.settingsPath, JSON.stringify(settings));
    });
    await recoverPlannedRestarts(f.options, f.journal, f.poster);
    assert.equal(f.journal.entries(f.t3.baseDir).length, 0);
    assert.equal(f.records.length, 0);
  } finally { await f.close(); }
});

test("capture is atomic if journalling a later thread fails", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await f.start();
    const capture = f.journal.capture.bind(f.journal);
    f.journal.capture = (...args) => { capture(...args); throw new Error("simulated later capture failure"); };
    await assert.rejects(captureRestart(f.options, f.journal), /later capture failure/);
    assert.equal(f.journal.entries(f.t3.baseDir).length, 0);
    await f.restart();
    await recoverPlannedRestarts(f.options, f.journal, f.poster);
    assert.equal(f.records.length, 0);
  } finally { await f.close(); }
});

test("read-only recovery is isolated from quota observation and backs off", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  const { ObserverProcess } = await import("../helpers/e2e.ts");
  let observer: InstanceType<typeof ObserverProcess> | undefined;
  try {
    await f.start(); await captureRestart(f.options, f.journal); await f.restart();
    const config = join(f.dir.path, "observer-config.json"), feed = join(f.dir.path, "feed.jsonl");
    writeFileSync(config, JSON.stringify(f.config));
    const readonly = join(f.dir.path, "read-token");
    writePrivateFile(readonly, f.t3.issueToken(["orchestration:read"]));
    observer = new ObserverProcess({ t3BaseDir: f.t3.baseDir, tokenFile: readonly,
      statePath: join(f.dir.path, "quota.json"), feedLog: feed, scratch: f.dir.path, restartConfig: config });
    await waitFor("scope failure without stream loss", () => observer!.lines.some(l => l.message === "planned restart continuation deferred"), 30_000);
    assert.ok(f.journal.entries(f.t3.baseDir).every(i => i.retry_at > Date.now() + 100_000));
    await dispatchMessage(f.t3, f.token, f.thread, f.t3.trigger, "after-readonly-recovery");
    await waitFor("live quota record", () => readFeed(feed).some(e => e.body.kind === "quota_reset_unknown"), 30_000);
    assert.equal(observer.subscriptions(), 1);
    assert.equal(f.records.length, 0);
  } finally { await observer?.stop(); await f.close(); }
});

for (const native of [false, true]) test(`Chaldea never admits a secret card (native=${native})`, { skip, timeout: 120_000 }, async () => {
  const f = await fixture(native);
  try {
    await f.start("chaldea-native-secret");
    await captureRestart(f.options, f.journal);
    assert.equal(f.journal.entries(f.t3.baseDir).length, 0, "pending secret is never admitted");
    await f.restart(); await recoverPlannedRestarts(f.options, f.journal, f.poster);
    const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
      c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
    if (!native) assert.equal(p.runs.length, 1);
    // Native 0.1.0 can race secret cancellation against shutdown; any linked
    // continuation here is native: Chaldea has no captured row or feed record.
    assert.equal(f.journal.entries(f.t3.baseDir).length, 0, "no Chaldea intent exists to dispatch");
    console.log(JSON.stringify({ nativeSecretProbe: native, runsAfterRestart: p.runs.length }));
    assert.equal(f.records.length, 0);
  } finally { await f.close(); }
});

test("secret card created after capture also blocks recovery after shutdown cancels it", { skip, timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const run = await f.start(); await captureRestart(f.options, f.journal);
    await f.command({ type: "message.dispatch", commandId: "late-secret", messageId: "late-secret",
      threadId: f.thread, text: "chaldea-native-secret", attachments: [],
      dispatchMode: { type: "steer_active", targetRunId: run.id }, createdBy: "user", creationSource: "web" });
    const deadline = Date.now() + 15_000;
    while (!(await f.projection())?.waitingForUser) {
      if (Date.now() > deadline) throw new Error("Late secret card did not appear");
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(f.journal.entries(f.t3.baseDir).length, 1);
    await f.restart(); await recoverPlannedRestarts(f.options, f.journal, f.poster);
    const p = await withClient({ serverUrl: f.t3.serverUrl, token: f.token },
      c => c["orchestration.getThreadProjection"]({ threadId: f.thread } as never));
    assert.equal(p.runs.length, 1); assert.equal(f.records.length, 0);
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
