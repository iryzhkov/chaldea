import { mkdirSync, openSync, closeSync, readFileSync, fstatSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export function readJson(path: string, limit = 2 * 1024 * 1024): unknown {
  const fd = openSync(path, "r");
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > limit) throw new Error("JSON file too large");
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally { closeSync(fd); }
}
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = path + "." + randomUUID();
  try {
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}
const FAILURE_REASONS = ["credential_expired", "credential_unavailable", "rate_limited", "unauthorized", "collection_failed"] as const;
type FailureReason = typeof FAILURE_REASONS[number];
/** Only allowlisted categories may reach persistent diagnostics. Never persist raw errors. */
export class CollectionFailure extends Error {
  readonly reason: FailureReason; readonly retryDelayMs: number | null;
  constructor(reason: FailureReason, retryDelayMs: number | null = null) { super(reason); this.reason = reason; this.retryDelayMs = retryDelayMs; }
}
export class HttpFailure extends Error {
  readonly status: number; readonly retryAfter: string | null;
  constructor(status: number, retryAfter: string | null) { super("Usage request failed"); this.status = status; this.retryAfter = retryAfter; }
}
interface Cache<T> { attemptedAt: number; fetchedAt: string | null; value: T | null;
  failureReason?: FailureReason | null; failureCount?: number; retryAt?: number }
export interface Cached<T> { value: T | null; fetchedAt: string | null; reason: string | null }
/** Persistent reservation bounds failures and successes across CLI/MCP processes.
 * Lock contention skips collection. A crashed lock is removed only after its cadence.
 */
export async function cached<T>(path: string, interval: number, now: number,
  validate: (raw: unknown) => T, collect: () => Promise<T>): Promise<Cached<T>> {
  const load = (): Cache<T> => {
    try {
      const raw = readJson(path) as Cache<unknown>;
      if (!Number.isFinite(raw.attemptedAt) || raw.attemptedAt < 0) throw new Error();
      // Preserve the reservation across clock regression and cached-value schema changes.
      let value: T | null = null;
      try { if (raw.value !== null) value = validate(raw.value); } catch { /* Unknown data, reserved attempt. */ }
      return { attemptedAt: raw.attemptedAt, fetchedAt: typeof raw.fetchedAt === "string" && Number.isFinite(Date.parse(raw.fetchedAt)) ? raw.fetchedAt : null, value,
        failureReason: FAILURE_REASONS.includes(raw.failureReason!) ? raw.failureReason! : null,
        failureCount: Number.isSafeInteger(raw.failureCount) && raw.failureCount! >= 0 ? Math.min(raw.failureCount!, 16) : 0,
        retryAt: Number.isSafeInteger(raw.retryAt) && raw.retryAt! >= 0 && raw.retryAt! < 8.64e15 ? raw.retryAt! : 0 };
    } catch { return { attemptedAt: 0, fetchedAt: null, value: null }; }
  };
  let state = load();
  const result = (reason: string | null): Cached<T> => ({ value: state.value, fetchedAt: state.fetchedAt, reason });
  const failureReason = () => state.failureReason
    ? state.failureReason + (state.value ? "; retained last successful cache, age " + Math.max(0, Math.floor((now - Date.parse(state.fetchedAt!)) / 1000)) + "s" : "; no successful cache") +
      (state.retryAt ? "; retry at " + new Date(state.retryAt).toISOString() : "")
    : state.value ? null : "cached collection failure";
  const reserved = () => now - state.attemptedAt < interval || now < (state.retryAt ?? 0);
  if (reserved()) return result(failureReason());
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = path + ".lock";
  try {
    const fd = openSync(lock, "wx", 0o600); closeSync(fd);
  } catch {
    try {
      const fd = openSync(lock, "r");
      let stale = false;
      try { stale = now - fstatSync(fd).mtimeMs > interval; } finally { closeSync(fd); }
      if (stale) rmSync(lock);
    } catch { /* Another caller owns or released it. */ }
    return result("collection already reserved");
  }
  try {
    state = load();
    if (reserved()) return result(failureReason());
    state = { ...state, attemptedAt: now };
    writeJson(path, state); // Reserve before reading any credential or making a request.
    try {
      const value = validate(await collect());
      state = { attemptedAt: now, fetchedAt: new Date(now).toISOString(), value };
      writeJson(path, state);
      return result(null);
    } catch (error) {
      // Never stringify request/response errors: they may contain credentials.
      const reason = error instanceof CollectionFailure ? error.reason : "collection_failed";
      const count = reason === "rate_limited" ? Math.min((state.failureCount ?? 0) + 1, 16) : 0;
      const delay = reason === "rate_limited" ? error instanceof CollectionFailure && error.retryDelayMs !== null
        ? error.retryDelayMs : Math.min(5 * 60000 * 2 ** (count - 1), 3600000) : interval;
      state = { ...state, failureReason: reason, failureCount: count, retryAt: Math.min(8.64e15 - 1, now + Math.max(0, delay)) };
      writeJson(path, state);
      return result(failureReason());
    }
  } finally { rmSync(lock, { force: true }); }
}
export async function getJson(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const response = await fetcher(url, { ...init, method: "GET", redirect: "error", signal: AbortSignal.timeout(5000) });
  try {
    if (!response.ok) throw new HttpFailure(response.status, response.headers.get("retry-after"));
    if (!response.body) throw new Error("Usage request failed");
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("Usage response too large");
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally { await response.body?.cancel().catch(() => {}); }
}
