import type { DatabaseSync } from "node:sqlite";
import { openPrivateDb, tx, meta, migrate } from "../store/sqlite.ts";
import { Outbox, sqliteOutbox } from "../store/outbox.ts";
import type { SQLInputValue } from "node:sqlite";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, ensure, hash, MAX_ENVELOPE, NEW_FEED_ID, validateEnvelope } from "./schema.ts";
import type { Envelope, FeedRow } from "./schema.ts";
import type { Scope } from "./auth.ts";

/** Fixed complete tuples. This is deliberately not a source/kind/project cross product. */
export const OPERATIONS_PAIRS=[
  {source_id:"agent-a-fleet",host:"agent-a",source:"agent-a.fleet",kind:"job_finished",profile:"fleet-timers",project:"chaldea"},
  ...["agent-b","omarchy-pc","omarchy-macbook-air-igor"].map(host=>({source_id:host+"--"+host+"_fleet",host,source:host+".fleet",kind:"job_finished",profile:"fleet-timers",project:"chaldea"})),
  {source_id:"agent-a-daily-health",host:"agent-a",source:"chaldea.daily-health.agent-a",kind:"report",profile:"daily-health",project:"homelab"}
].map(p=>({...p,issuer:"chaldea:"+p.host}));
export const DAY = 86400;
export const DEFAULT_BUDGET = { main: 4 * 1024 ** 3, wal: 64 * 1024 ** 2, outbox: 128 * 1024 ** 2, quarantine: 16 * 1024 ** 2 };
export interface Budget { main: number; wal: number; outbox: number; quarantine: number }
const PRUNE_TAG_ROWS = "SELECT t.tag,t.event_id FROM events e, json_each(e.envelope,'$.tags') j " +
  "JOIN event_tags t ON t.tag=j.value AND t.event_id=e.event_id WHERE e.seq=?";
