// Planned restart journal. FULL SQLite commits survive the process being killed
// by the very restart it requested. No access to T3's private database.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, watch } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDb, tx, migrate } from "../store/sqlite.ts";
import { homedir } from "node:os";
import { FeedPoster } from "../feed/poster.ts";
import type { Logger } from "../log.ts";
import { readToken } from "../quota/run.ts";
import { AuthenticationError, ProtocolIncompatibleError, discoverServerUrl,
  switchPort, type ConnectOptions, type ShellThread } from "./adapter.ts";
import { dispatchRestart } from "./restart-dispatch.ts";
import { restartPayload, restartProjection, restartSnapshot } from "./restart-port.ts";

export interface RestartConfig {
  enabled: boolean;
  command: string[];
  timeoutMs: number;
  journalPath: string;
}
export function restartConfig(path?: string): RestartConfig {
  const value = path === undefined ? {} : JSON.parse(readFileSync(path, "utf8"));
  const config = {
    enabled: value.enabled ?? true,
    command: value.command ?? ["systemctl", "--user", "restart", "t3code.service"],
    timeoutMs: value.timeoutMs ?? 90_000,
    journalPath: value.journalPath ?? join(homedir(), ".local/state/chaldea/t3-restarts.sqlite"),
  };
  if (typeof config.enabled !== "boolean" || !Array.isArray(config.command) ||
      config.command.length === 0 || !config.command.every((s: unknown) => typeof s === "string" && s.length > 0) ||
      !Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 300_000 ||
      typeof config.journalPath !== "string") throw new Error("Invalid restart configuration");
  return config;
}

export function runtimeEpoch(baseDir: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(join(baseDir, "userdata/server-runtime.json"))).digest("hex");
  } catch { return null; }
}

interface Intent {
  thread: string; run: string; epoch: string; payload: string;
  provider: string; model: string; subagent: number; phase: string; retry_at: number;
  invocation: string; captured_at: number; expires_at: number;
}
export class RestartJournal {
  readonly db: DatabaseSync;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDb(path);
    try {
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;");
    migrate(this.db, [() => {
    this.db.exec(`CREATE TABLE IF NOT EXISTS restarts (
        scope TEXT NOT NULL, thread TEXT NOT NULL, run TEXT NOT NULL, epoch TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, subagent INTEGER NOT NULL,
        payload TEXT NOT NULL, phase TEXT NOT NULL DEFAULT 'captured', posted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(scope, thread, run));`);
      const columns = this.db.prepare("PRAGMA table_info(restarts)").all().map(c => c.name);
      for (const [name, type] of [["invocation", "TEXT"], ["recovery_epoch", "TEXT"],
        ["retry_at", "INTEGER NOT NULL DEFAULT 0"], ["captured_at", "INTEGER NOT NULL DEFAULT 0"], ["expires_at", "INTEGER NOT NULL DEFAULT 0"]])
        if (!columns.includes(name!)) this.db.exec(`ALTER TABLE restarts ADD COLUMN ${name} ${type}`);
    }]);
    } catch (error) { this.db.close(); throw error; }
  }
  transaction(write: () => void): void {
    tx(this.db, write);
  }
  abortInvocation(invocation: string): void {
    this.db.prepare("UPDATE restarts SET phase = 'aborted', retry_at = 0 WHERE invocation = ? AND phase IN ('captured', 'dispatching')")
      .run(invocation);
  }
  pinEpoch(baseDir: string, intent: Intent, epoch: string): boolean {
    this.db.prepare("UPDATE restarts SET recovery_epoch = COALESCE(recovery_epoch, ?) WHERE scope = ? AND thread = ? AND run = ?")
      .run(epoch, resolve(baseDir), intent.thread, intent.run);
    return this.db.prepare("SELECT recovery_epoch FROM restarts WHERE scope = ? AND thread = ? AND run = ?")
      .get(resolve(baseDir), intent.thread, intent.run)?.recovery_epoch === epoch;
  }
  retry(baseDir: string, intent: Intent, milliseconds: number): void {
    this.db.prepare("UPDATE restarts SET retry_at = ? WHERE scope = ? AND thread = ? AND run = ?")
      .run(Date.now() + milliseconds, resolve(baseDir), intent.thread, intent.run);
  }
  nextRetry(baseDir: string): number | null {
    const row = this.db.prepare("SELECT MIN(retry_at) AS next FROM restarts WHERE scope = ? AND phase IN ('captured', 'dispatching') AND retry_at > 0")
      .get(resolve(baseDir));
    return typeof row?.next === "number" ? row.next : null;
  }
  capture(baseDir: string, epoch: string, thread: ShellThread, run: string, payload: string, provider: string, model: string, invocation: string, timeoutMs: number): void {
    this.db.prepare(`INSERT INTO restarts
      (scope, thread, run, epoch, provider, model, subagent, payload, invocation, captured_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope, thread, run) DO UPDATE SET epoch = excluded.epoch,
        invocation = excluded.invocation, phase = 'captured', recovery_epoch = NULL, retry_at = 0,
        captured_at = excluded.captured_at, expires_at = excluded.expires_at
      WHERE restarts.phase = 'aborted'`)
      .run(resolve(baseDir), thread.id, run, epoch, provider, model, Number(thread.relationshipToParent === "subagent"), payload, invocation, Date.now(), Date.now() + timeoutMs + 10_000);
  }
  entries(baseDir: string): Intent[] {
    return this.db.prepare("SELECT * FROM restarts WHERE scope = ? AND (phase NOT IN ('skipped', 'aborted') AND (phase != 'resumed' OR posted = 0))")
      .all(resolve(baseDir)) as unknown as Intent[];
  }
  phase(baseDir: string, intent: Intent, phase: string): void {
    this.db.prepare("UPDATE restarts SET phase = ?, retry_at = 0 WHERE scope = ? AND thread = ? AND run = ?")
      .run(phase, resolve(baseDir), intent.thread, intent.run);
  }
  claimLegacyFeed(baseDir: string, intent: Intent): boolean {
    // Legacy feed has no durable receipt protocol. Match its existing single
    // attempt semantics; claim atomically before any process can invoke it.
    return this.db.prepare("UPDATE restarts SET posted = 2 WHERE scope = ? AND thread = ? AND run = ? AND posted = 0")
      .run(resolve(baseDir), intent.thread, intent.run).changes === 1;
  }
  posted(baseDir: string, intent: Intent): void {
    this.db.prepare("UPDATE restarts SET posted = 1 WHERE scope = ? AND thread = ? AND run = ?")
      .run(resolve(baseDir), intent.thread, intent.run);
  }
  close(): void { this.db.close(); }
}

