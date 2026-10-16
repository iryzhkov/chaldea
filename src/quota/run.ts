// The long-running `chaldea quota observe` loop.
//
// Connects to local T3, follows the shell stream from the persisted cursor,
// feeds every event to the observer and hands new records to the feed poster.
// A record's key is saved to disk before the record is queued, so a crash can
// lose a record but never repeat one. Connection failures back off and
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
import { loadState, saveState } from "./state.ts";

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

class ConfigurationError extends Error {}

/** Reads the bearer from a private file; refuses files other users can read. */
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

export async function runObserver(options: ObserverOptions): Promise<number> {
  const { logger, signal } = options;
  const state = loadState(options.statePath, Date.now());
  const poster = new FeedPoster({ command: options.feedCommand, host: options.host, logger });
  let lastSave = 0;
  const save = () => {
    saveState(options.statePath, state, Date.now());
    lastSave = Date.now();
  };
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
        const records = observe(state, event, Date.now());
        if (records.length > 0 || event.kind === "synchronized" || Date.now() - lastSave > CURSOR_SAVE_INTERVAL_MS) save();
        for (const record of records) {
          logger.info("quota record", { kind: record.kind, thread: record.threadId, run: record.runId, provider: record.provider, resetAt: record.resetAt });
          poster.enqueue(record);
        }
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
  save();
  await Promise.race([poster.idle(), new Promise((r) => setTimeout(r, 30_000).unref())]);
  logger.info("quota observer stopped", { exitCode });
  return exitCode;
}
