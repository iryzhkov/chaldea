// Durable observer state: the shell cursor, the keys of records already
// posted, and the threads currently parked on a usage limit.
//
// One small JSON file, written atomically (temporary file, fsync, rename,
// fsync of the directory) with mode 0600. Retention is enforced on every save:
// posted keys expire 42 days after the stop they describe and parked threads
// 42 days after they were seen; each map is capped, oldest first, so the file
// stays bounded. Pending delivery adds at most 4 MiB of immutable records;
// the whole state is limited to 8 MiB, plus one atomic temporary file.
//
// Evicting a key must never let its record be posted again. Every eviction
// raises `evictedThrough` to the stop time of the evicted key, and stops at or
// before that time are never reported. Eviction therefore errs towards losing
// a record, never towards repeating one.
import { statSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import type { QuotaRecord } from "./observer.ts";
import { emptyHeadroom, validateHeadroom, type HeadroomState } from "./headroom.ts";
import type { SwitchIntent } from "./switcher.ts";
export const MAX_ACTIVE_SWITCHES = 128;
export const MAX_COMPLETED_SWITCHES = 1_000;

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Posted-record keys and parked threads are forgotten after this long. */
export const KEY_TTL_MS = 42 * DAY_MS;
/** Stops older than this are never reported, so expired keys cannot revive old history. */
export const MAX_STOP_AGE_MS = 35 * DAY_MS;
/** At most this many posted-record keys are kept. */
export const MAX_POSTED_KEYS = 10_000;
/** At most this many parked threads are tracked; an evicted one loses its quota_resumed. */
export const MAX_PARKED_THREADS = 1_000;

export type RecordKind = "quota_parked" | "quota_reset_unknown" | "quota_resumed" | "provider_switched" | "provider_switch_failed" |
  "quota_headroom_snapshot" | "quota_headroom_changed" | "quota_headroom_low";

export interface ParkedThread {
  readonly runId: string;
  readonly resetAt: string | null;
  readonly provider: string;
  /** Stop time of the parked run (see `stopTime` in observer.ts), epoch milliseconds. */
  readonly stopAt: number;
  /** When the observer first saw this stop, epoch milliseconds. */
  readonly seenAt: number;
}

export interface ObserverState {
  /** Last shell sequence fully processed, or null before the first snapshot. */
  cursor: number | null;
  headroom: HeadroomState;
  /** `kind|threadId|runId` mapped to the stop time of the stop it describes. */
  readonly posted: Map<string, number>;
  readonly pendingDelivery: Map<string, QuotaRecord>;
  deliveryDropped: number;
  readonly parked: Map<string, ParkedThread>;
  readonly switches: Map<string, SwitchIntent>;
  /** Newest stop time among evicted keys; stops at or before it are never reported. */
  evictedThrough: number | null;
}

const FORMAT_VERSION = 5;
export const MAX_PENDING_BYTES = 4 * 1024 * 1024;
export const MAX_STATE_BYTES = 8 * 1024 * 1024;

export function emptyState(): ObserverState {
  return { cursor: null, headroom: emptyHeadroom(), posted: new Map(), pendingDelivery: new Map(), deliveryDropped: 0, parked: new Map(), switches: new Map(), evictedThrough: null };
}

export function recordKey(kind: RecordKind, threadId: string, runId: string): string {
  return `${kind}|${threadId}|${runId}`;
}

/** True when a stop is old enough that its key may have been evicted. */
export function belowWatermark(state: ObserverState, stopAt: number): boolean {
  return state.evictedThrough !== null && stopAt <= state.evictedThrough;
}

function evictKey(state: ObserverState, key: string, stopAt: number): void {
  state.posted.delete(key);
  state.evictedThrough = Math.max(state.evictedThrough ?? stopAt, stopAt);
}

/** Drops expired entries and enforces the caps, oldest first. */
export function prune(state: ObserverState, nowMs: number): void {
  // Never evict an unresolved hold. Admission caps these at 128; reconnect resolves them.
  const completed = [...state.switches.entries()]
    .filter(([, intent]) => intent.phase === "switched" || intent.phase === "cancelled")
    .sort((a, b) => a[1].stopAt - b[1].stopAt);
  for (const [index, [key, intent]] of completed.entries()) {
    if (nowMs - intent.createdAt > KEY_TTL_MS || index < completed.length - MAX_COMPLETED_SWITCHES) {
      state.switches.delete(key);
      state.evictedThrough = Math.max(state.evictedThrough ?? intent.stopAt, intent.stopAt);
    }
  }
  for (const [key, stopAt] of state.posted) {
    if (nowMs - stopAt > KEY_TTL_MS) evictKey(state, key, stopAt);
  }
  for (const [threadId, parked] of state.parked) {
    if (nowMs - parked.seenAt > KEY_TTL_MS) state.parked.delete(threadId);
  }
  if (state.posted.size > MAX_POSTED_KEYS) {
    const byStop = [...state.posted.entries()].sort((a, b) => a[1] - b[1]);
    for (const [key, stopAt] of byStop.slice(0, state.posted.size - MAX_POSTED_KEYS)) evictKey(state, key, stopAt);
  }
  if (state.parked.size > MAX_PARKED_THREADS) {
    const bySeen = [...state.parked.entries()].sort((a, b) => a[1].seenAt - b[1].seenAt);
    for (const [threadId] of bySeen.slice(0, state.parked.size - MAX_PARKED_THREADS)) state.parked.delete(threadId);
  }
}

export function loadState(path: string, nowMs: number): ObserverState {
  if (!existsSync(path)) return emptyState();
  if (statSync(path).size > MAX_STATE_BYTES) throw new Error("observer_state_too_large");
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw?.version !== FORMAT_VERSION && raw?.version !== 4 && raw?.version !== 3 && raw?.version !== 2) throw new Error(`Unsupported state file version in ${path}`);
  const state: ObserverState = {
    cursor: typeof raw.cursor === "number" ? raw.cursor : null,
    headroom: raw.headroom === undefined ? emptyHeadroom() : validateHeadroom(raw.headroom),
    posted: new Map(Object.entries(raw.posted ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number")),
    parked: new Map(Object.entries(raw.parked ?? {}) as Array<[string, ParkedThread]>),
    pendingDelivery: new Map(Object.entries(raw.pendingDelivery ?? {}) as Array<[string, QuotaRecord]>),
    deliveryDropped: Number.isSafeInteger(raw.deliveryDropped) ? raw.deliveryDropped : 0,
    switches: new Map(Object.entries(raw.switches ?? {}) as Array<[string, SwitchIntent]>),
    evictedThrough: typeof raw.evictedThrough === "number" ? raw.evictedThrough : null,
  };
  if (raw.version === 2) {
    for (const intent of state.switches.values()) {
      if (intent.phase === "holding" || intent.phase === "dispatching" || intent.phase === "releasing") {
        // v2 admitted history and did not record reliable hold ownership provenance.
        // Release those intents; never replay an old continuation during migration.
        Object.assign(intent, {
          phase: "releasing",
          expiresAt: Math.min(intent.expiresAt, intent.resetAt === null
            ? intent.createdAt + 120_000 : Date.parse(intent.resetAt) + 120_000),
          restoreAutoResume: intent.restoreAutoResume === false ? null : intent.restoreAutoResume,
        });
      }
    }
  }
  prune(state, nowMs);
  return state;
}

function writeAll(fd: number, data: Buffer): void {
  let offset = 0;
  while (offset < data.length) {
    const written = writeSync(fd, data, offset, data.length - offset);
    if (written <= 0) throw new Error("state file write made no progress");
    offset += written;
  }
}

export function saveState(path: string, state: ObserverState, nowMs: number): void {
  prune(state, nowMs);
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const body = Buffer.from(JSON.stringify({
    version: FORMAT_VERSION,
    cursor: state.cursor,
    headroom: state.headroom,
    evictedThrough: state.evictedThrough,
    posted: Object.fromEntries(state.posted),
    parked: Object.fromEntries(state.parked),
    switches: Object.fromEntries(state.switches),
    pendingDelivery: Object.fromEntries(state.pendingDelivery),
    deliveryDropped: state.deliveryDropped,
  }));
  if (body.length > MAX_STATE_BYTES) throw new Error("observer_state_capacity");
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeAll(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  // Make the rename itself durable.
  const directoryFd = openSync(directory, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}