const RECEIPT_INDICES = [
  { name: "receipts_state_expiry", columns: ["state", "expires"], bytes: "length(CAST(state AS BLOB))+8" },
  { name: "receipts_status_scope", columns: ["profile", "project", "source"],
    bytes: "length(CAST(profile AS BLOB))+length(CAST(project AS BLOB))+length(CAST(source AS BLOB))" },
] as const;
export interface Receipt {
  event_id: string; request_hash: string; envelope_hash: string; state: "pending" | "visible" | "tombstone" | "quarantined";
  feed_id: number | null; issuer: string; profile: string; project: string; source: string; host: string; expires: number;
}
export interface Pending { event_id: string; envelope: string; bytes: number; attempts: number }
export interface Query { sql: string; params: SQLInputValue[] }
export function scopeSql(scope: Scope, prefix = ""): Query {
  if(scope.missionControlOperations!==undefined){
    ensure(scope.missionControlSources!==undefined&&["job_finished","report"].includes(scope.missionControlOperations),"invalid_operations_scope",403);
    const {missionControlOperations:_kind,...statusScope}=scope;scopeSql(statusScope,prefix);
    const pairs=OPERATIONS_PAIRS.filter(p=>p.kind===scope.missionControlOperations);
    return {sql:"("+pairs.map(()=>"("+["source_id","issuer","profile","project","host","source","kind"].map(k=>(k==="source_id"?"json_extract("+prefix+"envelope,'$.source_id')":prefix+k)+"=?").join(" AND ")+")").join(" OR ")+")",
      params:pairs.flatMap(p=>[p.source_id,p.issuer,p.profile,p.project,p.host,p.source,p.kind])};
  }
  if (scope.missionControlSources !== undefined) {
    ensure(scope.source==="mission-control-reader"&&scope.profile==="mission-control-reader"&&scope.project==="chaldea"&&scope.host==="omarchy-normandy"&&scope.issuer==="chaldea:omarchy-normandy"&&!scope.global&&!scope.quotaFleet&&!scope.routeScores&&Array.isArray(scope.missionControlSources)&&scope.missionControlSources.length>0&&scope.missionControlSources.length<=4&&new Set(scope.missionControlSources).size===scope.missionControlSources.length&&scope.missionControlSources.every(s=>/^(agent-a|agent-b|omarchy-pc|omarchy-macbook-air-igor)--mission-control$/.test(s)), "invalid_mission_control_scope", 403);
    return {sql: "json_extract("+prefix+"envelope,'$.source_id') IN ("+scope.missionControlSources.map(()=>"?").join(",")+") AND "+prefix+"kind=? AND "+prefix+"profile=? AND "+prefix+"project=? AND json_extract("+prefix+"envelope,'$.data.snapshot.schema')=?",
      params:[...scope.missionControlSources,"agent_status","mission-control-publisher","chaldea","mission-control.host.v1"]};
  }
  if (scope.routeScores && scope.source === "route") return {
    sql: prefix + "profile=? AND " + prefix + "project=? AND " + prefix + "source=? AND " + prefix + "host=? AND " + prefix + "kind=?",
    params: [scope.profile, scope.project, "route", "homelab", "route_score_snapshot"],
  };
  if (scope.quotaFleet && scope.source === "quota") return {
    sql: prefix + "profile=? AND " + prefix + "project=? AND " + prefix + "source=? AND " + prefix + "kind=?",
    params: [scope.profile, scope.project, "quota", "quota_headroom_snapshot"],
  };
  return scope.global ? { sql: "1", params: [] } : {
    sql: ["issuer", "profile", "project", "source", "host"].map(k => prefix + k + "=?").join(" AND "),
    params: [scope.issuer, scope.profile, scope.project, scope.source, scope.host],
  };
}
export class EventStore {
  readonly db: DatabaseSync; readonly path: string; readonly budget: Budget;
  alarm: string | null = null;
  private readonly outbox: Outbox<Pending>;
  private readonly receiptWaiters = new Map<string, Set<() => void>>();
  waitReceipt(id: string, milliseconds: number): Promise<void> {
    // Synchronous read + registration cannot race this process's commit path.
    if (this.receipt(id)?.state !== "pending" || milliseconds <= 0) return Promise.resolve();
    return new Promise(resolve => {
      const waiters = this.receiptWaiters.get(id) ?? new Set<() => void>();
      const done = () => {
        clearTimeout(timer); waiters.delete(done);
        if (!waiters.size) this.receiptWaiters.delete(id);
        resolve();
      };
      const timer = setTimeout(done, milliseconds);
      waiters.add(done); this.receiptWaiters.set(id, waiters);
    });
  }
  private receiptCommitted(id: string): void {
    for (const done of this.receiptWaiters.get(id) ?? []) done();
  }
  constructor(path: string, options: { initialize?: boolean; budget?: Partial<Budget> } = {}) {
    ensure(isAbsolute(path), "absolute_database_path_required");
    this.path = path; this.budget = { ...DEFAULT_BUDGET, ...options.budget };
    ensure(this.budget.quarantine >= 256 && this.budget.main >= 4 * 1024 ** 2 && this.budget.wal >= 4 * MAX_ENVELOPE &&
      Object.entries(this.budget).every(([k, n]) => Number.isSafeInteger(n) && n > 0 && n <= DEFAULT_BUDGET[k as keyof Budget]), "invalid_budget");
    this.db = openPrivateDb(path, {
      initialize: options.initialize === true, directoryError: "unsafe_database_directory",
      fileError: "unsafe_database", singleLink: true,
    }, ensure);
    try {
      this.db.exec("PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;");
      if (options.initialize) {
        this.db.exec("PRAGMA page_size=4096; PRAGMA auto_vacuum=INCREMENTAL;");
        migrate(this.db, [() => {
        this.db.exec(`
          CREATE TABLE meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE receipts(event_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,envelope_hash TEXT NOT NULL,
            state TEXT NOT NULL,feed_id INTEGER,issuer TEXT NOT NULL,profile TEXT NOT NULL,project TEXT NOT NULL,
            source TEXT NOT NULL,host TEXT NOT NULL,expires INTEGER NOT NULL);
          CREATE INDEX receipts_expiry ON receipts(expires);
          CREATE UNIQUE INDEX receipts_feed ON receipts(feed_id) WHERE feed_id IS NOT NULL;
          CREATE TABLE outbox(event_id TEXT PRIMARY KEY REFERENCES receipts(event_id),envelope TEXT NOT NULL,
            bytes INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,next_try INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,
            envelope TEXT NOT NULL,issuer TEXT NOT NULL,profile TEXT NOT NULL,project TEXT NOT NULL,source TEXT NOT NULL,
            host TEXT NOT NULL,kind TEXT NOT NULL,received_at TEXT NOT NULL,occurred_at TEXT NOT NULL,
            expiry INTEGER NOT NULL,session TEXT,tool TEXT,client TEXT);
          CREATE INDEX events_received ON events(received_at); CREATE INDEX events_occurred ON events(occurred_at);
          CREATE INDEX events_scope ON events(issuer,profile,project,source,host,seq);
          CREATE INDEX events_filter ON events(host,source,occurred_at);
          CREATE INDEX events_kind_seq ON events(kind,seq);
          CREATE INDEX events_session_seq ON events(session,seq); CREATE INDEX events_tool_seq ON events(tool,seq);
          CREATE INDEX events_client_seq ON events(client,seq); CREATE INDEX events_project_seq ON events(project,seq);
          CREATE INDEX events_source_seq ON events(source,seq); CREATE INDEX events_host_seq ON events(host,seq); CREATE INDEX events_expiry ON events(expiry);
          CREATE TABLE event_tags(event_id TEXT NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
            tag TEXT NOT NULL,PRIMARY KEY(tag,event_id));
          CREATE TABLE feed_entries(id INTEGER PRIMARY KEY,event_id TEXT UNIQUE NOT NULL REFERENCES events(event_id) ON DELETE CASCADE,
            created_at TEXT NOT NULL,host TEXT NOT NULL,source TEXT NOT NULL,severity TEXT NOT NULL,
            title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,link TEXT NOT NULL);
          CREATE INDEX feed_time ON feed_entries(created_at DESC,id DESC);
          CREATE INDEX feed_host_source ON feed_entries(host,source,created_at);
          CREATE INDEX feed_source_time ON feed_entries(source,created_at DESC,id DESC);
          CREATE INDEX feed_host_time ON feed_entries(host,created_at DESC,id DESC);
          CREATE INDEX feed_severity_time ON feed_entries(severity,created_at DESC,id DESC);
          CREATE TABLE cursors(name TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE quarantine(seq INTEGER PRIMARY KEY,reason TEXT NOT NULL,bytes INTEGER NOT NULL,received INTEGER NOT NULL);
          CREATE TABLE import_rejects(id INTEGER PRIMARY KEY,reason TEXT NOT NULL);
          CREATE TABLE deliveries(seq INTEGER PRIMARY KEY);
        `);
        this.put("format", "akasha-v1"); this.put("epoch", randomUUID()); this.put("feed_next", String(NEW_FEED_ID)); this.put("floor", "0");
        }]);
      }
      ensure(this.get("format") === "akasha-v1", "invalid_database_format");
      ensure(this.scalar("PRAGMA page_size") === 4096 && this.scalar("PRAGMA page_count") * 4096 <= this.budget.main, "database_capacity", 503);
      this.db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=64; PRAGMA journal_size_limit=0;");
      this.db.exec("PRAGMA max_page_count=" + Math.floor(this.budget.main / 4096));
      migrate(this.db, [() => {}]);
      // Add query indices on both initialization and reopen. Keep version 1 so
      // the previous runtime can reopen the same receipts database for rollback.
      this.bootstrapReceiptIndices();
    } catch (e) { this.db.close(); throw e; }
    this.outbox = new Outbox(sqliteOutbox(this.db, {
      table: "outbox", key: "event_id", columns: ["event_id", "envelope", "bytes"],
      encode: (p: Pending) => [p.event_id, p.envelope, p.bytes], decode: r => r as unknown as Pending,
    }), "resend");
  }
  private receiptIndexBuild() {
    const missing = RECEIPT_INDICES.filter(index => {
      const schema = this.db.prepare("SELECT type,tbl_name FROM sqlite_schema WHERE name=? COLLATE NOCASE").get(index.name);
      if (!schema) return true;
      const listed = this.db.prepare("PRAGMA index_list(receipts)").all().find(r => String(r.name).toLowerCase() === index.name);
      const keys = this.db.prepare("PRAGMA index_xinfo(" + index.name + ")").all().filter(r => r.key === 1);
      ensure(schema.type === "index" && schema.tbl_name === "receipts" && listed?.unique === 0 && listed.partial === 0 &&
        keys.length === index.columns.length && keys.every((r, i) =>
          r.name === index.columns[i] && r.desc === 0 && r.coll === "BINARY"), "invalid_receipt_index", 503);
      return false;
    });
    if (!missing.length) return { missing, estimate: 0 };
    // Count UTF-8 bytes, not JS characters. 256 bytes per record per index covers
    // record/varint/rowid/cell headers and overflow tail slack. The existing 4x
    // guards then cover B-tree packing/splits and overflow pages. Reserve
    // roots/schema and pointer maps; charge every free page as a possible trunk
    // rather than assuming the existing freelist is densely packed.
    const bytes = this.scalar("SELECT coalesce(sum(" + missing.map(i => "(" + i.bytes + "+256)").join("+") + "),0) FROM receipts");
    const pageBytes = bytes + 8192 * missing.length +
      4096 * (this.scalar("PRAGMA freelist_count") + Math.ceil(this.scalar("PRAGMA page_count") / 512));
    // WAL has a 32-byte header and 24 bytes per page frame, before fixed guard headroom.
    const estimate = pageBytes + Math.ceil(pageBytes / 4096) * 24 + 32;
    ensure(Number.isSafeInteger(bytes) && bytes >= 0 && Number.isSafeInteger(estimate) &&
      estimate <= Math.floor((Number.MAX_SAFE_INTEGER - 256 * 1024) / 4), "receipt_index_capacity", 503);
    return { missing, estimate };
  }
  private bootstrapReceiptIndices(): void {
    const { missing, estimate } = this.receiptIndexBuild();
    if (!missing.length) return; // A populated, already indexed DB pays no build reservation.
    this.capacity(estimate);
    this.transaction(() => {
      // BEGIN IMMEDIATE excludes writers. Recheck after waiting for the lock so
      // a concurrent append/schema change cannot invalidate the preflight bound.
      const locked = this.receiptIndexBuild();
      if (!locked.missing.length) return;
      this.capacity(locked.estimate);
      ensure(locked.estimate <= estimate &&
        this.walBytes() + locked.estimate * 4 + 128 * 1024 < this.budget.wal, "wal_capacity", 503);
      for (const index of locked.missing)
        this.db.exec("CREATE INDEX " + index.name + " ON receipts(" + index.columns.join(",") + ")");
    }, estimate);
  }
  get(name: string): string | undefined { return meta(this.db).get(name); }
  put(name: string, value: string): void { meta(this.db).put(name, value); }
  scalar(sql: string, ...params: SQLInputValue[]): number { return Number(Object.values(this.db.prepare(sql).get(...params)!)[0] ?? 0); }
  walBytes(): number { try { return statSync(this.path + "-wal").size; } catch { return 0; } }
  checkpoint(vacuumPages = 64): void {
    const result = this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number };
    ensure(result.busy === 0, "checkpoint_blocked", 503);
    if (vacuumPages) this.db.exec("PRAGMA incremental_vacuum(" + vacuumPages + ")");
  }
  transaction<T>(fn: () => T, estimate = 2 * MAX_ENVELOPE): T {
    // Every write, including projection/pruning, reserves WAL space first. No long-lived read transactions.
    if (this.walBytes() + estimate * 4 + 128 * 1024 >= this.budget.wal) this.checkpoint();
    ensure(this.walBytes() + estimate * 4 + 128 * 1024 < this.budget.wal, "wal_capacity", 503);
    return tx(this.db, fn);
  }
  capacity(bytes: number, outbox = false): void {
    const used = (this.scalar("PRAGMA page_count") - this.scalar("PRAGMA freelist_count")) * 4096;
    ensure(used + bytes * 4 + 256 * 1024 < this.budget.main, "protected_state_capacity", 503);
    if (outbox) ensure(this.scalar("SELECT coalesce(sum(bytes),0) FROM outbox") + bytes <= this.budget.outbox, "outbox_capacity", 503);
  }
  receipt(id: string): Receipt | undefined { return this.db.prepare("SELECT * FROM receipts WHERE event_id=?").get(id) as unknown as Receipt | undefined; }
  ownedReceipt(id: string, scope: Scope): Receipt | undefined {
    // Receipts never have an operator listing/global override.
    const { missionControlSources: _selector, ...ownScope } = scope;
    const q = scopeSql({ ...ownScope, global: false, quotaFleet: false, routeScores: false });
    return this.db.prepare("SELECT * FROM receipts WHERE event_id=? AND " + q.sql).get(id, ...q.params) as unknown as Receipt | undefined;
  }
  admit(event: Envelope, requestHash: string, now: number, legacyId?: number, guard?: () => void): Receipt {
    const prior = this.receipt(event.event_id);
    if (prior) { ensure(prior.request_hash === requestHash, "idempotency_conflict", 409); return prior; }
    const status = event.kind === "agent_status" && event.data.snapshot !== undefined;
    const needsFeed = event.kind !== "tool_call" && !status;
    const estimate = Buffer.byteLength(canonical(event));
    if (!status && (this.scalar("PRAGMA page_count") - this.scalar("PRAGMA freelist_count")) * 4096 + estimate * 4 + 256 * 1024 >= this.budget.main * 0.85)
      this.prune(now, 10);
    return this.transaction(() => {
      guard?.();
      if (status) {
        const observed = (event.data.snapshot as { observedAt:number }).observedAt;
        ensure(Math.floor(observed/1000) <= now && now*1000-observed <= 120_000, "stale_host_snapshot", 409);
        const priorAdmission=Number(this.get("mission-control-admitted:"+event.source_id)??"-5000");
        ensure(now*1000-priorAdmission>=5_000, "host_snapshot_rate", 429);
        const sample=event.data.snapshot as {epoch:string;sequence:number;observedAt:number},oldSample=this.get("mission-control-sample:"+event.source_id);
        if(oldSample){const old=JSON.parse(oldSample) as typeof sample;ensure(sample.epoch===old.epoch?sample.sequence>old.sequence&&sample.observedAt>=old.observedAt:sample.observedAt>old.observedAt,"host_snapshot_order",409);}
        this.statusCapacity(event,estimate);
        this.put("mission-control-sample:"+event.source_id,JSON.stringify({epoch:sample.epoch,sequence:sample.sequence,observedAt:sample.observedAt}));
        this.put("mission-control-admitted:"+event.source_id,String(now*1000));
      }
      const id = needsFeed ? legacyId ?? Number(this.get("feed_next")) : null;
      ensure(id === null || (Number.isSafeInteger(id) && id > 0 && id < Number.MAX_SAFE_INTEGER), "feed_id_exhaustion", 503);
      if (legacyId !== undefined) ensure(legacyId < NEW_FEED_ID, "legacy_id_range", 409);
      if (id !== null) ensure(!this.db.prepare("SELECT 1 FROM receipts WHERE feed_id=?").get(id), "feed_id_collision", 409);
      if (event.provenance.type === "verified") event = { ...event, provenance: { type: "verified", request_hash: requestHash, feed_id: id } };
      const envelope = canonical(event), bytes = Buffer.byteLength(envelope);
      ensure(bytes <= (event.kind === "feed_post" ? MAX_ENVELOPE : 64 * 1024), "event_too_large", 413);
      this.capacity(bytes, true);
      this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(event.event_id, requestHash, hash(event),
        "pending", id, event.issuer, event.profile, event.project, event.source, event.host, now + (status ? DAY : 180 * DAY));
      this.outbox.enqueue(event.event_id, { event_id: event.event_id, envelope, bytes, attempts: 0 });
      if (id !== null && legacyId === undefined) this.put("feed_next", String(id + 1));
      guard?.(); return this.receipt(event.event_id)!;
    });
  }
  private statusCapacity(e:Envelope,bytes:number):void {
    const usage=(source?:string)=>this.scalar("SELECT coalesce(sum(length(CAST(envelope AS BLOB))),0) FROM events WHERE kind='agent_status' AND json_extract(envelope,'$.data.snapshot.schema')='mission-control.host.v1'"+(source?" AND json_extract(envelope,'$.source_id')=?":""),...(source?[source]:[]))+
      this.scalar("SELECT coalesce(sum(bytes),0) FROM outbox JOIN receipts USING(event_id) WHERE profile='mission-control-publisher' AND project='chaldea'"+(source?" AND source=?":""),...(source?[e.source]:[]))+
      512*this.scalar("SELECT count(*) FROM receipts WHERE profile='mission-control-publisher' AND project='chaldea'"+(source?" AND source=?":""),...(source?[e.source]:[]));
    ensure(usage(e.source_id)+bytes+512<=64*1024**2&&usage()+bytes+512<=128*1024**2,"host_status_capacity",503);
  }
  pending(now: number, limit = 100): Pending[] {
    return this.db.prepare("SELECT event_id,envelope,bytes,attempts FROM outbox WHERE next_try<=? ORDER BY rowid LIMIT ?").all(now, limit) as unknown as Pending[];
  }
  attempted(id: string, now: number, delay: number): void {
    this.transaction(() => this.db.prepare("UPDATE outbox SET attempts=attempts+1,next_try=? WHERE event_id=?").run(now + delay, id), 8192);
  }
  project(raw: unknown, streamSeq: number, now: number): void {
    const e = validateEnvelope(raw), envelopeHash = hash(e);
    this.transaction(() => {
      let r = this.receipt(e.event_id);
      if (r) ensure(r.envelope_hash === envelopeHash, "broker_payload_conflict", 409);
      else {
        // Broker retention exceeds compact receipt retention. Old status replay
        // advances only the cursor; it must not reconstruct payload or receipt.
        if (e.kind==="agent_status"&&e.data.snapshot!==undefined&&Math.floor(Date.parse(e.received_at)/1000)+DAY<=now){this.completeSequence(streamSeq);return;}
        // Restore replay can reconstruct a missing receipt from trusted, immutable provenance.
        const p = e.provenance;
        const feedId = p.type === "legacy-feed" ? p.legacy_id : p.feed_id;
        this.capacity(Buffer.byteLength(canonical(e)));
        if (feedId !== null) {
          ensure(feedId < NEW_FEED_ID || feedId < Number(this.get("feed_next")) + 10_000_000, "replay_allocator_jump", 409);
          ensure(!this.db.prepare("SELECT 1 FROM receipts WHERE feed_id=?").get(feedId), "feed_id_collision", 409);
        }
        this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(e.event_id,
          p.request_hash, envelopeHash, "pending", feedId,
          e.issuer, e.profile, e.project, e.source, e.host, Math.floor(Date.parse(e.received_at) / 1000) + (e.kind === "agent_status" && e.data.snapshot !== undefined ? DAY : 180 * DAY));
        if (feedId !== null && feedId >= Number(this.get("feed_next"))) this.put("feed_next", String(feedId + 1));
        r = this.receipt(e.event_id)!;
      }
      if (r.state === "pending") {
        const status = e.kind === "agent_status" && e.data.snapshot !== undefined;
        const original = e.kind === "tool_call" || e.provenance.type === "legacy-feed" ? e.occurred_at : e.received_at;
        // Producer timestamps cannot extend retention beyond the original server admission.
        const expiryBase = Math.min(Math.floor(Date.parse(original) / 1000), Math.floor(Date.parse(e.received_at) / 1000));
        const expiry = status ? Math.min(expiryBase,Math.floor((e.data.snapshot as {observedAt:number}).observedAt/1000))+3600 : expiryBase + (e.kind === "tool_call" ? 90 : 180) * DAY;
        if (expiry > now) {
          this.capacity(Buffer.byteLength(canonical(e)));
          if (status) this.statusCapacity(e,Buffer.byteLength(canonical(e)));
          this.db.prepare("INSERT OR IGNORE INTO events(event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry,session,tool,client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
            .run(e.event_id, canonical(e), e.issuer, e.profile, e.project, e.source, e.host, e.kind,
              e.received_at, e.occurred_at, expiry, String(e.data.session ?? ""), String(e.data.tool ?? ""), String(e.data.client ?? ""));
          for (const tag of e.tags) this.db.prepare("INSERT OR IGNORE INTO event_tags VALUES(?,?)").run(e.event_id, tag);
          if (r.feed_id !== null) {
            const p = e.provenance;
            this.db.prepare("INSERT INTO feed_entries VALUES(?,?,?,?,?,?,?,?,?,?)").run(r.feed_id, e.event_id,
              p.type === "legacy-feed" ? e.occurred_at : e.received_at,
              p.type === "legacy-feed" ? p.display_host : e.host, p.type === "legacy-feed" ? p.display_source : e.source,
              e.severity, e.title, e.body, e.tags.join(","), e.link);
          }
        }
        this.db.prepare("UPDATE receipts SET state=? WHERE event_id=?").run(expiry > now ? "visible" : "tombstone", e.event_id);
      }
      this.outbox.discard(e.event_id);
      this.completeSequence(streamSeq);
    });
    this.receiptCommitted(e.event_id);
  }
  cursor(name: string): number { return Number((this.db.prepare("SELECT value FROM cursors WHERE name=?").get(name) as { value: string } | undefined)?.value ?? 0); }
  setCursor(name: string, value: number): void { this.db.prepare("INSERT INTO cursors VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(name, String(value)); }
  completeSequence(seq: number): void {
    let cursor = this.cursor("nats");
    if (seq <= cursor) return;
    this.db.prepare("INSERT OR IGNORE INTO deliveries VALUES(?)").run(seq);
    while (this.db.prepare("SELECT 1 FROM deliveries WHERE seq=?").get(cursor + 1)) cursor++;
    this.setCursor("nats", cursor); this.db.prepare("DELETE FROM deliveries WHERE seq<=?").run(cursor);
  }
  rejectImport(id: number, reason: string): void {
    this.transaction(() => {
      ensure(this.scalar("SELECT count(*) FROM import_rejects") < 10000 || this.db.prepare("SELECT 1 FROM import_rejects WHERE id=?").get(id), "import_reject_capacity", 503);
      this.db.prepare("INSERT OR IGNORE INTO import_rejects VALUES(?,?)").run(id, reason.slice(0, 80));
      this.setCursor("legacy:feedd", id);
    }, 8192);
  }
  quarantine(seq: number, reason: string, now: number, raw?: unknown): void {
    this.transaction(() => {
      const bytes = 256;
      while (this.scalar("SELECT coalesce(sum(bytes),0) FROM quarantine") + bytes > this.budget.quarantine)
        this.db.prepare("DELETE FROM quarantine WHERE seq=(SELECT seq FROM quarantine ORDER BY received,seq LIMIT 1)").run();
      this.capacity(bytes);
      this.db.prepare("INSERT OR IGNORE INTO quarantine VALUES(?,?,?,?)").run(seq, reason.slice(0, 80), bytes, now);
      this.completeSequence(seq);
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        const id = (raw as Record<string, unknown>).event_id;
        if (typeof id === "string") {
          const receipt = this.receipt(id);
          if (reason !== "subject_mismatch" && receipt?.state === "pending" && receipt.envelope_hash === hash(raw)) {
            this.db.prepare("UPDATE receipts SET state=\'quarantined\' WHERE event_id=?").run(id);
            this.db.prepare("DELETE FROM outbox WHERE event_id=?").run(id);
          }
        }
      }
      this.put("quarantine_alarm", "true"); this.alarm = "quarantined_message";
    });
    if (raw && typeof raw === "object" && "event_id" in raw && typeof raw.event_id === "string" &&
        this.receipt(raw.event_id)?.state !== "pending") this.receiptCommitted(raw.event_id);
  }
  feed(id: number, scope: Scope): FeedRow | undefined {
    const q = scopeSql(scope, "e.");
    return this.db.prepare("SELECT f.id,f.created_at,f.host,f.source,f.severity,f.title,f.body,f.tags,f.link FROM feed_entries f JOIN events e USING(event_id) WHERE f.id=? AND " + q.sql)
      .get(id, ...q.params) as unknown as FeedRow | undefined;
  }
  /**
   * Prune-only page estimate. dbstat stops at the first leaf of each named tree;
   * all B-tree leaves have the same depth. The 4x transaction guard covers sibling
   * balancing, freelist/pointer-map writes and frame headers on those paths.
   * Charge overflow separately, including both event and feed payload copies.
   */
  private pruneEstimate(changes: { table: string; rows: number; deleting?: boolean; stateOnly?: boolean }[], bytes: number, depths: Map<string, { depth: number; pages: number }[]>): number {
    let paths = 0;
    const pointerMaps = Math.ceil(this.scalar("PRAGMA page_count") / 512);
    for (const { table, rows, deleting, stateOnly } of changes) {
      if (!rows) continue;
      const key = table + (stateOnly ? ":state" : "");
      if (!depths.has(key)) {
        depths.set(key, this.db.prepare("SELECT name,type FROM sqlite_schema WHERE (type='table' AND name=?) OR (type='index' AND tbl_name=?)").all(table, table).filter(object =>
          !stateOnly || object.type === "table" ||
          this.db.prepare("SELECT name FROM pragma_index_info(?)").all(object.name!).some(column => column.name === "state")
        ).map(object => {
          const leaf = this.db.prepare("SELECT path FROM dbstat WHERE name=? AND pagetype='leaf' LIMIT 1").get(object.name!);
          ensure(leaf && typeof leaf.path === "string", "prune_page_estimate", 503);
          // Cap the metadata walk at 65 pages. Small trees can be reserved in
          // full; large ones use the per-row paths, without a full dbstat scan.
          const pages = this.scalar("SELECT count(*) FROM (SELECT pageno FROM dbstat WHERE name=? LIMIT 65)", object.name!);
          return { depth: (leaf.path as string).split("/").length - 1, pages };
        }));
      }
      // A one-page tree is shared by every row in the batch.
      for (const { depth, pages } of depths.get(key)!) {
        const rowPaths = depth === 1 ? (deleting ? 0.25 : 1) : depth * rows;
        // Deletions can use the whole small tree plus pointer maps and eight
        // balancing pages. Updates can split scattered pages, so keep paths.
        paths += deleting && pages <= 64
          ? Math.min(rowPaths, (pages + Math.min(pages, pointerMaps) + 8) / 4)
          : rowPaths;
      }
    }
    // 4092 usable bytes on overflow pages; 1030 * 4 is one WAL frame.
    return Math.ceil(paths * 4120 + Math.ceil(bytes / 4092) * 1030 + 8192);
  }
  private pruneTransaction(fn: () => void, estimate: number): void {
    // Keep a dirty page to one WAL frame at commit, rather than letting cache
    // pressure spill and redirty it repeatedly inside the bounded batch.
    const spill = this.scalar("PRAGMA cache_spill");
    this.db.exec("PRAGMA cache_spill=OFF");
    try {
      // Prune reserves its own vacuum below. Do not let the shared guard add
      // an unreserved incremental_vacuum(64) while making room for this batch.
      if (this.walBytes() + estimate * 4 + 128 * 1024 >= this.budget.wal) this.checkpoint(0);
      ensure(this.walBytes() + estimate * 4 + 128 * 1024 < this.budget.wal, "wal_capacity", 503);
      this.transaction(fn, estimate);
    } finally { this.db.exec("PRAGMA cache_spill=" + spill); }
  }
  private pruneTags(victims: { seq: number }[], depths: Map<string, { depth: number; pages: number }[]>, fits: (estimate: number) => boolean): void {
    const select = this.db.prepare(PRUNE_TAG_ROWS);
    const remove = this.db.prepare("DELETE FROM event_tags WHERE tag=? AND event_id=?");
    let chunk: { tag: string; event_id: string }[] = [], bytes = 0, estimate = 0;
    const flush = () => {
      if (chunk.length) this.pruneTransaction(() => {
        for (const row of chunk) remove.run(row.tag, row.event_id);
      }, estimate);
      chunk = []; bytes = 0; estimate = 0;
    };
    // event_tags is an unread copy; envelopes and feed tags stay visible until
    // the atomic event transaction. A refusal/crash can safely leave this partial.
    for (const victim of victims) {
      const rows = select.all(victim.seq) as { tag: string; event_id: string }[];
      for (const row of rows) {
        const size = 256 + 2 * Buffer.byteLength(row.event_id) + 2 * (Buffer.byteLength(row.tag) + 3);
        let next = this.pruneEstimate([{ table: "event_tags", rows: chunk.length + 1, deleting: true }], bytes + size, depths);
        if (chunk.length && !fits(next)) {
          flush();
          next = this.pruneEstimate([{ table: "event_tags", rows: 1, deleting: true }], size, depths);
        }
        // Always try the first row: the unchanged guard must refuse an oversized
        // step, rather than silently skipping it and permitting an event cascade.
        chunk.push(row); bytes += size; estimate = next;
      }
    }
    flush();
  }
  prune(now: number, max = 100): number {
    ensure(Number.isInteger(max) && max > 0 && max <= 100, "invalid_prune_batch");
    type Victim = { seq: number; event_id: string };
    const depths = new Map<string, { depth: number; pages: number }[]>();
    const fits = (estimate: number) => estimate * 4 + 128 * 1024 < this.budget.wal;
    // JSON encoding overcounts escaping; repeated fields charge every receipt
    // index key as well as the table record. Include record/varint overhead.
    const receiptBytes = this.db.prepare(`SELECT 512+length(CAST(json_array(
      event_id,event_id,request_hash,envelope_hash,state,state,feed_id,feed_id,
      issuer,profile,profile,project,project,source,source,host,expires,expires,expires
    ) AS BLOB)) AS bytes FROM receipts WHERE event_id=?`);
    // Two index-ordered selections: never CASE/OR over the whole retained table.
    let candidates = this.db.prepare("SELECT seq,event_id FROM events WHERE expiry<=? ORDER BY expiry,seq LIMIT ?")
      .all(now, max) as unknown as Victim[];
    const pressure = (this.scalar("PRAGMA page_count") - this.scalar("PRAGMA freelist_count")) * 4096 > this.budget.main * 0.85;
    if (!candidates.length && pressure) candidates = this.db.prepare(
      "SELECT seq,event_id FROM events ORDER BY received_at,seq LIMIT ?").all(max) as unknown as Victim[];
    const eventBytes = this.db.prepare(`SELECT
      length(CAST(envelope AS BLOB))+512+length(CAST(json_array(
        event_id,event_id,issuer,issuer,profile,profile,project,project,project,
        source,source,source,source,host,host,host,host,kind,kind,received_at,received_at,
        occurred_at,occurred_at,occurred_at,expiry,expiry,session,session,tool,tool,client,client
      ) AS BLOB)) AS bytes
      FROM events WHERE seq=?`);
    const feedBytes = this.db.prepare(`SELECT length(CAST(body AS BLOB))+512+
      length(CAST(json_array(event_id,event_id,created_at,created_at,created_at,created_at,created_at,created_at,
        host,host,host,source,source,source,severity,severity,title,tags,link) AS BLOB)) AS bytes
      FROM feed_entries WHERE event_id=?`);
    const victims: Victim[] = []; let bytes = 0, feeds = 0, estimate = 0;
    for (const row of candidates) {
      const event = eventBytes.get(row.seq)!;
      const feed = feedBytes.get(row.event_id);
      const nextBytes = bytes + Number(event.bytes) +
        Number(feed?.bytes ?? 0) + Number(receiptBytes.get(row.event_id)?.bytes ?? 0);
      const nextFeeds = feeds + Number(!!feed);
      const next = this.pruneEstimate([
        { table: "events", rows: victims.length + 1, deleting: true }, { table: "receipts", rows: victims.length + 1, stateOnly: true },
        { table: "feed_entries", rows: nextFeeds, deleting: true },
        { table: "meta", rows: 1 },
      ], nextBytes, depths);
      if (victims.length && (!fits(next) || nextBytes > 1024 ** 2)) break;
      victims.push(row); bytes = nextBytes; feeds = nextFeeds; estimate = next;
    }
    this.pruneTags(victims, depths, fits);
    if (victims.length) this.pruneTransaction(() => {
      // Check under BEGIN IMMEDIATE before any visible deletion/tombstoning.
      const tags = this.db.prepare(PRUNE_TAG_ROWS);
      for (const row of victims) ensure(!tags.get(row.seq), "prune_page_estimate", 503);
      let floor = Number(this.get("floor"));
      for (const row of victims) {
        this.db.prepare("UPDATE receipts SET state='tombstone' WHERE event_id=?").run(row.event_id);
        this.db.prepare("DELETE FROM events WHERE seq=?").run(row.seq); floor = Math.max(floor, row.seq);
      }
      this.put("floor", String(floor));
    }, estimate);
    const receipts = this.db.prepare("SELECT event_id FROM receipts WHERE state IN ('tombstone','quarantined') AND expires<=? LIMIT ?")
      .all(now, max);
    const expired: string[] = []; bytes = 0; estimate = 0;
    // Event deletion may have changed tree depth. Refresh before receipt deletion.
    depths.clear();
    for (const row of receipts) {
      const nextBytes = bytes + Number(receiptBytes.get(row.event_id!)!.bytes);
      const next = this.pruneEstimate([{ table: "receipts", rows: expired.length + 1, deleting: true }], nextBytes, depths);
      if (expired.length && !fits(next)) break;
      expired.push(row.event_id as string); bytes = nextBytes; estimate = next;
    }
    if (expired.length) this.pruneTransaction(() => {
      for (const id of expired) this.db.prepare("DELETE FROM receipts WHERE event_id=?").run(id);
    }, estimate);
    this.checkpoint(0);
    // One vacuum step moves at most one page. Reserve its parent/freelist and
    // every possible pointer-map page, since an internal page can have scattered
    // children. If this does not fit, free pages remain reusable by SQLite.
    if (this.scalar("PRAGMA freelist_count")) {
      const vacuum = Math.ceil((Math.ceil(this.scalar("PRAGMA page_count") / 512) + 8) * 4120 / 4);
      if (fits(vacuum)) this.pruneTransaction(() => this.db.exec("PRAGMA incremental_vacuum(1)"), vacuum);
    }
    return victims.length + expired.length;
  }
  recordGap(from: number, to: number): void {
    this.transaction(() => {
      if (!this.get("first_gap")) this.put("first_gap", JSON.stringify({ from, to }));
      this.setCursor("nats", Math.max(this.cursor("nats"), to));
      this.db.prepare("DELETE FROM deliveries WHERE seq<=?").run(to);
    }, 8192);
    this.alarm = "stream_gap";
  }
  health(): Record<string, unknown> {
    return { alarm: this.alarm, first_gap: this.get("first_gap") ? JSON.parse(this.get("first_gap")!) : null,
      replay_required: this.get("exhausted_first") ? Number(this.get("exhausted_first")) : null,
      quarantined: this.scalar("SELECT count(*) FROM quarantine"), pending: this.scalar("SELECT count(*) FROM outbox"),
      pending_bytes: this.scalar("SELECT coalesce(sum(bytes),0) FROM outbox"), wal_bytes: this.walBytes(),
      main_bytes: this.scalar("PRAGMA page_count") * 4096, cursor: this.cursor("nats") };
  }
  close(): void { this.db.close(); }
}
