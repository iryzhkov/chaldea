// The long-running `chaldea quota observe` loop.
//
// Connects to local T3, follows the shell stream from the persisted cursor,
// feeds every event to the observer and hands new records to the feed poster.
// A record's key is saved to disk before the record is queued, so a crash can
// lose a record but never repeat one; while the state file cannot be written,
// new records wait. Connection failures, including T3 not running yet, back
// off and reconnect; there is no periodic scan. A refused protocol (HTTP 426) or data
// the pinned contracts reject stops the observer with exit status 78, which
// the systemd unit does not restart.
import { existsSync, statSync, readFileSync } from "node:fs";

import { FeedPoster, MAX_QUEUED_RECORDS } from "../feed/poster.ts";
import type { Logger } from "../log.ts";
import {
  AbortedError,
  AuthenticationError,
  ProtocolIncompatibleError,
  connectShell,
  discoverServerUrl,
  switchPort,

  type ShellEvent,
} from "../t3/adapter.ts";
import { observe, type QuotaRecord } from "./observer.ts";
import { switchConfig, type SwitchConfig } from "./routing.ts";
import { ProviderSwitcher } from "./switcher.ts";
import { loadState, saveState, type ObserverState } from "./state.ts";

/** Exit status for a configuration or protocol problem a restart cannot fix (EX_CONFIG). */
export const EXIT_CONFIG = 78;

const CURSOR_SAVE_INTERVAL_MS = 5_000;
const BACKOFF_MS: ReadonlyArray<number> = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const AUTH_BACKOFF_MS = 120_000;

export interface ObserverOptions {
  readonly switching?: SwitchConfig;
  /** Explicit T3 URL; otherwise discovered from `t3BaseDir`. */
  readonly serverUrl?: string;
  readonly t3BaseDir: string;
  readonly tokenFile: string;
  readonly statePath: string;
  readonly feedCommand: string;
  readonly host: string;
  readonly logger: Logger;
  readonly signal: AbortSignal;
}

export class ConfigurationError extends Error {}

