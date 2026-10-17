// The long-running `chaldea quota observe` loop.
//
// Connects to local T3, follows the shell stream from the persisted cursor,
// feeds every event to the observer and hands new records to the feed poster.
// The pending payload and its claim are saved in the same atomic state write.
// While the state file cannot be written, new records wait. Connection failures, including T3 not running yet, back
// off and reconnect; there is no periodic scan. A refused protocol (HTTP 426) or data
// the pinned contracts reject stops the observer with exit status 78, which
// the systemd unit does not restart.
import { backoff, sleep } from "../retry.ts";
import { Outbox } from "../store/outbox.ts";
import { ConfigurationError, privateFile } from "../config/files.ts";
import { EXIT } from "../config/exit.ts";
export { ConfigurationError } from "../config/files.ts";

import { FeedPoster, MAX_QUEUED_RECORDS, quotaKey } from "../feed/poster.ts";
import type { Logger } from "../log.ts";
import {
  AbortedError,
  AuthenticationError,
  ProtocolIncompatibleError,
  connectShell,
  connectUsage,
  discoverServerUrl,
  switchPort,

  type ShellEvent,
  type ConnectOptions,
} from "../t3/adapter.ts";
import { HeadroomMonitor, routingLanes } from "./headroom.ts";
import { headroomConfig, type HeadroomConfig } from "./codex-balance.ts";
import { RestartRecoveryWorker } from "../t3/restart-worker.ts";
import { RestartJournal, restartConfig, type RestartConfig } from "../t3/restart.ts";
import { observe, type QuotaRecord } from "./observer.ts";
import { switchConfig, type SwitchConfig } from "./routing.ts";
import { ProviderSwitcher } from "./switcher.ts";
import { loadState, saveState, MAX_PENDING_BYTES, type ObserverState } from "./state.ts";

/** Exit status for a configuration or protocol problem a restart cannot fix (EX_CONFIG). */
export const EXIT_CONFIG = EXIT.config;

const CURSOR_SAVE_INTERVAL_MS = 5_000;
const BACKOFF_MS: ReadonlyArray<number> = [1_000, 2_000, 5_000, 10_000, 30_000, 60_000];
const AUTH_BACKOFF_MS = 120_000;

