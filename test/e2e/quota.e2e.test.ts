// End-to-end: the real pinned t3 (v0.1.0) with a fake Claude CLI, T3's native
// auto-resume, and `chaldea quota observe` as a child process writing to a
// feed recorder. Fixtures live under the scratch directory and are removed
// whether a test passes or fails. Skipped when the pinned t3 is not installed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { prepareDisposableT3, startDisposableT3, t3Version, type DisposableT3 } from "../helpers/disposable-t3.ts";
import {
  ObserverProcess,
  ShellWatcher,
  dispatchMessage,
  readFeed,
  readSettings,
  runCli,
  sleep,
  updateSettings,
  waitFor,
  writePrivateFile,
} from "../helpers/e2e.ts";
import { SCRATCH_ROOT, scratchDir } from "../helpers/scratch.ts";

const PINNED_VERSION = "t3 v0.1.0";
const version = t3Version();
const skip = version === PINNED_VERSION ? false : `needs ${PINNED_VERSION}, found ${version ?? "none"}`;
// CI sets this so a missing or wrong t3 fails the run instead of skipping it.
if (skip !== false && process.env.CHALDEA_REQUIRE_E2E === "1") throw new Error(skip);

/**
 * T3's due-work sweep runs every five seconds; the bound leaves room for the
 * tick itself and a loaded CI host. Measured lateness is printed every run.
 */
const MAX_LATENESS_SECONDS = 10;

const cleanups: Array<() => Promise<void> | void> = [];
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Harness {
  readonly t3: DisposableT3;
  readonly readToken: string;
  readonly operateToken: string;
  readonly observers: Array<ObserverProcess>;
  readonly watcher: ShellWatcher;
  readonly threadId: string;
  readonly dir: string;
  readonly feedLog: string;
  startObserver(): Promise<ObserverProcess>;
}

async function harness(options: { scenario: "reset" | "no-reset"; autoResume: boolean; resetDelaySeconds?: number }): Promise<Harness> {
  const dir = scratchDir("e2e");
  cleanups.push(dir.remove);
  const t3 = await startDisposableT3({ scratchRoot: SCRATCH_ROOT, ...options });
  cleanups.push(() => t3.stop());
  const readToken = t3.issueToken(["orchestration:read"]);
  const operateToken = t3.issueToken(["orchestration:read", "orchestration:operate", "settings:write"]);
  const tokenFile = join(dir.path, "t3-token");
  writePrivateFile(tokenFile, `${readToken}\n`);
  const watcher = new ShellWatcher(t3.serverUrl, readToken);
  cleanups.push(() => watcher.close());
  const threadId = await waitFor("the bootstrap thread", () => watcher.firstThreadId(), 30_000);
  const feedLog = join(dir.path, "feed.jsonl");
  const statePath = join(dir.path, "state", "quota-observer.json");
  const observers: Array<ObserverProcess> = [];
  return {
    t3,
    readToken,
    operateToken,
    observers,
    watcher,
    threadId,
    dir: dir.path,
    feedLog,
    async startObserver() {
      const observer = new ObserverProcess({ serverUrl: t3.serverUrl, tokenFile, statePath, feedLog, scratch: dir.path });
      cleanups.push(() => void observer.stop("SIGKILL"));
      observers.push(observer);
      await waitFor("the observer to subscribe", () => observer.subscriptions() > 0, 30_000);
      return observer;
    },
  };
}

/** No credential and no transcript text may reach feed bodies or observer logs. */
function assertNothingLeaked(h: Harness, transcript: string): void {
  const feed = readFileSync(h.feedLog, "utf8");
  const logs = JSON.stringify(h.observers.map((observer) => observer.lines));
  for (const [name, text] of [["feed", feed], ["observer logs", logs]] as const) {
    assert.ok(!text.includes(h.readToken), `${name} contain the observer token`);
    assert.ok(!text.includes(h.operateToken), `${name} contain a token`);
    assert.ok(!text.includes(transcript), `${name} contain transcript text`);
  }
}

function kinds(feedLog: string): Array<string> {
  return readFeed(feedLog).map((entry) => String(entry.body.kind));
}

function turns(t3: DisposableT3, outcome: string, continuation?: boolean): number {
  return t3
    .fakeClaudeEvents()
    .filter((e) => e.kind === "turn" && e.outcome === outcome && (continuation === undefined || e.continuation === continuation)).length;
}

