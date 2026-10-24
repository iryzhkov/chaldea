import { ensure, HttpError, hash, record } from "./schema.ts";
import type { FeedRow, Envelope } from "./schema.ts";
import { emptyOperations, operationText, validateOperations } from "../mission-control/contract.ts";
import { OPERATIONS_PAIRS, scopeSql } from "./store.ts";
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
  if (!max) return;
  type FeedId = { id: number; created_at: string };
  let last: FeedId | undefined, matched = 0, scanned = 0, rejectedBytes = 0, workMs = 0;
  const select = "SELECT f.id,f.created_at FROM feed_entries f JOIN events e USING(event_id) WHERE " + candidate.sql;
  const first = store.db.prepare(select + " ORDER BY f.created_at DESC,f.id DESC LIMIT ?");
  const after = store.db.prepare(select + " AND (f.created_at,f.id)<(?,?) ORDER BY f.created_at DESC,f.id DESC LIMIT ?");
  const read = store.db.prepare("SELECT f.id,f.created_at,f.host,f.source,f.severity,f.title,f.body,f.tags,f.link " +
    "FROM feed_entries f JOIN events e USING(event_id) WHERE f.id=? AND " + candidate.sql);
  const match = grep ? store.db.prepare("SELECT 1 FROM feed_entries f JOIN events e USING(event_id) WHERE f.id=? AND " + base.sql) : undefined;
  const checkBudget = () => {
    if (grep) ensure(scanned < 10000 && rejectedBytes < 32 * 1024 ** 2 && workMs < 250, "query_scan_budget", 503);
  };
  while (matched < max) {
    checkBudget();
    const started = performance.now(), size = grep ? Math.min(max + 1, 10000 - scanned) : max + 1;
    // Sort at most once per bounded candidate page, retaining IDs only. The tuple
    // seek follows feed_time ordering without a keyset OR. No reader crosses a yield.
    const ids = (last ? after.all(...candidate.params, last.created_at, last.id, size) :
      first.all(...candidate.params, size)) as FeedId[];
    workMs += performance.now() - started;
    if (!ids.length) return;
    for (const id of ids) {
      checkBudget();
      const started = performance.now();
      // Recheck scope and filters in SQL after each yield; LIKE sees one PK row.
      const row = read.get(id.id, ...candidate.params) as unknown as FeedRow | undefined;
      const authorizedMatch = row && (!match || match.get(id.id, ...base.params));
      workMs += performance.now() - started; scanned++; last = id;
      if (!row) continue;
      if (!authorizedMatch) { rejectedBytes += Buffer.byteLength(row.body); continue; }
      matched++; yield row;
      if (matched === max) return;
    }
  }
}
interface Cursor { v: number; epoch: string; seq: number; binding: string }
export function eventPage(store: EventStore, q: URLSearchParams, scope: Scope, now: number): {
  rows: Generator<Envelope>; next: () => string | null;
} {
  ensure(scope.missionControlOperations===undefined,"operations_selector_required",403);
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
  if (scope.missionControlSources) ensure(Date.parse(end)-Date.parse(start)<=3600_000, "mission_control_window", 403);
  ensure(Date.parse(start) <= Date.parse(end) && Date.parse(end) - Date.parse(start) <= 180 * 86400_000, "invalid_time_range");
  const base = scopeSql(scope), parts = [base.sql, "occurred_at>=?", "occurred_at<=?"], params = [...base.params, start, end];
  for (const key of ["source", "host", "kind", "session", "tool", "client", "project"]) {
    const value = q.get(key);
    if (value) { ensure(value.length <= 512, "invalid_filter"); parts.push(key + "=?"); params.push(value); }
  }
  if (scope.missionControlSources) { parts.push("expiry>?"); params.push(now); }
  // Select a bounded page of IDs once: repeating LIMIT 1 can sort the entire
  // time window for every row. No envelope or live SQLite reader crosses a yield.
  // scopeSql has validated this reader scope and constrained kind to agent_status.
  // Use the format-v1 kind/seq index only for its explicit status selector, so
  // ordinary project history is skipped. Retained status history still costs work.
  const statusIndex = scope.missionControlSources !== undefined && q.get("kind") === "agent_status"
    ? " INDEXED BY events_kind_seq" : "";
  const ids = count ? store.db.prepare("SELECT seq FROM events" + statusIndex + " WHERE " + parts.join(" AND ") + " AND seq>? ORDER BY seq LIMIT ?")
    .all(...params, seq, count + 1) as { seq: number }[] : [];
  const read = store.db.prepare("SELECT envelope FROM events WHERE seq=? AND " + parts.join(" AND "));
  function* rows(): Generator<Envelope> {
    for (const id of ids.slice(0, count)) {
      seq = id.seq;
      const r = read.get(seq, ...params) as { envelope: string } | undefined;
      if (r) yield JSON.parse(r.envelope) as Envelope;
    }
  }
  return { rows: rows(), next: () => {
    if (ids.length <= count) return null;
    const c: Cursor = { v: 1, epoch: store.get("epoch")!, seq, binding };
    return Buffer.from(JSON.stringify(c)).toString("base64url");
  } };
}

