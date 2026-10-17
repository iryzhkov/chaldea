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
interface Cache<T> { attemptedAt: number; fetchedAt: string | null; value: T | null }
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
      return { attemptedAt: raw.attemptedAt, fetchedAt: typeof raw.fetchedAt === "string" && Number.isFinite(Date.parse(raw.fetchedAt)) ? raw.fetchedAt : null, value };
    } catch { return { attemptedAt: 0, fetchedAt: null, value: null }; }
  };
  let state = load();
  const result = (reason: string | null): Cached<T> => ({ value: state.value, fetchedAt: state.fetchedAt, reason });
  if (now - state.attemptedAt < interval) return result(state.value ? null : "cached collection failure");
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
    if (now - state.attemptedAt < interval) return result(state.value ? null : "cached collection failure");
    state = { ...state, attemptedAt: now };
    writeJson(path, state); // Reserve before reading any credential or making a request.
    try {
      const value = validate(await collect());
      state = { attemptedAt: now, fetchedAt: new Date(now).toISOString(), value };
      writeJson(path, state);
      return result(null);
    } catch {
      // Never stringify request/response errors: they may contain credentials.
      return result("collection failed; retained last successful cache");
    }
  } finally { rmSync(lock, { force: true }); }
}
export async function getJson(url: string, init: RequestInit = {}, fetcher: typeof fetch = fetch, maxBytes = 2 * 1024 * 1024): Promise<unknown> {
  const response = await fetcher(url, { ...init, method: "GET", redirect: "error", signal: AbortSignal.timeout(5000) });
  try {
    if (!response.ok || !response.body) throw new Error("Usage request failed");
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