/** Reads a bearer from a private file; refuses files other users can read. */
export function readToken(path: string): string {
  if (!existsSync(path)) throw new ConfigurationError(`token file ${path} does not exist`);
  const stat = statSync(path);
  if ((stat.mode & 0o077) !== 0) throw new ConfigurationError(`token file ${path} must not be readable by group or others (chmod 600)`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new ConfigurationError(`token file ${path} must be owned by the observer's user`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (token === "") throw new ConfigurationError(`token file ${path} is empty`);
  return token;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Applies shell events to the observer state, persists it, and queues new
 * records for the feed only once their claims are on disk. Saving never
 * throws: a failed write leaves the state dirty, holds new records back as
 * pending, and is retried on the next event and on one backoff timer that
 * exists only while the state is dirty. A crash during the outage loses the
 * pending records' claims with them, so a restart reports them once; it can
 * never post a record whose claim was not durable.
 */
export class EventSink {
  #lastSave = 0;
  #dirty = false;
  #saveFailing = false;
  #retryTimer: NodeJS.Timeout | null = null;
  #retryAttempt = 0;
  readonly #pending: Array<QuotaRecord> = [];

  readonly state: ObserverState;
  readonly statePath: string;
  readonly poster: Pick<FeedPoster, "enqueue">;
  readonly logger: Logger;
  readonly retryDelaysMs: ReadonlyArray<number>;

  constructor(
    state: ObserverState,
    statePath: string,
    poster: Pick<FeedPoster, "enqueue">,
    logger: Logger,
    retryDelaysMs: ReadonlyArray<number> = BACKOFF_MS,
  ) {
    this.state = state;
    this.statePath = statePath;
    this.poster = poster;
    this.logger = logger;
    this.retryDelaysMs = retryDelaysMs;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  get pending(): number {
    return this.#pending.length;
  }

  save(): void {
    try {
      saveState(this.statePath, this.state, Date.now());
    } catch (error) {
      this.#dirty = true;
      // Logged once per outage, not once per event.
      if (!this.#saveFailing) {
        this.#saveFailing = true;
        this.logger.error("state file write failed; holding new records until it can be written", {
          path: this.statePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.#scheduleRetry();
      return;
    }
    this.#lastSave = Date.now();
    this.#dirty = false;
    this.#retryAttempt = 0;
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#saveFailing) {
      this.#saveFailing = false;
      this.logger.info("state file written again", { path: this.statePath, pending: this.#pending.length });
    }
    // Their claims are durable now.
    for (const record of this.#pending.splice(0)) this.poster.enqueue(record);
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return;
    const delay = this.retryDelaysMs[Math.min(this.#retryAttempt, this.retryDelaysMs.length - 1)]!;
    this.#retryAttempt += 1;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.save();
    }, delay);
    this.#retryTimer.unref();
  }

  handle(event: ShellEvent): void {
    const records = observe(this.state, event, Date.now());
    this.record(records);
    if (records.length > 0 || this.#dirty || event.kind === "synchronized" || Date.now() - this.#lastSave > CURSOR_SAVE_INTERVAL_MS) {
      this.save();
    }
  }

  record(records: ReadonlyArray<QuotaRecord>): void {
    for (const record of records) {
      this.logger.info("quota record", { kind: record.kind, thread: record.threadId, run: record.runId, provider: record.provider, resetAt: record.resetAt });
      if (this.#pending.length >= MAX_QUEUED_RECORDS) {
        this.logger.error("pending record dropped: the state file has been unwritable too long", { kind: record.kind, thread: record.threadId, run: record.runId });
        continue;
      }
      this.#pending.push(record);
    }
  }

  /** Final save at shutdown; records still pending are dropped with an error. */
  close(): void {
    this.save();
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#pending.length > 0) {
      this.logger.error("records not posted: their claims could not be saved before shutdown", { count: this.#pending.length });
      this.#pending.length = 0;
    }
  }
}

/** Optional switch work cannot delay records or escape into the shell stream. */
export function processObserverEvent(
  sink: EventSink,
  switcher: Pick<ProviderSwitcher, "handle" | "fail">,
  event: ShellEvent,
): void {
  sink.handle(event);
  const fallback = (error: unknown) => {
    void switcher.fail(error).catch(() => sink.logger.error("switch cleanup failed; observing continues"));
  };
  try { void switcher.handle(event).catch(fallback); } catch (error) { fallback(error); }
}

export async function runObserver(options: ObserverOptions): Promise<number> {
  const { logger, signal } = options;
  const state = loadState(options.statePath, Date.now());
  const poster = new FeedPoster({ command: options.feedCommand, host: options.host, logger });
  const sink = new EventSink(state, options.statePath, poster, logger);
  logger.info("quota observer starting", { cursor: state.cursor, parked: state.parked.size, posted: state.posted.size });

  let switcher: ProviderSwitcher | undefined;
  let previousToken: string | undefined;
  let attempt = 0;
  let exitCode = 0;
  while (!signal.aborted) {
    let connected = false;
    let delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    try {
      const token = readToken(options.tokenFile);
      const serverUrl = options.serverUrl ?? discoverServerUrl(options.t3BaseDir);
      if (serverUrl === null) throw new Error("T3 is not running (no server-runtime.json)");
      const port = switchPort({ serverUrl, token, signal });
      if (switcher === undefined) {
        switcher = new ProviderSwitcher({
          state, port, config: options.switching ?? switchConfig(), logger,
          save: () => { sink.save(); return !sink.dirty; },
          record: (record) => sink.record([record]),
          onReconciled: (thread) => sink.handle({ kind: "thread", sequence: state.cursor ?? 0, thread }),
        });
      }
      switcher.reconnect(port, previousToken !== token);
      previousToken = token;
      const onEvent = async (event: ShellEvent) => {
        if (!connected) {
          connected = true;
          attempt = 0;
          logger.info("subscribed to T3 shell", { afterSequence: state.cursor });
        }
        processObserverEvent(sink, switcher!, event);
      };
      await connectShell(
        { serverUrl, token, signal },
        // Switching needs current parked threads after catch-up, including on restarts.
        state.cursor === null || options.switching?.enabled || state.switches.size > 0 ? { onEvent } : { afterSequence: state.cursor, onEvent },
      );
      logger.warn("T3 ended the shell stream; reconnecting");
      delay = BACKOFF_MS[0]!;
    } catch (error) {
      if (error instanceof AbortedError || signal.aborted) break;
      if (error instanceof ProtocolIncompatibleError || error instanceof ConfigurationError) {
        logger.error("quota observer stopping: fail closed", { error: error.message });
        exitCode = EXIT_CONFIG;
        break;
      }
      if (error instanceof AuthenticationError) delay = AUTH_BACKOFF_MS;
      logger.warn("T3 connection failed", { error: error instanceof Error ? error.message : String(error), retryInMs: delay });
    }
    if (!connected) attempt += 1;
    await sleep(delay, signal);
  }
  // close() never throws, so a failed final write cannot change the exit status or skip the drain.
  await switcher?.close();
  sink.close();
  await Promise.race([poster.idle(), new Promise((r) => setTimeout(r, 30_000).unref())]);
  logger.info("quota observer stopped", { exitCode });
  return exitCode;
}