/** This selector returns only public fields; authorized private envelopes never leave H. */
export function operationsPage(store:EventStore,q:URLSearchParams,scope:Scope,now:number):import("../mission-control/contract.ts").OperationsDTO {
  const kind=q.get("mission_control_operations");
  ensure((kind==="job_finished"||kind==="report")&&[...q.keys()].length===3&&new Set(q.keys()).size===3&&q.get("window")==="48h"&&q.get("limit")==="16","invalid_operations_selector",403);
  ensure(scope.missionControlSources!==undefined&&!scope.missionControlOperations,"operations_forbidden",403);
  const result=emptyOperations(),checkedAt=now*1000;
  const base=scopeSql({...scope,missionControlOperations:kind});
  for(const pair of OPERATIONS_PAIRS.filter(p=>p.kind===kind)){
    const records=store.db.prepare("SELECT json_object('source_id',json_extract(envelope,'$.source_id'),'issuer',issuer,'profile',profile,'project',project,'host',host,'source',source,'kind',kind,'severity',json_extract(envelope,'$.severity'),'occurred_at',occurred_at,'received_at',received_at,'provenance',json_object('type',json_extract(envelope,'$.provenance.type')),'data',json_object('job_id',json_extract(envelope,'$.data.job_id'),'status',json_extract(envelope,'$.data.status'),'checks',json_extract(envelope,'$.data.checks'))) AS envelope FROM events WHERE "+base.sql+" AND json_extract(envelope,'$.source_id')=? AND occurred_at>=? AND occurred_at<=? AND received_at<=? AND expiry>? ORDER BY occurred_at DESC,seq DESC LIMIT 17").all(...base.params,pair.source_id,new Date(checkedAt-48*3600_000).toISOString(),new Date(checkedAt).toISOString(),new Date(checkedAt).toISOString(),now) as {envelope:string}[];
    result.events.truncated ||= records.length>16;
    for(const raw of records.slice(0,16)){
      const e=JSON.parse(raw.envelope) as Envelope;
      ensure(e.provenance.type==="verified"&&e.source_id===pair.source_id&&e.issuer===pair.issuer&&e.profile===pair.profile&&e.project===pair.project&&e.host===pair.host&&e.source===pair.source&&e.kind===pair.kind,"invalid_operations_pair",403);
      const occurredAt=Date.parse(e.occurred_at),receivedAt=Date.parse(e.received_at);
      if(kind==="job_finished"){
        ensure(["chaldea-fleet-pull","chaldea-retention"].includes(String(e.data.job_id))&&["changed","failed"].includes(String(e.data.status))&&e.severity===(e.data.status==="failed"?"fail":"info"),"invalid_timer_projection");
        result.events.rows.push({host:pair.host,job:e.data.job_id as "chaldea-fleet-pull"|"chaldea-retention",status:e.data.status as "changed"|"failed",severity:e.severity as "info"|"fail",occurredAt,receivedAt});
      }else{
        ensure(operationText(e.data.status,32)&&Array.isArray(e.data.checks)&&e.data.checks.length<=100,"invalid_report_projection");
        const checks=e.data.checks.map(raw=>{const c=record(raw);ensure(Object.keys(c).length===2&&operationText(c.name,128)&&operationText(c.status,32),"invalid_report_check");return {name:c.name,status:c.status};});
        if(result.ops.dailyHealth.report===null)result.ops.dailyHealth.report={status:e.data.status,occurredAt,receivedAt,checks:checks.slice(0,16),omitted:Math.max(0,checks.length-16)};
      }
    }
  }
  if(kind==="job_finished"){result.events.state="cached";result.events.checkedAt=checkedAt;result.events.rows.sort((a,b)=>b.occurredAt-a.occurredAt);}
  else{result.ops.dailyHealth.state="cached";result.ops.dailyHealth.checkedAt=checkedAt;result.events.truncated=false;}
  return validateOperations(result,checkedAt);
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