test("a known reset resumes natively once and the observer records park and resume once", { skip, timeout: 180_000 }, async () => {
  const h = await harness({ scenario: "reset", autoResume: true, resetDelaySeconds: 10 });
  const first = await h.startObserver();
  await dispatchMessage(h.t3, h.operateToken, h.threadId, `Start the work. ${h.t3.trigger}`, "1");

  await waitFor("quota_parked", () => kinds(h.feedLog).includes("quota_parked"), 30_000);
  const parked = readFeed(h.feedLog)[0]!;
  const resetAt = String(parked.body.resetAt);
  const resetMs = Date.parse(resetAt);
  assert.ok(resetMs > Date.now(), "the reset is still ahead when the park is recorded");

  // Crash the observer mid-wait and start it again from its state file.
  await first.stop("SIGKILL");
  await h.startObserver();

  await waitFor("quota_resumed", () => kinds(h.feedLog).includes("quota_resumed"), 40_000);
  // Stay through more than one more five-second sweep to catch a second wake.
  await sleep(7_000);
  const restarted = await h.startObserver();
  await sleep(1_000);
  await restarted.stop();

  assert.deepEqual(kinds(h.feedLog), ["quota_parked", "quota_resumed"]);
  const [parkedEntry, resumedEntry] = readFeed(h.feedLog);
  for (const entry of [parkedEntry!, resumedEntry!]) {
    const flag = (name: string) => entry.args[entry.args.indexOf(name) + 1];
    assert.equal(flag("--source"), "chaldea-quota");
    assert.equal(flag("--tag"), "quota chaldea");
    assert.equal(flag("--host"), "e2e-host");
  }
  assert.equal(parkedEntry!.args[parkedEntry!.args.indexOf("--severity") + 1], "warn");
  assert.equal(resumedEntry!.args[resumedEntry!.args.indexOf("--severity") + 1], "info");
  assert.equal(parkedEntry!.body.threadId, h.threadId);
  assert.equal(parkedEntry!.body.provider, "claudeAgent");
  assert.equal(resumedEntry!.body.runId, parkedEntry!.body.runId);
  assert.equal(resumedEntry!.body.trigger, "auto_resume");

  // Exactly one continuation message reached the provider, as exactly one new run.
  assert.equal(turns(h.t3, "limited"), 1);
  assert.equal(turns(h.t3, "completed", true), 1);
  assert.equal(turns(h.t3, "completed"), 1);
  const runs = [...(h.watcher.runs.get(h.threadId) ?? [])];
  assert.equal(runs.length, 2, `runs: ${runs.join(", ")}`);
  assert.equal(resumedEntry!.body.continuationRunId, runs[1]);

  const startedMs = Date.parse(h.watcher.runStarts.get(runs[1]!)!);
  const lateness = (startedMs - resetMs) / 1000;
  process.stdout.write(`# measured resume lateness: ${lateness.toFixed(3)} s after reset (observer reported ${resumedEntry!.body.latenessSeconds} s)\n`);
  assert.ok(lateness >= 0, `continuation started ${lateness}s before the reset`);
  assert.ok(lateness <= MAX_LATENESS_SECONDS, `continuation started ${lateness}s after the reset`);
  assertNothingLeaked(h, "Start the work.");
});

test("a hard limit without a reset stays parked with exactly one quota_reset_unknown", { skip, timeout: 120_000 }, async () => {
  const h = await harness({ scenario: "no-reset", autoResume: true });
  const first = await h.startObserver();
  await dispatchMessage(h.t3, h.operateToken, h.threadId, `Start the work. ${h.t3.trigger}`, "1");

  await waitFor("quota_reset_unknown", () => kinds(h.feedLog).includes("quota_reset_unknown"), 30_000);
  await first.stop("SIGKILL");
  await h.startObserver();
  // More than two native sweeps: nothing may resume a stop with no reset.
  await sleep(12_000);

  assert.deepEqual(kinds(h.feedLog), ["quota_reset_unknown"]);
  assert.equal(readFeed(h.feedLog)[0]!.args[readFeed(h.feedLog)[0]!.args.indexOf("--severity") + 1], "warn");
  const thread = h.watcher.threads.get(h.threadId)!;
  assert.equal(thread.status, "failed");
  assert.equal(thread.lastErrorClass, "usage_limit");
  assert.equal(thread.usageLimitResetAt, null);
  assert.equal(thread.limitRecovery, null);
  assert.equal(h.watcher.runs.get(h.threadId)?.size, 1);
  assert.equal(turns(h.t3, "completed"), 0);
  assertNothingLeaked(h, "Start the work.");
});

