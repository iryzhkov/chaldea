// One collector per host; instrumentation never performs network I/O.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, openSync, readSync, fstatSync, lstatSync, unlinkSync, opendirSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { hostname } from "node:os";
import { eventsConfig } from "../config/events.ts";
import { createLogger } from "../config/log.ts";
import { ConfigurationError } from "../config/files.ts";
import { EXIT } from "../config/exit.ts";
import { pathToFileURL } from "node:url";
import { Outbox, type Cursor } from "./outbox.ts";
import { publish, type Publication, type PublisherOptions } from "./publisher.ts";
const LINE_BYTES = 64 * 1024;
const DAY = 86400_000;
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
function bytes(fd: number, offset: number, length: number): Buffer {
  const b = Buffer.alloc(length); return b.subarray(0, readSync(fd, b, 0, length, offset));
}
export interface CollectorOptions {
  spool: string; timers?: string; host: string; outbox: Outbox;
  publisher?: PublisherOptions; deliver?: (event: Publication) => Promise<boolean>;
  now?: () => number; maxEvents?: number;
  /** Only configured labels are retained. Raw filesystem paths are never uploaded. */
  roots?: Record<string, string>;
}
function safeString(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f]/.test(value)) throw new Error("invalid_field");
  return value;
}
export function toolPayload(raw: Record<string, unknown>, line: Buffer, toolSource: string, host: string,
  roots: Record<string, string> = {}): Record<string, unknown> {
  if (raw.host !== host) throw new Error("foreign_host");
  const ts = safeString(raw.ts, 64);
  if (!Number.isFinite(Date.parse(ts))) throw new Error("invalid_time");
  const data: Record<string, unknown> = { ts: new Date(ts).toISOString(), raw_line_hash: sha(line), tool_source: safeString(toolSource) };
  for (const key of ["session", "proc", "client", "tool"]) data[key] = safeString(String(raw[key] ?? "") || "unknown");
  data.outcome = safeString(String(raw.outcome ?? (raw.ok === true ? "ok" : "internal")));
  if (!Number.isSafeInteger(raw.seq) || Number(raw.seq) < 0 || typeof raw.ok !== "boolean") throw new Error("invalid_field");
  data.seq = raw.seq; data.ok = raw.ok;
  const args = raw.args === undefined ? [] : raw.args;
  if (!Array.isArray(args) || args.length > 128 ||
    !args.every(a => typeof a === "string" && (a === "?" || /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(a)))) throw new Error("invalid_args");
  data.args = args;
  // Only declared fixed classes are copied. Unknown producer error classes
  // become stable fingerprints, so arbitrary text (even a bare bearer) cannot escape.
  const classes = new Set(["usage", "unknown-command", "unknown-option", "missing-argument", "no-credential",
    "refused", "unreadable", "conflict", "not-found", "unreachable", "timeout", "error",
    "internal", "transport", "state", "invalid_argument", "not_found", "permission_denied", "invalid", "local-io"]);
  if (raw.err) data.err = typeof raw.err === "string" && classes.has(raw.err) ? raw.err : "fingerprint/" + sha(String(raw.err));
  for (const key of ["exit", "ms"]) if (raw[key] !== undefined && raw[key] !== null) {
    if (!Number.isSafeInteger(raw[key]) || (key === "ms" && Number(raw[key]) < 0)) throw new Error("invalid_number");
    data[key] = raw[key];
  }
  if (typeof raw.root === "string" && roots[raw.root]) data.root = safeString(roots[raw.root], 512);
  return { v: 1, kind: "tool_call", source: host + ".toolfeedback", host,
    occurred_at: data.ts, severity: raw.ok ? "info" : "warn", data };
}
function* files(root: string, timer = false, onError: () => void = () => {}): Generator<string> {
  function* entries(path: string): Generator<import("node:fs").Dirent> {
    let dir;
    try { dir = opendirSync(path); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") onError();
      return;
    }
    try { for (let entry; (entry = dir.readSync()) !== null;) yield entry; }
    catch { onError(); }
    finally { dir.closeSync(); }
  }
  // Stream the exact spool layout without a global file cap. In particular,
  // pruning must eventually reach every file, even after a fleet backfill.
  for (const e of entries(root)) {
    if (timer) {
      if (e.isFile() && e.name.endsWith(".jsonl")) yield join(root, e.name);
    } else if (e.isDirectory()) {
      for (const child of entries(join(root, e.name))) {
        if (child.isFile() && child.name.endsWith(".jsonl") && child.name !== "transcripts.jsonl")
          yield join(root, e.name, child.name);
      }
    }
  }
}