export interface RestartOptions {
  t3BaseDir: string;
  serverUrl?: string;
  tokenFile: string;
  feedCommand?: string;
  config: RestartConfig;
  logger: Logger;
}
function connection(options: RestartOptions): ConnectOptions {
  const serverUrl = options.serverUrl ?? discoverServerUrl(options.t3BaseDir);
  if (serverUrl === null) throw new Error("T3 is not running");
  return { serverUrl, token: readToken(options.tokenFile), signal: AbortSignal.timeout(10_000) };
}
function excluded(thread: ShellThread): boolean {
  return thread.archived || thread.deleted || thread.settled === true || thread.pendingRequest === true;
}

/** Capture only fresh projections of live turns, before touching the service. */
export async function captureRestart(options: RestartOptions, journal: RestartJournal): Promise<string | undefined> {
  if (!options.config.enabled) return;
  const epoch = runtimeEpoch(options.t3BaseDir);
  if (epoch === null) throw new Error("T3 runtime identity is required before a planned restart");
  const port = connection(options);
  const invocation = randomUUID(), captures: Array<() => void> = [];
  for (const thread of await restartSnapshot(port)) {
    if (excluded(thread) || !thread.activeRunId) continue;
    const p = await restartProjection(port, thread.id);
    if (!p) throw new Error("Capture projection unavailable; restart refused");
    if (!p.run || excluded(p.thread) || p.blocked || p.waitingForUser || p.interrupted ||
        p.thread.latestRunId !== p.run.id || p.thread.activeRunId !== p.run.id ||
        !["running", "starting", "preparing", "waiting"].includes(p.run.status)) continue;
    const run = p.run;
    captures.push(() => journal.capture(options.t3BaseDir, epoch, p.thread, run.id,
      restartPayload(thread.id, run.id, run.modelSelection),
      run.providerInstanceId, run.modelSelection.model, invocation, options.config.timeoutMs));
  }
  journal.transaction(() => { for (const capture of captures) capture(); });
  return invocation;
}

