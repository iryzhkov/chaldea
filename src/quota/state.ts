// Durable observer state: the shell cursor, the keys of records already
// posted, and the threads currently parked on a usage limit.
//
// One small JSON file, written atomically (temporary file, fsync, rename) with
// mode 0600. Retention is enforced on every save: posted keys and parked
// threads expire after `KEY_TTL_MS` and each map is capped, oldest first, so
// the file stays under a few megabytes whatever happens upstream.
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Posted-record keys and parked threads are forgotten after this long. */
export const KEY_TTL_MS = 42 * DAY_MS;
/** Stops older than this are never reported, so expired keys cannot revive old history. */
export const MAX_STOP_AGE_MS = 35 * DAY_MS;
/** At most this many posted-record keys are kept. */
export const MAX_POSTED_KEYS = 10_000;
/** At most this many parked threads are tracked. */
export const MAX_PARKED_THREADS = 1_000;

export type RecordKind = "quota_parked" | "quota_reset_unknown" | "quota_resumed";

export interface ParkedThread {
  readonly runId: string;
  readonly resetAt: string | null;
  readonly provider: string;
  /** When the observer first saw this stop, epoch milliseconds. */
  readonly seenAt: number;
}

export interface ObserverState {
  /** Last shell sequence fully processed, or null before the first snapshot. */
  cursor: number | null;
  /** `kind|threadId|runId` mapped to the epoch milliseconds it was claimed. */
  readonly posted: Map<string, number>;
  readonly parked: Map<string, ParkedThread>;
}

const FORMAT_VERSION = 1;

export function emptyState(): ObserverState {
  return { cursor: null, posted: new Map(), parked: new Map() };
}

export function recordKey(kind: RecordKind, threadId: string, runId: string): string {
  return `${kind}|${threadId}|${runId}`;
}

/** Drops expired entries and enforces the caps, oldest first. */
export function prune(state: ObserverState, nowMs: number): void {
  for (const [key, at] of state.posted) {
    if (nowMs - at > KEY_TTL_MS) state.posted.delete(key);
  }
  for (const [threadId, parked] of state.parked) {
    if (nowMs - parked.seenAt > KEY_TTL_MS) state.parked.delete(threadId);
  }
  trimOldest(state.posted, MAX_POSTED_KEYS, (at) => at);
  trimOldest(state.parked, MAX_PARKED_THREADS, (parked) => parked.seenAt);
}

function trimOldest<V>(map: Map<string, V>, cap: number, age: (value: V) => number): void {
  if (map.size <= cap) return;
  const byAge = [...map.entries()].sort((a, b) => age(a[1]) - age(b[1]));
  for (const [key] of byAge.slice(0, map.size - cap)) map.delete(key);
}

export function loadState(path: string, nowMs: number): ObserverState {
  if (!existsSync(path)) return emptyState();
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (raw?.version !== FORMAT_VERSION) throw new Error(`Unsupported state file version in ${path}`);
  const state: ObserverState = {
    cursor: typeof raw.cursor === "number" ? raw.cursor : null,
    posted: new Map(Object.entries(raw.posted ?? {}).filter((entry): entry is [string, number] => typeof entry[1] === "number")),
    parked: new Map(Object.entries(raw.parked ?? {}) as Array<[string, ParkedThread]>),
  };
  prune(state, nowMs);
  return state;
}

export function saveState(path: string, state: ObserverState, nowMs: number): void {
  prune(state, nowMs);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({
    version: FORMAT_VERSION,
    cursor: state.cursor,
    posted: Object.fromEntries(state.posted),
    parked: Object.fromEntries(state.parked),
  });
  const temporary = `${path}.tmp`;
  const fd = openSync(temporary, "w", 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
}