function cursorAt(fd: number, base: Cursor, offset: number): Cursor {
  const st = fstatSync(fd, { bigint: true });
  return { ...base, offset, size: Number(st.size), modified: String(st.mtimeNs),
    tail: sha(bytes(fd, Math.max(0, offset - 128), Math.min(offset, 128))) };
}
function generation(fd: number, old: Cursor | null): Cursor {
  const st = fstatSync(fd, { bigint: true }), size = Number(st.size);
  // A metadata-only touch is not a new logical generation. Inode, size and
  // prefix/tail evidence detect replacement and observable truncation/rewrite.
  if (old && old.dev === String(st.dev) && old.ino === String(st.ino) && size >= (old.size ?? old.offset) &&
    sha(bytes(fd, 0, old.prefixLength)) === old.prefix &&
    sha(bytes(fd, Math.max(0, old.offset - 128), Math.min(old.offset, 128))) === old.tail) return old;
  const prefixLength = Math.min(size, 128);
  return { generation: randomUUID(), dev: String(st.dev), ino: String(st.ino), offset: 0,
    prefixLength, prefix: sha(bytes(fd, 0, prefixLength)), tail: sha(""), size, modified: String(st.mtimeNs) };
}
/** Timer input is already redacted by the wrapper; allowlist again at the boundary. */
export function timerPublication(raw: Record<string, unknown>, host: string): Publication {
  const job = safeString(raw.job), invocation = safeString(raw.invocation);
  if (!["chaldea-fleet-pull", "chaldea-retention"].includes(job) || !/^[a-f0-9]{32}$/.test(invocation) || raw.host !== host)
    throw new Error("invalid_timer");
  const status = safeString(raw.outcome);
  if (!["changed", "failed"].includes(status)) throw new Error("invalid_timer");
  return { key: job + "/" + invocation, source: host + ".fleet", host,
    payload: { v: 1, kind: "job_finished", source: host + ".fleet", host,
      occurred_at: safeString(raw.timestamp, 64), severity: status === "failed" ? "fail" : "info",
      title: host + ": " + job + " " + status,
      body: JSON.stringify({
        changed: Number.isSafeInteger(raw.changed) ? Math.max(0, Math.min(Number(raw.changed), 1000000)) : 0,
        task: typeof raw.task === "string" ? safeString(raw.task || "unknown", 160) : "",
        reason: typeof raw.reason === "string" ? safeString(raw.reason || "unknown", 160) : "",
        releases: Array.isArray(raw.releases) ? raw.releases.filter(r => typeof r === "string" && /^[a-zA-Z0-9@._+:/-]{1,100}$/.test(r)).slice(0, 24) : [],
        releases_omitted: Number.isSafeInteger(raw.releases_omitted) ? Math.max(0, Math.min(Number(raw.releases_omitted), 1000000)) : 0,
      }),
      data: { job_id: job, invocation_id: invocation, status } } };
}
export async function collect(options: CollectorOptions): Promise<void> {
  const { outbox } = options, now = (options.now ?? Date.now)();
  const deliver = options.deliver ?? ((e: Publication) => publish(e, options.publisher));
  let budget = options.maxEvents ?? 100;
  async function drain(): Promise<boolean> {
    while (budget > 0) {
      const pending = outbox.next(); if (!pending) return true;
      budget--;
      if (!await deliver(pending.event)) { outbox.count("deferred"); return false; }
      outbox.acknowledge(pending.event.key);
    }
    return outbox.next() === null;
  }
  // Pruning is independent of delivery health: an outage cannot disable retention.
  for (const [root, timer] of [[options.spool, false], ...(options.timers ? [[options.timers, true]] : [])] as [string, boolean][]) {
    for (const path of files(root, timer, () => outbox.count("scan_errors"))) {
      const st = lstatSync(path); if (now - st.mtimeMs <= 90 * DAY) continue;
      const file = (timer ? "timer/" : "tool/") + relative(root, path), fd = openSync(path, "r");
      try {
        const c = generation(fd, outbox.cursor(file));
        let offset = Math.max(c.offset, outbox.pendingOffset(file) ?? 0), lost = 0, b: Buffer;
        do { b = bytes(fd, offset, LINE_BYTES); offset += b.length; for (const byte of b) if (byte === 10) lost++; } while (b.length === LINE_BYTES);
        outbox.transaction(() => { if (lost) outbox.count("expired_unshipped", lost); outbox.checkpoint(file, cursorAt(fd, c, offset)); });
        unlinkSync(path); outbox.forget(file);
      } finally { closeSync(fd); }
    }
  }
  if (!await drain()) return;
  for (const [root, timer] of [[options.spool, false], ...(options.timers ? [[options.timers, true]] : [])] as [string, boolean][]) {
    for (const path of files(root, timer, () => outbox.count("scan_errors"))) {
      if (budget <= 0) return;
      const rel = relative(root, path), file = (timer ? "timer/" : "tool/") + rel;
      const st = lstatSync(path);
      if (st.isSymbolicLink() || !st.isFile()) continue;
      const fd = openSync(path, "r");
      try {
        let cursor = generation(fd, outbox.cursor(file));
        while (budget > 0) {
          const chunk = bytes(fd, cursor.offset, LINE_BYTES + 1), newline = chunk.indexOf(10);
          if (newline < 0) {
            if (chunk.length > LINE_BYTES) {
              // Skip an oversize record incrementally; never buffer an unbounded line.
              let end = cursor.offset + chunk.length, b: Buffer;
              do { b = bytes(fd, end, LINE_BYTES); const n = b.indexOf(10); if (n >= 0) { end += n + 1; break; } end += b.length; }
              while (b.length === LINE_BYTES);
              if (b!.includes(10)) { cursor = cursorAt(fd, cursor, end); outbox.transaction(() => { outbox.count("oversize"); outbox.checkpoint(file, cursor); }); }
            }
            break; // Torn line waits for its newline.
          }
          const line = chunk.subarray(0, newline), next = cursorAt(fd, cursor, cursor.offset + newline + 1);
          let event: Publication;
          try {
            const raw = JSON.parse(line.toString()) as Record<string, unknown>;
            if (timer) event = timerPublication(raw, options.host);
            else event = { key: cursor.generation + "/" + rel + "/" + cursor.offset, source: options.host + ".toolfeedback", host: options.host,
              payload: toolPayload(raw, line, rel.split("/")[0]!, options.host, options.roots) };
            if (Buffer.byteLength(event.key) > 256) throw new Error("key_too_long");
          } catch (error) {
            budget--;
            outbox.transaction(() => { outbox.count(error instanceof Error && error.message === "foreign_host" ? "foreign_host" : "rejected"); outbox.checkpoint(file, next); });
            cursor = next; continue;
          }
          if (!outbox.admit(event, file, next)) return;
          if (!await drain()) return;
          cursor = next;
        }
      } finally { closeSync(fd); }
    }
  }
}
async function main(): Promise<void> {
  const config = eventsConfig();
  const outbox = new Outbox(config.stateFile);
  try {
    await collect({ outbox, host: hostname().split(".")[0]!, spool: config.spool,
      timers: config.timerSpool });
    console.log(JSON.stringify({ counters: outbox.counters(), pending: outbox.next() !== null }));
  } finally { outbox.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  main().catch(error => { createLogger().error("akasha collector failed; state retained"); process.exitCode = error instanceof ConfigurationError ? EXIT.config : EXIT.failure; });
