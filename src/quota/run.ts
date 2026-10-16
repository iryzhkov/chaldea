// The long-running `chaldea quota observe` loop.
//
// Connects to local T3, follows the shell stream from the persisted cursor,
// feeds every event to the observer and hands new records to the feed poster.
// A record's key is saved to disk before the record is queued, so a crash can
// lose a record but never repeat one (unless the state file cannot be written,
// which is logged as an error). Connection failures back off and
// reconnect; there is no periodic scan. A refused protocol (HTTP 426) or data
// the pinned contracts reject stops the observer with exit status 78, which
// the systemd unit does not restart.
import { existsSync, statSync, readFileSync } from "node:fs";

import { FeedPoster } from "../feed/poster.ts";
import type { Logger } from "../log.ts";
import {
  AbortedError,
  AuthenticationError,
  ProtocolIncompatibleError,
  connectShell,
  discoverServerUrl,
  type ShellEvent,
} from "../t3/adapter.ts";
import { observe } from "./observer.ts";
import { loadState, saveState, type ObserverState } from "./state.ts";

/** Exit status for a configuration or protocol problem a restart cannot fix (EX_CONFIG). */
export const EXIT_CONFIG = 78;

const CURSOR_SAVE_INTERVAL_MS = 5_000;
const BACKOFF_MS: ReadonlyArray<number> = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const AUTH_BACKOFF_MS = 120_000;

export interface ObserverOptions {
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
 * records. Saving never throws: a failed write leaves the state dirty and the
 * next event retries it, while records are still queued, so a broken disk
 * costs at-most-once delivery only if the process also crashes meanwhile.
 */
export class EventSink {
  #lastSave = 0;
  #dirty = false;
  #saveFailing = false;

  readonly state: ObserverState;
  readonly statePath: string;
  readonly poster: Pick<FeedPoster, "enqueue">;
  readonly logger: Logger;

  constructor(state: ObserverState, statePath: string, poster: Pick<FeedPoster, "enqueue">, logger: Logger) {
    this.state = state;
    this.statePath = statePath;
    this.poster = poster;
    this.logger = logger;
  }

  get dirty(): boolean {
    return this.#dirty;
  }

  save(): void {
    try {
      saveState(this.statePath, this.state, Date.now());
      this.#lastSave = Date.now();
      this.#dirty = false;
      if (this.#saveFailing) {
        this.#saveFailing = false;
        this.logger.info("state file written again", { path: this.statePath });
      }
    } catch (error) {
      this.#dirty = true;
      // Logged once per outage, not once per event.
      if (!this.#saveFailing) {
        this.#saveFailing = true;
        this.logger.error("state file write failed; records are still posted but could repeat after a crash", {
          path: this.statePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  handle(event: ShellEvent): void {
    const records = observe(this.state, event, Date.now());
    if (records.length > 0 || this.#dirty || event.kind === "synchronized" || Date.now() - this.#lastSave > CURSOR_SAVE_INTERVAL_MS) {
      this.save();
    }
    for (const record of records) {
      this.logger.info("quota record", { kind: record.kind, thread: record.threadId, run: record.runId, provider: record.provider, resetAt: record.resetAt });
      this.poster.enqueue(record);
    }
  }
}

export async function runObserver(options: ObserverOptions): Promise<number> {
  const { logger, signal } = options;
  const state = loadState(options.statePath, Date.now());
  const poster = new FeedPoster({ command: options.feedCommand, host: options.host, logger });
  const sink = new EventSink(state, options.statePath, poster, logger);
  logger.info("quota observer starting", { cursor: state.cursor, parked: state.parked.size, posted: state.posted.size });

  let attempt = 0;
  let exitCode = 0;
  while (!signal.aborted) {
    let connected = false;
    let delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
    try {
      const token = readToken(options.tokenFile);
      const serverUrl = options.serverUrl ?? discoverServerUrl(options.t3BaseDir);
      if (serverUrl === null) throw new Error("T3 is not running (no server-runtime.json)");
      const onEvent = (event: ShellEvent) => {
        if (!connected) {
          connected = true;
          attempt = 0;
          logger.info("subscribed to T3 shell", { afterSequence: state.cursor });
        }
        sink.handle(event);
      };
      await connectShell(
        { serverUrl, token, signal },
        state.cursor === null ? { onEvent } : { afterSequence: state.cursor, onEvent },
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
  // save() never throws, so a failed final write cannot change the exit status or skip the drain.
  sink.save();
  await Promise.race([poster.idle(), new Promise((r) => setTimeout(r, 30_000).unref())]);
  logger.info("quota observer stopped", { exitCode });
  return exitCode;
}