export interface ObserverOptions {
  readonly restart?: RestartConfig;
  readonly switching?: SwitchConfig;
  readonly reporting?: HeadroomConfig;
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

/** Compatibility name for callers; one descriptor-checked reader owns the policy. */
export const readToken = privateFile;

/** Advisory config failures cannot stop or reconnect the authoritative shell stream. */
async function followUsage(options: ConnectOptions & { signal: AbortSignal }, monitor: HeadroomMonitor, logger: Logger): Promise<void> {
  let attempt = 0;
  while (!options.signal.aborted) {
    try { await connectUsage(options, providers => monitor.update(providers)); }
    catch { /* Decode, auth and transport failures are all contained in this lane. */ }
    finally { monitor.inactive(); }
    if (options.signal.aborted) return;
    const delay = backoff(attempt++, { base: 1000, cap: 60_000, delays: BACKOFF_MS });
    logger.warn("T3 quota reporting unavailable; shell observation continues", { retryInMs: delay });
    await sleep(delay, options.signal);
  }
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
  readonly #outbox: Outbox<QuotaRecord>;
  readonly #discarded = new Set<string>();

  readonly state: ObserverState;
  readonly statePath: string;
  readonly poster: Pick<FeedPoster, "enqueue"> & Partial<Pick<FeedPoster, "discard">>;
  readonly logger: Logger;
  readonly retryDelaysMs: ReadonlyArray<number>;

  constructor(
    state: ObserverState,
    statePath: string,
    poster: Pick<FeedPoster, "enqueue"> & Partial<Pick<FeedPoster, "discard">>,
    logger: Logger,
    retryDelaysMs: ReadonlyArray<number> = BACKOFF_MS,
  ) {
    this.state = state;
    this.#outbox = new Outbox(state.pendingDelivery, "resend");
    this.statePath = statePath;
    this.poster = poster;
    this.logger = logger;
    this.retryDelaysMs = retryDelaysMs;
    this.#pending.push(...this.#outbox.values());
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
    // Superseded advisory payloads are removed only after the new state is durable.
    for (const key of this.#discarded) this.poster.discard?.(key);
    this.#discarded.clear();
    // Their claims are durable now.
    for (const record of this.#pending.splice(0)) {
      this.poster.enqueue(record, () => {
        this.#outbox.discard(quotaKey(record));
        this.save();
        return !this.dirty;
      });
    }
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return;
    const delay = backoff(this.#retryAttempt, { base: 1000, cap: 60_000, delays: this.retryDelaysMs,
      jitter: this.retryDelaysMs === BACKOFF_MS ? 0.5 : 0 });
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

  #discardHeadroom(key: string): void {
    this.#outbox.discard(key);
    const index = this.#pending.findIndex(r => quotaKey(r) === key);
    if (index >= 0) this.#pending.splice(index, 1);
    else this.#discarded.add(key); // Only already-enqueued keys need poster removal (bounded by its queue).
  }

  record(records: ReadonlyArray<QuotaRecord>): void {
    for (const record of records) {
      this.logger.info("quota record", { kind: record.kind, thread: record.threadId, run: record.runId, provider: record.provider, resetAt: record.resetAt });
      const key = quotaKey(record);
      if (this.#outbox.has(key)) continue;
      const advisory = this.#outbox.entries().filter(([, r]) => r.headroom !== undefined);
      if (record.headroom) {
        for (const [oldKey, old] of advisory) {
          if (old.kind === record.kind) this.#discardHeadroom(oldKey);
        }
      }
      // Advisory reporting never consumes capacity needed by a transition. Keep at most
      // 3 advisory intents (one host record per kind) and evict them first on either the count or byte bound.
      const overflow = () => this.#outbox.size >= MAX_QUEUED_RECORDS ||
        Buffer.byteLength(JSON.stringify([...this.#outbox.values(), record])) > MAX_PENDING_BYTES;
      const headroom = () => this.#outbox.entries().filter(([, r]) => r.headroom !== undefined);
      while (overflow() || record.headroom !== undefined && headroom().length >= 3) {
        const oldest = headroom()[0];
        if (!oldest) break;
        this.#discardHeadroom(oldest[0]);
      }
      if (overflow()) {
        this.state.deliveryDropped++;
        this.logger.error("pending record dropped: durable delivery queue capacity exceeded", { kind: record.kind, thread: record.threadId, run: record.runId });
        continue;
      }
      this.#outbox.enqueue(key, record);
      this.#pending.push(record);
    }
  }

  /** Final save; unsaved records are reported, durable delivery intents remain. */
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
  const restart = options.restart ?? restartConfig();
  let journal: RestartJournal | undefined;
  try { journal = new RestartJournal(restart.journalPath); }
  catch { logger.warn("restart journal unavailable; quota observation continues without restart recovery"); }
  const state = loadState(options.statePath, Date.now());
  const poster = new FeedPoster({ command: options.feedCommand, host: options.host, logger });
  const restarts = journal ? new RestartRecoveryWorker({ ...options, config: restart }, journal, poster) : undefined;
  const sink = new EventSink(state, options.statePath, poster, logger);
  sink.save(); // Recover durable pending payloads even when T3 is offline.
  logger.info("quota observer starting", { cursor: state.cursor, parked: state.parked.size, posted: state.posted.size });

  let monitor: HeadroomMonitor | undefined;
  let switcher: ProviderSwitcher | undefined;
  let previousToken: string | undefined;
  let attempt = 0;
  let exitCode = 0;
  while (!signal.aborted) {
    let connected = false;
    let delay = backoff(attempt, { base: 1000, cap: 60_000, delays: BACKOFF_MS });
    try {
      const token = readToken(options.tokenFile);
      const serverUrl = options.serverUrl ?? discoverServerUrl(options.t3BaseDir);
      if (serverUrl === null) throw new Error("T3 is not running (no server-runtime.json)");
      const connection = new AbortController();
      const connectionSignal = AbortSignal.any([signal, connection.signal]);
      const rawPort = switchPort({ serverUrl, token, signal: connectionSignal });
      const local = ["127.0.0.1", "[::1]", "localhost"].includes(new URL(serverUrl).hostname);
      monitor ??= new HeadroomMonitor({
        state: state.headroom, config: options.reporting ?? headroomConfig(), local,
        diagnostic: detail => logger.info("Codex balance collector", detail),
        save: records => { sink.record(records); sink.save(); },
      });
      monitor.options.local = local;
      monitor.start();
      const port = { ...rawPort, catalog: async () => {
        const catalog = await rawPort.catalog();
        return { ...catalog, providers: catalog.providers.map(p => {
          const row = state.headroom.providers.find(r => r.alias === p.instanceId);
          return { ...p, ...(row ? { headroom: routingLanes(row, Date.now()) } : {}) };
        }) };
      } };
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
        if (event.kind === "synchronized" || event.kind === "thread") restarts?.kick();
      };
      const usage = followUsage({ serverUrl, token, signal: connectionSignal }, monitor, logger);
      const shell = connectShell(
        { serverUrl, token, signal: connectionSignal },
        // Switching needs current parked threads after catch-up, including on restarts.
        state.cursor === null || options.switching?.enabled || state.switches.size > 0 ? { onEvent } : { afterSequence: state.cursor, onEvent },
      );
      try {
        await shell;
      } finally {
        monitor.inactive();
        connection.abort();
        await Promise.allSettled([usage, shell]);
      }
      logger.warn("T3 ended the shell stream; reconnecting");
      delay = backoff(0, { base: 1000, cap: 60_000, delays: BACKOFF_MS });
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
  await monitor?.close();
  await restarts?.close();
  await switcher?.close();
  sink.close();
  await Promise.race([poster.idle(), new Promise((r) => setTimeout(r, 30_000).unref())]);
  poster.close();
  journal?.close();
  logger.info("quota observer stopped", { exitCode });
  return exitCode;
}
