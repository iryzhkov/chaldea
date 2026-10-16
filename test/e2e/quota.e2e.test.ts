// End-to-end: the real pinned t3 (v0.1.0) with a fake Claude CLI, T3's native
// auto-resume, and `chaldea quota observe` as a child process writing to a
// feed recorder. Fixtures live under the scratch directory and are removed
// whether a test passes or fails. Skipped when the pinned t3 is not installed.
import assert from "node:assert/strict";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";

import { startDisposableT3, t3Version, type DisposableT3 } from "../helpers/disposable-t3.ts";
import {
  ObserverProcess,
  ShellWatcher,
  dispatchMessage,
  readAutoResumeSetting,
  readFeed,
  sleep,
  updateAutoResumeSetting,
  waitFor,
  writePrivateFile,
} from "../helpers/e2e.ts";
import { SCRATCH_ROOT, scratchDir } from "../helpers/scratch.ts";

const PINNED_VERSION = "t3 v0.1.0";
const version = t3Version();
const skip = version === PINNED_VERSION ? false : `needs ${PINNED_VERSION}, found ${version ?? "none"}`;

/** T3's due-work sweep runs every five seconds; allow for the tick itself. */
const MAX_LATENESS_SECONDS = 6.5;

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

test("enabling autoResumeLimitedThreads in settings.json takes effect without a restart", { skip, timeout: 120_000 }, async () => {
  const h = await harness({ scenario: "reset", autoResume: false, resetDelaySeconds: 12 });
  assert.equal(await readAutoResumeSetting(h.t3, h.operateToken), false);
  await dispatchMessage(h.t3, h.operateToken, h.threadId, `Start the work. ${h.t3.trigger}`, "1");
  const stopped = await waitFor("the usage-limit stop", () => {
    const thread = h.watcher.threads.get(h.threadId);
    return thread?.lastErrorClass === "usage_limit" ? thread : null;
  }, 30_000);
  const resetMs = Date.parse(stopped.usageLimitResetAt!);
  // With the setting off, a sweep passes without arming recovery.
  await sleep(6_000);
  assert.equal(h.watcher.threads.get(h.threadId)?.limitRecovery, null);

  // The documented procedure: rewrite settings.json atomically beside the original.
  const settings = JSON.parse(readFileSync(h.t3.settingsPath, "utf8"));
  writeFileSync(`${h.t3.settingsPath}.chaldea-tmp`, JSON.stringify({ ...settings, autoResumeLimitedThreads: true }, null, 2));
  renameSync(`${h.t3.settingsPath}.chaldea-tmp`, h.t3.settingsPath);

  await waitFor("the continuation run", () => (h.watcher.runs.get(h.threadId)?.size ?? 0) >= 2, 30_000);
  assert.equal(await readAutoResumeSetting(h.t3, h.operateToken), true);
  const runs = [...h.watcher.runs.get(h.threadId)!];
  const lateness = (Date.parse(h.watcher.runStarts.get(runs[1]!)!) - resetMs) / 1000;
  process.stdout.write(`# settings.json hot reload: continuation ${lateness.toFixed(3)} s after reset\n`);
  assert.ok(lateness >= 0 && lateness <= MAX_LATENESS_SECONDS, `lateness ${lateness}`);
  assert.equal(turns(h.t3, "completed", true), 1);

  // The public RPC path writes the same key through T3's own persistence,
  // which leaves default-valued keys (false) out of the file.
  const persisted = () => JSON.parse(readFileSync(h.t3.settingsPath, "utf8")).autoResumeLimitedThreads;
  await updateAutoResumeSetting(h.t3, h.operateToken, false);
  assert.equal(await readAutoResumeSetting(h.t3, h.operateToken), false);
  assert.notEqual(persisted(), true);
  await updateAutoResumeSetting(h.t3, h.operateToken, true);
  assert.equal(await readAutoResumeSetting(h.t3, h.operateToken), true);
  assert.equal(persisted(), true);
});