/** Also called after observer reconnect: replay immutable bytes, never a new ID. */
export async function recoverPlannedRestarts(options: RestartOptions, journal: RestartJournal, poster: Pick<FeedPoster, "enqueue">): Promise<void> {
  if (!options.config.enabled) {
    for (const intent of journal.entries(options.t3BaseDir)) journal.phase(options.t3BaseDir, intent, "skipped");
    return;
  }
  const epoch = runtimeEpoch(options.t3BaseDir);
  if (epoch === null) return;
  for (const intent of journal.entries(options.t3BaseDir)) {
    try {
      if (intent.phase !== "resumed") {
        // An absent observer must never revive a long-abandoned cancelled turn.
        // Old journal versions without a deadline also fail closed.
        if (!(intent.captured_at > 0) || Date.now() > intent.expires_at) {
          journal.phase(options.t3BaseDir, intent, "skipped"); continue;
        }
        if (epoch === intent.epoch) continue;
        if (!journal.pinEpoch(options.t3BaseDir, intent, epoch)) {
          journal.phase(options.t3BaseDir, intent, "skipped"); continue;
        }
        if (intent.retry_at > Date.now()) continue;
        const port = connection(options);
        const p = await restartProjection(port, intent.thread, intent.run);
        if (p?.continued) {
          journal.phase(options.t3BaseDir, intent, "resumed");
        } else if (p?.run && ["preparing", "starting", "running", "waiting"].includes(p.run.status) &&
            p.thread.latestRunId === intent.run && !excluded(p.thread) && !p.blocked && !p.waitingForUser && !p.interrupted) {
          journal.retry(options.t3BaseDir, intent, 500); continue;
        } else if (!p?.run || excluded(p.thread) || p.blocked || p.waitingForUser || p.interrupted ||
            p.run.status !== "cancelled" || p.thread.latestRunId !== intent.run ||
            p.thread.activeRunId !== null || p.thread.lastErrorClass !== null ||
            p.thread.providerInstanceId !== intent.provider) {
          journal.phase(options.t3BaseDir, intent, "skipped");
          continue;
        } else {
          // Persist dispatch intent before any network write. An ambiguous result
          // leaves these exact bytes available for observer/startup replay.
          const catalog = await switchPort(port).catalog();
          const provider = catalog.providers.find(p => p.instanceId === intent.provider);
          if (!provider || !provider.enabled || !provider.installed) {
            journal.phase(options.t3BaseDir, intent, "skipped"); continue;
          }
          journal.phase(options.t3BaseDir, intent, "dispatching");
          await dispatchRestart(port, intent.payload);
          const after = await restartProjection(port, intent.thread, intent.run);
          // Dispatch can be an accepted no-op when Stop wins server serialization.
          if (!after?.continued) {
            journal.phase(options.t3BaseDir, intent, "skipped");
            continue;
          }
          journal.phase(options.t3BaseDir, intent, "resumed");
        }
      }
      if (process.env.AKASHA_URL === undefined && process.env.AKASHA_TOKEN_HELPER === undefined &&
          !journal.claimLegacyFeed(options.t3BaseDir, intent)) continue;
      poster.enqueue({
        kind: "restart_resumed", severity: "info", threadId: intent.thread,
        runId: intent.run, provider: intent.provider, fromModel: intent.model,
        resetAt: null, subagent: intent.subagent === 1,
      }, () => { journal.posted(options.t3BaseDir, intent); return true; });
    } catch (error) {
      journal.retry(options.t3BaseDir, intent, error instanceof AuthenticationError ? 120_000 : 5_000);
      options.logger.warn("planned restart continuation deferred", {
        thread: intent.thread, run: intent.run,
        reason: error instanceof AuthenticationError ? "credential_scope" : "connection_or_storage",
      });
    }
  }
}

async function runCommand(command: string[], timeoutMs: number): Promise<void> {
  await new Promise<void>((resolveCommand, reject) => {
    const child = spawn(command[0]!, command.slice(1), { stdio: "inherit", timeout: timeoutMs });
    child.once("error", reject);
    child.once("close", (code, signal) => code === 0 ? resolveCommand() :
      reject(new Error(`T3 restart command failed (${signal ?? code})`)));
  });
}

/** Filesystem notifications speed readiness; bounded RPC retries cover missed events. */
export async function waitForRestart(options: RestartOptions, oldEpoch: string | null): Promise<void> {
  const deadline = Date.now() + options.config.timeoutMs;
  while (Date.now() < deadline) {
    if (runtimeEpoch(options.t3BaseDir) !== null && runtimeEpoch(options.t3BaseDir) !== oldEpoch) {
      try { await restartSnapshot(connection(options)); return; }
      catch (error) {
        if (error instanceof AuthenticationError || error instanceof ProtocolIncompatibleError) throw error;
      }
    }
    await new Promise<void>(done => {
      let watcher: ReturnType<typeof watch> | undefined;
      const timer = setTimeout(finish, Math.min(500, Math.max(1, deadline - Date.now())));
      function finish() { clearTimeout(timer); watcher?.close(); done(); }
      try { watcher = watch(join(options.t3BaseDir, "userdata"), finish); }
      catch { /* Timed retry also covers a missing runtime directory. */ }
    });
  }
  throw new Error("T3 did not become ready after restart; durable continuations remain for the observer");
}

export async function restartT3(options: RestartOptions): Promise<void> {
  const journal = new RestartJournal(options.config.journalPath);
  const poster = new FeedPoster({ command: options.feedCommand ?? "feed", host: (await import("../feed/poster.ts")).shortHostname(), logger: options.logger });
  let invocation: string | undefined;
  const epoch = runtimeEpoch(options.t3BaseDir);
  try {
    invocation = await captureRestart(options, journal);
    await runCommand(options.config.command, options.config.timeoutMs);
    await waitForRestart(options, epoch);
    await recoverPlannedRestarts(options, journal, poster);
    await poster.idle();
    if (journal.entries(options.t3BaseDir).some(intent => intent.invocation === invocation && intent.phase !== "resumed"))
      throw new Error("Planned continuations remain pending; the observer will retry without interrupting quota observation");
  } catch (error) {
    if (invocation && runtimeEpoch(options.t3BaseDir) === epoch) journal.abortInvocation(invocation);
    throw error;
  } finally { poster.close(); journal.close(); }
}
