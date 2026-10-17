import { ensure, HttpError, hash, record } from "./schema.ts";
import type { FeedRow, Envelope } from "./schema.ts";
import { scopeSql } from "./store.ts";
import type { EventStore, Query } from "./store.ts";
import type { Scope } from "./auth.ts";

export function limit(q: URLSearchParams): number {
  const value = q.get("limit") || "100";
  ensure(/^\d{1,10}$/.test(value), "invalid_limit");
  return Math.min(Number(value), 1000);
}
export function since(value: string, now: number): string | null {
  if (!value.trim()) return null;
  const match = /^(\d+)\s*([smhdw])$/.exec(value.trim());
  if (!match) { ensure(Number.isFinite(Date.parse(value)), "invalid_since"); return value; }
  const seconds = Number(match[1]) * ({ s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[match[2]!]!);
  ensure(Number.isSafeInteger(seconds) && seconds <= 100 * 365 * 86400, "invalid_since");
  return new Date((now - seconds) * 1000).toISOString();
}
function feedQuery(q: URLSearchParams, scope: Scope, now: number, grepEnabled = true): Query {
  const base = scopeSql(scope, "e."), conditions = [base.sql], params = base.params;
  const start = since(q.get("since") ?? "", now);
  if (start) { conditions.push("f.created_at>=?"); params.push(start); }
  for (const key of ["host", "source", "severity"]) {
    const value = q.get(key)?.trim();
    if (value) { conditions.push("f." + key + "=?"); params.push(key === "severity" ? value.toLowerCase() : value); }
  }
  const tag = q.get("tag")?.trim().toLowerCase();
  if (tag) { conditions.push("(','||f.tags||',') LIKE ?"); params.push("%," + tag + ",%"); }
  const grep = grepEnabled ? q.get("grep")?.trim() : undefined;
  if (grep) { ensure(grep.length <= 256, "grep_too_large"); conditions.push("(f.title LIKE ? OR f.body LIKE ?)"); params.push("%" + grep + "%", "%" + grep + "%"); }
  return { sql: conditions.join(" AND "), params };
}
export function* feedRows(store: EventStore, q: URLSearchParams, scope: Scope, now: number): Generator<FeedRow> {
  const max = limit(q), base = feedQuery(q, scope, now), candidate = feedQuery(q, scope, now, false);
  const grep = q.get("grep")?.trim();
  let last: FeedRow | undefined, matched = 0, scanned = 0, rejectedBytes = 0, workMs = 0;
  while (matched < max) {
    const started = performance.now();
    if (grep) ensure(scanned < 10000 && rejectedBytes < 32 * 1024 ** 2 && workMs < 250, "query_scan_budget", 503);
    const where = last ? " AND (f.created_at<? OR (f.created_at=? AND f.id<?))" : "";
    const params = last ? [...candidate.params, last.created_at, last.created_at, last.id] : candidate.params;
    // Scan bounded candidates, evaluating LIKE only on a single primary-key row.
    // No reader or unbounded body scan survives a yield/network wait.
    const row = store.db.prepare("SELECT f.id,f.created_at,f.host,f.source,f.severity,f.title,f.body,f.tags,f.link " +
      "FROM feed_entries f JOIN events e USING(event_id) WHERE " + candidate.sql + where +
      " ORDER BY f.created_at DESC,f.id DESC LIMIT 1").get(...params) as unknown as FeedRow | undefined;
    if (!row) return;
    const authorizedMatch = store.db.prepare("SELECT 1 FROM feed_entries f JOIN events e USING(event_id) WHERE f.id=? AND " + base.sql)
      .get(row.id, ...base.params);
    workMs += performance.now() - started; scanned++; last = row;
    if (!authorizedMatch) { rejectedBytes += Buffer.byteLength(row.body); continue; }
    matched++; yield row;
  }
}
interface Cursor { v: number; epoch: string; seq: number; binding: string }
export function eventPage(store: EventStore, q: URLSearchParams, scope: Scope, now: number): {
  rows: Generator<Envelope>; next: () => string | null;
} {
  const count = limit(q), query = new URLSearchParams(q); query.delete("cursor");
  const binding = hash([scope, [...query.entries()].sort()]);
  let seq = 0;
  if (q.has("cursor")) {
    const raw = q.get("cursor")!;
    ensure(raw.length <= 1024 && /^[A-Za-z0-9_-]+$/.test(raw), "invalid_cursor");
    let c: Record<string, unknown>;
    try { c = record(JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))); }
    catch { throw new HttpError(400, "invalid_cursor"); }
    ensure(c.v === 1 && c.binding === binding && Number.isSafeInteger(c.seq) && (c.seq as number) >= 0, "invalid_cursor");
    ensure(c.epoch === store.get("epoch") && (c.seq as number) >= Number(store.get("floor")), "cursor_expired_reset", 410);
    seq = c.seq as number;
  }
  const start = q.get("from") ? since(q.get("from")!, now)! : new Date((now - 7 * 86400) * 1000).toISOString();
  const end = q.get("to") ? since(q.get("to")!, now)! : new Date(now * 1000).toISOString();
  ensure(Date.parse(start) <= Date.parse(end) && Date.parse(end) - Date.parse(start) <= 180 * 86400_000, "invalid_time_range");
  const base = scopeSql(scope), parts = [base.sql, "occurred_at>=?", "occurred_at<=?"], params = [...base.params, start, end];
  for (const key of ["source", "host", "kind", "session", "tool", "client", "project"]) {
    const value = q.get(key);
    if (value) { ensure(value.length <= 512, "invalid_filter"); parts.push(key + "=?"); params.push(value); }
  }
  let yielded = 0;
  function* rows(): Generator<Envelope> {
    for (; yielded < count; yielded++) {
      const r = store.db.prepare("SELECT seq,envelope FROM events WHERE " + parts.join(" AND ") + " AND seq>? ORDER BY seq LIMIT 1")
        .get(...params, seq) as { seq: number; envelope: string } | undefined;
      if (!r) return; seq = r.seq; yield JSON.parse(r.envelope) as Envelope;
    }
  }
  return { rows: rows(), next: () => {
    if (!count || !store.db.prepare("SELECT 1 FROM events WHERE " + parts.join(" AND ") + " AND seq>? LIMIT 1").get(...params, seq)) return null;
    const c: Cursor = { v: 1, epoch: store.get("epoch")!, seq, binding };
    return Buffer.from(JSON.stringify(c)).toString("base64url");
  } };
}
export function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
export function article(row: FeedRow): string {
  let link = "";
  try { const url = new URL(row.link); if (["https:", "http:"].includes(url.protocol)) link = '<a rel="noreferrer" href="' + escape(url.href) + '">thread</a>'; } catch {}
  return "<article><strong>" + escape(row.title) + "</strong><p>" + escape(row.created_at + " " + row.host + "/" + row.source +
    " [" + row.severity + "] #" + row.id + " " + row.tags) + " " + link + "</p><pre>" + escape(row.body) + "</pre></article>";
}