test("chaldea t3 set-auto-resume enables native resume without a restart or losing other settings", { skip, timeout: 120_000 }, async () => {
  // The reset is far enough ahead that recovery is armed well before it.
  const h = await harness({ scenario: "reset", autoResume: false, resetDelaySeconds: 25 });
  assert.equal((await readSettings(h.t3, h.operateToken)).autoResumeLimitedThreads, false);
  await dispatchMessage(h.t3, h.operateToken, h.threadId, `Start the work. ${h.t3.trigger}`, "1");
  const stopped = await waitFor("the usage-limit stop", () => {
    const thread = h.watcher.threads.get(h.threadId);
    return thread?.lastErrorClass === "usage_limit" ? thread : null;
  }, 30_000);
  const resetMs = Date.parse(stopped.usageLimitResetAt!);
  // With the setting off, a sweep passes without arming recovery.
  await sleep(6_000);
  assert.equal(h.watcher.threads.get(h.threadId)?.limitRecovery, null);

  // Another client changes an unrelated setting first; it must survive.
  await updateSettings(h.t3, h.operateToken, { sidebarAutoSettleOnMerge: false });

  // The documented procedure: a token with only settings:write, used once.
  const settingsToken = join(h.dir, "t3-settings-token");
  writePrivateFile(settingsToken, `${h.t3.issueToken(["settings:write"])}\n`);
  const enabled = await runCli(["t3", "set-auto-resume", "on", "--server-url", h.t3.serverUrl, "--token-file", settingsToken], h.dir);
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.equal(enabled.stdout, "autoResumeLimitedThreads is on\n");

  await waitFor("the continuation run", () => (h.watcher.runs.get(h.threadId)?.size ?? 0) >= 2, 45_000);
  const after = await readSettings(h.t3, h.operateToken);
  assert.equal(after.autoResumeLimitedThreads, true);
  assert.equal(after.sidebarAutoSettleOnMerge, false);
  const runs = [...h.watcher.runs.get(h.threadId)!];
  const lateness = (Date.parse(h.watcher.runStarts.get(runs[1]!)!) - resetMs) / 1000;
  process.stdout.write(`# set-auto-resume after the stop: continuation ${lateness.toFixed(3)} s after reset\n`);
  assert.ok(lateness >= 0 && lateness <= MAX_LATENESS_SECONDS, `lateness ${lateness}`);
  assert.equal(turns(h.t3, "completed", true), 1);

  // T3 persisted it with its own writer, alongside the other change.
  const persisted = JSON.parse(readFileSync(h.t3.settingsPath, "utf8"));
  assert.equal(persisted.autoResumeLimitedThreads, true);
  assert.equal(persisted.sidebarAutoSettleOnMerge, false);

  const disabled = await runCli(["t3", "set-auto-resume", "off", "--server-url", h.t3.serverUrl, "--token-file", settingsToken], h.dir);
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(disabled.stdout, "autoResumeLimitedThreads is off\n");
  assert.equal((await readSettings(h.t3, h.operateToken)).autoResumeLimitedThreads, false);
  assert.ok(!enabled.stdout.includes("token") && !enabled.stderr.includes("token"));
});

test("the observer starts before T3, and a T3 restart while parked neither loses nor repeats records", { skip, timeout: 240_000 }, async () => {
  const dir = scratchDir("e2e");
  cleanups.push(dir.remove);
  const t3 = prepareDisposableT3({ scratchRoot: SCRATCH_ROOT, scenario: "reset", autoResume: true, resetDelaySeconds: 25 });
  cleanups.push(() => t3.stop());
  const readToken = t3.issueToken(["orchestration:read"]);
  const tokenFile = join(dir.path, "t3-token");
  writePrivateFile(tokenFile, `${readToken}\n`);
  const feedLog = join(dir.path, "feed.jsonl");

  // As after a reboot: the observer comes up first and finds no T3.
  const observer = new ObserverProcess({ t3BaseDir: t3.baseDir, tokenFile, statePath: join(dir.path, "state.json"), feedLog, scratch: dir.path });
  cleanups.push(() => void observer.stop("SIGKILL"));
  await waitFor("a failed connection attempt", () => observer.lines.some((line) => line.message === "T3 connection failed"), 15_000);
  await sleep(2_000);
  assert.equal(observer.exitCode, null, "the observer must keep retrying, not exit");

  await t3.startServer();
  await waitFor("the observer to subscribe", () => observer.subscriptions() >= 1, 60_000);
  const operateToken = t3.issueToken(["orchestration:read", "orchestration:operate"]);
  const watcher = new ShellWatcher(t3.serverUrl, readToken);
  cleanups.push(() => watcher.close());
  const threadId = await waitFor("the bootstrap thread", () => watcher.firstThreadId(), 30_000);
  await dispatchMessage(t3, operateToken, threadId, `Start the work. ${t3.trigger}`, "1");
  await waitFor("quota_parked", () => kinds(feedLog).includes("quota_parked"), 30_000);
  await watcher.close();

  // Restart T3 while the thread waits for its reset; its port may change.
  await t3.stopServer();
  await sleep(1_000);
  await t3.startServer();
  await waitFor("the observer to resubscribe", () => observer.subscriptions() >= 2, 60_000);

  await waitFor("quota_resumed", () => kinds(feedLog).includes("quota_resumed"), 60_000);
  await sleep(7_000);
  await observer.stop();
  assert.deepEqual(kinds(feedLog), ["quota_parked", "quota_resumed"]);
  const resumed = readFeed(feedLog)[1]!;
  assert.equal(resumed.body.trigger, "auto_resume");
  assert.equal(turns(t3, "limited"), 1);
  assert.equal(turns(t3, "completed", true), 1);
  process.stdout.write(`# after a T3 restart: continuation ${resumed.body.latenessSeconds} s after reset\n`);
  assert.ok(Number(resumed.body.latenessSeconds) >= 0 && Number(resumed.body.latenessSeconds) <= MAX_LATENESS_SECONDS);
});
