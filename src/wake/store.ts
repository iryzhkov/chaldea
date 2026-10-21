// Single writer, transactional journal shared by waits and decisions.
import type { DatabaseSync } from "node:sqlite";
import type { ExternalWakeGuard } from "../t3/waits.ts";
import { openDb, tx, meta, migrate } from "../store/sqlite.ts";
import { recoverOutbox } from "../store/outbox.ts";
import { ownDatabase } from "./owner.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_AGE, validate, waitDescription, text, type WaitInput, type Input, type DecisionInput, type Outcome, type AnswerSource } from "../waits/types.ts";
import { SessionRefusal } from "../session/policy.ts";
import { sessionWake, type SessionOutcome } from "../session/result.ts";

export interface Item {
  id: string; kind: "wait" | "decision" | "native" | "session"; parent: string; project: string; request_key: string; request_at: number;
  wake_guard: string|null;
  hash: string; input: string; deadline: number; target_run: string | null; cursor: number;
  state: "parked" | "resolved" | "cancelled" | "orphaned" | "needs_attention"; disposition: string | null;
  outcome: string | null; created: number; terminal: number | null;
}
export interface Delivery {
  id: string; item: string; batch_id: string | null; channel: "wake" | "native"; payload: string;
  state: "pending" | "sending" | "sent" | "suppressed" | "blocked" | "uncertain"; disposition: string | null; attempts: number; next_at: number; expires: number | null;
}
export interface NativePolicy { item: string; request_id: string | null; bind_until: number; baseline: string; questions: string|null; turn_item:string|null; created?:number }
export interface Registration { id: string; kind: Item["kind"]; input: Input; deadline: number; requestAt: number; hash: string }
/** Launch: intent (nothing sent) -> dispatching -> accepted | rejected | uncertain | mismatch.
 * Occupancy is the preset's runtime slot. It is released only by T3 evidence that the
 * session thread stopped (or never started), never by a logical deadline or cancellation. */
export interface SessionRecord {
  item: string; preset: string; preset_hash: string; admission: string; thread_id: string; command_id: string; message_id: string;
  t3_project: string; payload: string; launch: "intent" | "dispatching" | "accepted" | "rejected" | "uncertain" | "mismatch";
  launch_detail: string | null; root_run: string | null; result: string | null; result_state: string | null; result_bytes: number | null;
  occupancy: "held" | "released"; released: string | null; released_at: number | null;
}
export interface SessionRegistration {
  id: string; requestId: string; requestAt: number; hash: string; input: unknown; parent: string; project: string; deadline: number;
  preset: string; presetHash: string; admission: string; threadId: string; commandId: string; messageId: string; t3Project: string; payload: string;
}
export const MAX_ACTIVE_SESSIONS = 4;
const DB_LIMIT = 64 * 1024 * 1024;
function waitSummary(row: Item, outcome: Outcome): string {
  const context = waitDescription(JSON.parse(row.input) as WaitInput, row.target_run);
  const result = outcome.reason === "time" ? "target time reached"
    : outcome.reason === "timeout" ? "wait deadline reached"
    : outcome.reason === "target_deleted" ? "target thread deleted"
    : "target run " + outcome.reason.replaceAll("_", " ");
  return "Context: " + JSON.stringify(context) + "; " + result + "; " + JSON.stringify(outcome);
}
export class CheckpointBlockedError extends Error {
  constructor() { super("WAL checkpoint blocked; work retained for retry"); this.name="CheckpointBlockedError"; }
}
export class WakeStore {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly environment: string;
  private releaseOwner: () => void;
  constructor(path: string, environment: string) {
    this.path = path; this.environment = environment;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.releaseOwner=ownDatabase(path);
    try { this.db = openDb(path); } catch(error) { this.releaseOwner();throw error; }
    try {
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000; PRAGMA max_page_count=7936; PRAGMA cache_spill=OFF; PRAGMA journal_size_limit=0;`);
    migrate(this.db, [() => {
    this.db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT NOT NULL, project TEXT NOT NULL,
        request_key TEXT UNIQUE NOT NULL, request_at INTEGER NOT NULL, hash TEXT NOT NULL,
        input TEXT NOT NULL, deadline INTEGER NOT NULL, target_run TEXT, cursor INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, disposition TEXT, outcome TEXT, created INTEGER NOT NULL, terminal INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires INTEGER, disposition TEXT,
        UNIQUE(item,channel));
      CREATE TABLE IF NOT EXISTS native_decisions(
        item TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE,
        request_id TEXT UNIQUE, bind_until INTEGER NOT NULL, baseline TEXT NOT NULL, questions TEXT, turn_item TEXT);
      CREATE INDEX IF NOT EXISTS items_state ON items(state,deadline);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state,next_at);
    `);
    if (!(this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{name:string}>).some(c=>c.name==="disposition"))
      this.db.exec("ALTER TABLE outbox ADD COLUMN disposition TEXT");
    if (!(this.db.prepare("PRAGMA table_info(native_decisions)").all() as Array<{name:string}>).some(c=>c.name==="questions"))
      this.db.exec("ALTER TABLE native_decisions ADD COLUMN questions TEXT");
    if (!(this.db.prepare("PRAGMA table_info(native_decisions)").all() as Array<{name:string}>).some(c=>c.name==="turn_item"))
      this.db.exec("ALTER TABLE native_decisions ADD COLUMN turn_item TEXT");
    if (!(this.db.prepare("PRAGMA table_info(outbox)").all() as Array<{name:string}>).some(c=>c.name==="batch_id"))
      this.db.exec("ALTER TABLE outbox ADD COLUMN batch_id TEXT");
    }]);
    // Additive and idempotent outside user_version, so a rollback that never used
    // sessions still opens this journal. Retention never prunes a held slot.
    this.db.exec(`CREATE TABLE IF NOT EXISTS sessions(
        item TEXT PRIMARY KEY REFERENCES items(id) ON DELETE CASCADE, preset TEXT NOT NULL, preset_hash TEXT NOT NULL,
        admission TEXT NOT NULL, thread_id TEXT UNIQUE NOT NULL, command_id TEXT UNIQUE NOT NULL, message_id TEXT UNIQUE NOT NULL,
        t3_project TEXT NOT NULL, payload TEXT NOT NULL, launch TEXT NOT NULL, launch_detail TEXT, root_run TEXT,
        result TEXT, result_state TEXT, result_bytes INTEGER, occupancy TEXT NOT NULL, released TEXT, released_at INTEGER);
      CREATE INDEX IF NOT EXISTS sessions_held ON sessions(occupancy,preset);`);
    // Unknown pre-guard registrations remain unknown. Never backfill them from a later snapshot.
    if (!(this.db.prepare("PRAGMA table_info(items)").all() as Array<{name:string}>).some(c=>c.name==="wake_guard"))
      this.db.exec("ALTER TABLE items ADD COLUMN wake_guard TEXT");
    const env = this.meta("environment");
    if (env && env !== environment) throw new Error("Wake database belongs to another environment");
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('environment',?)").run(environment);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('replay_fence','0')").run();
    // Remove the retired notification channel before replaying any delivery.
    // The outbox uses unconstrained TEXT channels, so no table rebuild is needed.
    this.db.prepare("DELETE FROM outbox WHERE channel='phone'").run();
    // 'sending' means an ambiguous RPC after restart. Retry the identical stored payload.
    recoverOutbox(this.db, "resend");
    try { this.maintain(Date.now()); } catch(error) { if (!(error instanceof CheckpointBlockedError)) throw error; }
    } catch(error) { this.db.close(); this.releaseOwner(); throw error; }
  }
  meta(key: string): string | undefined { return meta(this.db, "meta", "key").get(key); }
  transaction<T>(body: () => T): T {
    // Refuse another write if an external reader prevents truncation. Disabling
    // cache spill bounds a transaction to one WAL frame per dirty page; 31 MiB
    // main + WAL frame headers fits below the shared 64 MiB physical cap.
    if (!this.checkpoint()) throw new CheckpointBlockedError();
    try { return tx(this.db, body); }
    finally { this.checkpoint(); }
  }
  private checkpoint(): boolean {
    // A long-lived external reader must not stall the event loop for busy_timeout.
    this.db.exec("PRAGMA busy_timeout=0");
    try {
      const result=this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as {busy:number};
      return result.busy === 0;
    } catch(error) {
      if ([5,6].includes((error as {errcode:number}).errcode)) return false;
      throw error;
    } finally { this.db.exec("PRAGMA busy_timeout=5000"); }
  }
  bytes(): number {
    return [this.path, this.path + "-wal"].reduce((sum, p) => { try { return sum + statSync(p).size; } catch { return sum; } }, 0);
  }
  prepare(kind: Exclude<Item["kind"], "session">, value: unknown, now = Date.now()): Registration {
    const {input, deadline, requestAt} = validate(kind, value, now);
    const hash = createHash("sha256").update(JSON.stringify({kind,input})).digest("hex");
    return {id: randomUUID(), kind, input, deadline, requestAt, hash};
  }
  existing(reg: Registration): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE request_key=?").get(reg.input.requestId) as Item|undefined;
    if (row && row.hash !== reg.hash) throw new Error("requestId reused with changed payload");
    return row;
  }
  register(reg: Registration, project: string, targetRun: string | null, now = Date.now(), nativeBaseline: string[] = [], nativeQuestions:string|null=null, nativeItem:string|null=null, wakeGuard?:ExternalWakeGuard): Item {
    return this.transaction(() => {
      const existing = this.existing(reg); if (existing) return existing;
      if (reg.requestAt <= Number(this.meta("replay_fence"))) throw new Error("requestId retired by retention fence");
      if (this.bytes() > DB_LIMIT - 1024 * 1024) throw new Error("Disk pressure: registration parked");
      const count = (this.db.prepare("SELECT count(*) AS n FROM items WHERE state='parked' AND (CASE WHEN kind='wait' THEN 'wait' WHEN kind='session' THEN 'session' ELSE 'decision' END)=?").get(reg.kind === "wait" ? "wait" : "decision") as {n:number}).n;
      if (count >= 128) throw new Error("Active " + reg.kind + " limit (128)");
      if (reg.kind === "native") {
        const preparing=this.db.prepare("SELECT i.id FROM items i JOIN native_decisions n ON n.item=i.id WHERE i.parent=? AND i.state='parked' AND n.request_id IS NULL").get(reg.input.threadId);
        if (preparing) throw new Error("A native preparation is already waiting on this thread");
        if ("runtimeRequestId" in reg.input && reg.input.runtimeRequestId &&
            this.db.prepare("SELECT item FROM native_decisions WHERE request_id=?").get(reg.input.runtimeRequestId))
          throw new Error("Runtime request is already tracked");
        if (nativeQuestions && Buffer.byteLength(nativeQuestions)>4096)throw new Error("Native question schema exceeds cap");
        if (nativeBaseline.length > 128 || Buffer.byteLength(JSON.stringify(nativeBaseline))>4096)
          throw new Error("Recent native request baseline exceeds cap");
      }
      const waits = this.active().filter(i => i.kind === "wait");
      if (reg.kind === "wait" && waits.filter(i => i.parent === reg.input.threadId).length >= 8)
        throw new Error("Active wait limit (8) per thread; cancel or resolve a wait before registering another");
      if ("condition" in reg.input && reg.input.condition.kind === "thread") {
        const edges = new Map<string,string[]>();
        for (const wait of waits) {
          const c = (JSON.parse(wait.input) as {condition: {kind:string; threadId?:string}}).condition;
          if (c.kind === "thread" && c.threadId) edges.set(wait.parent,[...(edges.get(wait.parent) ?? []),c.threadId]);
        }
        const pending = [reg.input.condition.threadId], visited = new Set<string>();
        while (pending.length) {
          const target = pending.pop()!;
          if (target === reg.input.threadId) throw new Error("Dependency cycle");
          if (visited.has(target)) continue;
          visited.add(target);
          pending.push(...(edges.get(target) ?? []));
        }
      }
      this.db.prepare("INSERT INTO items(id,kind,parent,project,request_key,request_at,hash,input,deadline,target_run,state,created) VALUES(?,?,?,?,?,?,?,?,?,?,'parked',?)")
        .run(reg.id,reg.kind,reg.input.threadId,project,reg.input.requestId,reg.requestAt,reg.hash,JSON.stringify(reg.input),reg.deadline,targetRun,now);
      if (wakeGuard) this.db.prepare("UPDATE items SET wake_guard=? WHERE id=?").run(JSON.stringify(wakeGuard),reg.id);
      if (reg.kind === "native") this.db.prepare("INSERT INTO native_decisions(item,request_id,bind_until,baseline,questions,turn_item) VALUES(?,?,?,?,?,?)")
        .run(reg.id,"runtimeRequestId" in reg.input ? reg.input.runtimeRequestId ?? null : null,
          Math.min(reg.deadline,now+10*60_000),JSON.stringify(nativeBaseline),nativeQuestions,nativeItem);
      return this.get(reg.id);
    });
  }
  get(id: string): Item {
    const row = this.db.prepare("SELECT * FROM items WHERE id=?").get(id) as Item|undefined;
    if (!row) throw new Error("Unknown item"); return row;
  }
  active(): Item[] { return this.db.prepare("SELECT * FROM items WHERE state='parked'").all() as unknown as Item[]; }
  outstanding(): Item[] {
    return this.db.prepare("SELECT * FROM items WHERE state='parked' OR id IN (SELECT item FROM outbox WHERE channel='wake' AND state IN ('pending','sending','blocked'))").all() as unknown as Item[];
  }
  decisions(): Item[] { return this.db.prepare("SELECT * FROM items WHERE kind='decision' ORDER BY created DESC LIMIT 256").all() as unknown as Item[]; }
  deliveries(): Delivery[] { return this.db.prepare("SELECT * FROM outbox ORDER BY next_at,id").all() as unknown as Delivery[]; }
  resolve(id: string, outcome: Outcome, cursor?: number, now = Date.now()): Item {
    return this.transaction(() => this.resolveLocked(this.get(id), outcome, now, cursor));
  }
  private resolveLocked(row: Item, outcome: Outcome, now: number, cursor?: number): Item {
      const id = row.id;
      if (cursor !== undefined) this.db.prepare("UPDATE items SET cursor=max(cursor,?) WHERE id=?").run(cursor,id);
      if (row.state !== "parked") return this.get(id);
      const label = row.kind === "wait" ? "wait" : "decision";
      const commandId = "chaldea-" + label + ":" + id + ":wake";
      const input = JSON.parse(row.input) as DecisionInput;
      const summary = row.kind === "decision" && outcome.reason === "deadline"
        ? "no answer by the deadline: " + outcome.action + " " + (input.dependentAction ?? input.question)
        : row.kind === "native"
          ? "native question needs attention (" + outcome.detail + "); no safe automatic answer confirmed. " + outcome.action + " " + input.dependentAction + ". Answer in T3."
          : row.kind === "wait" ? waitSummary(row,outcome) : JSON.stringify(outcome);
      const text = "Chaldea wake (" + label + " " + id + "): " + summary + "\nchaldea " + label + " status " + id;
      const payload = JSON.stringify({
        type:"message.dispatch",commandId,messageId:commandId,threadId:row.parent,
        ...(row.wake_guard===null?{}:{externalWake:JSON.parse(row.wake_guard)}),
        createdBy:"agent",creationSource:"server",attachments:[],dispatchMode:{type:"queue_after_active"},
        text,
      });
      if (Buffer.byteLength(payload) > 4096) throw new Error("Wake exceeds 4 KiB");
      this.db.prepare("UPDATE items SET state='resolved',outcome=?,terminal=? WHERE id=?").run(JSON.stringify(outcome),now,id);
      this.db.prepare("INSERT INTO outbox(id,item,channel,payload,state,next_at) VALUES(?,?,'wake',?,'pending',?)").run(commandId,id,payload,now);
      return this.get(id);
  }
  answer(id: string, answer: string, source: AnswerSource, now?: number): Item {
    if (source !== "page" && source !== "cli" && !(typeof source === "string" && /^mcp:.+/.test(source)))
      throw new Error("Answer source required");
    // Read the clock after acquiring the writer lock: contention cannot extend a deadline.
    return this.transaction(() => this.answerLocked(id,answer,source,now ?? Date.now()));
  }
  expire(id: string, now = Date.now()): Item {
    return this.transaction(() => this.answerLocked(id,undefined,undefined,now));
  }
  private answerLocked(id: string, answer: string | undefined, source: AnswerSource | undefined, now: number): Item {
    const row = this.get(id);
    if (row.kind !== "decision") throw new Error("Not a decision");
    if (source === "mcp:" + row.parent) throw new Error("Asking thread cannot answer its own decision");
    const input = JSON.parse(row.input) as DecisionInput;
    if (answer !== undefined && !input.options.includes(answer)) throw new Error("Answer must be one of the options");
    if (row.state !== "parked") return row;
    if (now >= row.deadline) return this.resolveLocked(row,{reason:"deadline",defaulted:true,action:input.defaultAction === "skip" ? "skip" : "defer"},now);
    if (answer === undefined || source === undefined) return row;
    return this.resolveLocked(row,{reason:"answered",answer,defaulted:false,source},now);
  }
  native(id: string): NativePolicy {
    const row=this.db.prepare("SELECT * FROM native_decisions WHERE item=?").get(id) as NativePolicy|undefined;
    if (!row) throw new Error("Not a native decision");return row;
  }
  nativeTracking(parent:string):NativePolicy[]{
    return this.db.prepare("SELECT n.*,i.created FROM native_decisions n JOIN items i ON i.id=n.item WHERE i.parent=? AND i.state=\'parked\'").all(parent) as unknown as NativePolicy[];
  }
  bindNative(id: string, requestId: string, now=Date.now(), questions:string|null=null, itemId:string|null=null): boolean {
    return this.transaction(() => {
      const row=this.get(id),policy=this.native(id);
      if (row.state !== "parked" || policy.request_id !== null) return false;
      if (this.db.prepare("SELECT item FROM native_decisions WHERE request_id=?").get(requestId)) {
        this.finishNativeLocked(row,{reason:"already_tracked"},now);return false;
      }
      if(questions && Buffer.byteLength(questions)>4096)throw new Error("Native question schema exceeds cap");
      this.db.prepare("UPDATE native_decisions SET request_id=?,questions=?,turn_item=? WHERE item=?").run(requestId,questions,itemId,id);
      return true;
    });
  }
  captureNative(id:string,questions:string|null,itemId:string|null):void{
    if(questions && Buffer.byteLength(questions)>4096)throw new Error("Native question schema exceeds cap");
    this.transaction(()=>this.db.prepare("UPDATE native_decisions SET questions=coalesce(questions,?),turn_item=coalesce(turn_item,?) WHERE item=?").run(questions,itemId,id));
  }
  queueNative(id: string, payload: string, now=Date.now()): boolean {
    return this.transaction(() => {
      if (this.get(id).state !== "parked") return false;
      if (Buffer.byteLength(payload)>4096) throw new Error("Native response exceeds cap");
      const result=this.db.prepare("INSERT OR IGNORE INTO outbox(id,item,channel,payload,state,next_at) VALUES(?,?,'native',?,'pending',?)")
        .run("chaldea-native:"+id+":default",id,payload,now);
      return result.changes>0;
    });
  }
  finishNative(id: string, outcome: Outcome, delivered=false, now=Date.now()): void {
    this.transaction(() => {
      const row=this.get(id);
      this.finishNativeLocked(row,outcome,now);
      this.db.prepare("UPDATE outbox SET state=?,disposition=? WHERE item=? AND channel='native' AND state IN ('pending','sending','uncertain')")
        .run(delivered ? "sent" : "suppressed",delivered ? null : "answered_in_t3",id);
    });
  }
  private finishNativeLocked(row: Item, outcome: Outcome, now: number): void {
    if (row.kind !== "native") throw new Error("Not a native decision");
    if (row.state === "parked") this.db.prepare("UPDATE items SET state='resolved',outcome=?,terminal=? WHERE id=?").run(JSON.stringify(outcome),now,row.id);
    else if (row.outcome === null) this.db.prepare("UPDATE items SET outcome=? WHERE id=?").run(JSON.stringify(outcome),row.id);
  }
  nativeAttention(id: string, outcome: Outcome, responseState="suppressed", now=Date.now()): void {
    this.transaction(() => {
      const row=this.get(id);
      if (row.state !== "parked") return;
      this.resolveLocked(row,outcome,now);
      this.db.prepare("UPDATE items SET state='needs_attention',disposition=? WHERE id=?").run(outcome.detail ?? "native_attention",id);
      this.db.prepare("UPDATE outbox SET state=?,disposition=? WHERE item=? AND channel='native' AND state IN ('pending','sending')")
        .run(responseState,outcome.detail ?? "native_attention",id);
    });
  }
  cursor(id: string, sequence: number): void {
    this.transaction(() => this.db.prepare("UPDATE items SET cursor=max(cursor,?) WHERE id=?").run(sequence,id));
  }
  cancel(id: string, now = Date.now()): {item: Item; delivery: string} {
    return this.transaction(() => this.cancelLocked(this.get(id),now));
  }
  private cancelLocked(row: Item, now: number): {item: Item; delivery: string} {
    const id=row.id,parent=row.parent;
    if (row.kind !== "wait") throw new Error("Only waits can be cancelled");
    if (row.state === "cancelled" || row.state === "orphaned") return {item:row,delivery:row.state};
    const wake = this.db.prepare(`SELECT o.* FROM outbox o JOIN items i ON i.id=o.item
      WHERE i.parent=? AND i.id=? AND o.channel='wake'`).get(parent,id) as Delivery|undefined;
    if (wake?.state === "pending" && wake.attempts > 0) return {item:row,delivery:"uncertain_in_flight"};
    if (wake?.state === "sending" || wake?.state === "sent") return {item:row,delivery:wake.state === "sending" ? "uncertain_in_flight" : "already_delivered"};
    this.db.prepare("UPDATE items SET state='cancelled',disposition='manual',terminal=? WHERE id=? AND parent=?").run(now,id,parent);
    this.db.prepare(`UPDATE outbox SET state='suppressed' WHERE item=? AND state IN ('pending','blocked')
      AND item IN (SELECT id FROM items WHERE parent=?)`).run(id,parent);
    const item=this.db.prepare("SELECT * FROM items WHERE parent=? AND id=?").get(parent,id) as unknown as Item;
    return {item,delivery:"suppressed"};
  }
  /** Explicit same-UID operator selection, never authenticated caller identity.
   * Keyset pages are bounded and every SQL query includes the selected parent. */
  listWaits(parent: string, limit = 8, after = ""): {items:Item[];nextCursor:string|null} {
    text(parent,"threadId");
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw new Error("Invalid limit (1-8)");
    if (typeof after !== "string" || Buffer.byteLength(after)>256) throw new Error("Invalid cursor");
    const rows=this.db.prepare("SELECT * FROM items WHERE kind='wait' AND parent=? AND id>? ORDER BY id LIMIT ?")
      .all(parent,after,limit+1) as unknown as Item[];
    return {items:rows.slice(0,limit),nextCursor:rows.length>limit ? rows[limit-1]!.id : null};
  }
  waitDeliveries(parent: string, ids: readonly string[]): Delivery[] {
    text(parent,"threadId");
    if (ids.length>8) throw new Error("At most 8 waitIds");
    return ids.flatMap(id => this.db.prepare(`SELECT o.* FROM outbox o JOIN items i ON i.id=o.item
      WHERE i.kind='wait' AND i.parent=? AND i.id=?`).all(parent,text(id,"waitId")) as unknown as Delivery[]);
  }
  /** One writer transaction arbitrates each selected row against claim/receipt.
   * Unknown and cross-parent IDs share a refusal and never mutate either parent. */
  closeoutWaits(parent: string, ids: readonly string[], now = Date.now()): Array<
    {id:string;item:Item;delivery:string} | {id:string;error:"wait_not_found_for_thread"}
  > {
    text(parent,"threadId");
    if (!Array.isArray(ids) || ids.length<1 || ids.length>8 || new Set(ids).size!==ids.length)
      throw new Error("Provide 1-8 unique waitIds");
    for (const id of ids) text(id,"waitId");
    return this.transaction(() => ids.map(id => {
      const row=this.db.prepare("SELECT * FROM items WHERE kind='wait' AND parent=? AND id=?").get(parent,id) as Item|undefined;
      return row ? {id,...this.cancelLocked(row,now)} : {id,error:"wait_not_found_for_thread" as const};
    }));
  }
  orphan(id: string, reason: string, now = Date.now()): void {
    this.transaction(() => {
      const batch=(this.db.prepare("SELECT batch_id FROM outbox WHERE item=? AND channel='wake'").get(id) as {batch_id:string|null}|undefined)?.batch_id;
      const ids=batch
        ? (this.db.prepare("SELECT item FROM outbox WHERE batch_id=?").all(batch) as Array<{item:string}>).map(r=>r.item)
        : [id];
      for (const item of ids) {
        this.db.prepare("UPDATE items SET state='orphaned',disposition=?,terminal=? WHERE id=?").run(reason,now,item);
        this.db.prepare("UPDATE outbox SET state='uncertain',disposition=? WHERE item=? AND channel IN ('wake','native') AND attempts>0 AND state IN ('pending','sending')").run(reason,item);
        this.db.prepare("UPDATE outbox SET state='suppressed' WHERE item=? AND state IN ('pending','blocked')").run(item);
      }
    });
  }
  /** Only a batch leader may send; ambiguous batches precede new wakes on a thread. */
  dispatchable(): Delivery[] {
    const parents = new Set<string>();
    return this.deliveries().filter(d => d.state === "pending" && (!d.batch_id || d.batch_id === d.id))
      .sort((a,b) => Number(b.attempts > 0)-Number(a.attempts > 0) || a.next_at-b.next_at || a.id.localeCompare(b.id))
      .filter(d => {
        const item=this.get(d.item);
        if (d.channel !== "wake" || item.kind !== "wait") return true;
        if (parents.has(item.parent)) return false;
        parents.add(item.parent); return true;
      });
  }
  claim(id: string): Delivery | undefined {
    return this.transaction(() => {
      const row=this.db.prepare("SELECT * FROM outbox WHERE id=? AND state='pending'").get(id) as Delivery|undefined;
      if (!row || (row.batch_id && row.batch_id !== id)) return;
      const item=this.get(row.item);
      if (row.channel === "wake" && item.kind === "wait" && !row.batch_id && row.attempts === 0) {
        const members=this.db.prepare(`SELECT o.* FROM outbox o JOIN items i ON i.id=o.item
          WHERE i.kind='wait' AND i.parent=? AND i.project=? AND i.wake_guard IS ? AND o.channel='wake'
          AND o.state='pending' AND o.attempts=0 AND o.batch_id IS NULL ORDER BY o.id`)
          .all(item.parent,item.project,item.wake_guard) as unknown as Delivery[];
        // Persist membership and the final wire bytes before any RPC. An attempted
        // batch is immutable, including after a lost ACK or process restart.
        let payload=row.payload;
        if (members.length > 1) {
          const command=JSON.parse(payload);
          command.text="Chaldea wake (waits):\n"+members.map(d => {
            const wait=this.get(d.item);
            return wait.id+": "+waitSummary(wait,JSON.parse(wait.outcome!));
          }).join("\n")+"\nchaldea wait status <id>";
          payload=JSON.stringify(command);
        }
        const freeze=this.db.prepare("UPDATE outbox SET batch_id=?,payload=? WHERE id=?");
        for (const member of members) freeze.run(id,payload,member.id);
      }
      this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE (id=? OR batch_id=?) AND state='pending'").run(id,id);
      return this.db.prepare("SELECT * FROM outbox WHERE id=?").get(id) as unknown as Delivery;
    });
  }
  block(id: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state='blocked' WHERE (id=? OR batch_id=?) AND state='sending'").run(id,id);
      this.db.prepare("UPDATE items SET disposition='delivery_rejected' WHERE id IN (SELECT item FROM outbox WHERE id=? OR batch_id=?)").run(id,id);
    });
  }
  sent(id: string): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='sent' WHERE id=? OR batch_id=?").run(id,id); }); }
  retry(id: string, at: number): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='pending',next_at=? WHERE (id=? OR batch_id=?) AND state IN ('pending','sending')").run(at,id,id); }); }
  suppress(id: string): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='suppressed' WHERE id=? AND state='pending'").run(id); }); }
  maintain(now: number): void {
    this.transaction(() => {
      // Never prune unresolved or ambiguous delivery. Retire request keys before removing tombstones.
      const candidates = this.db.prepare(`SELECT id,request_at,terminal FROM items WHERE state<>'parked'
        AND id NOT IN (SELECT item FROM outbox WHERE state IN ('pending','sending','blocked','uncertain'))
        AND id NOT IN (SELECT item FROM sessions WHERE occupancy='held')
        ORDER BY terminal DESC,id`).all() as unknown as Array<{id:string;request_at:number;terminal:number}>;
      const remove = candidates.filter((r,i) => i >= 10000 || r.terminal < now - MAX_AGE);
      if (remove.length) {
        const fence = Math.max(Number(this.meta("replay_fence")), ...remove.map(r => r.request_at));
        this.db.prepare("UPDATE meta SET value=? WHERE key='replay_fence'").run(String(fence));
        const del = this.db.prepare("DELETE FROM items WHERE id=?"); for (const r of remove) del.run(r.id);
      }
    });
  }
  session(id: string): SessionRecord {
    const row = this.db.prepare("SELECT * FROM sessions WHERE item=?").get(id) as SessionRecord | undefined;
    if (!row) throw new Error("Not a session"); return row;
  }
  /** Same requestId and arguments return the stored session; changed arguments are refused. */
  sessionRequest(requestId: string, hash: string): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE request_key=?").get(requestId) as Item | undefined;
    if (row && (row.kind !== "session" || row.hash !== hash)) throw new Error("requestId reused with changed payload");
    return row;
  }
  presetHeld(preset: string): SessionRecord | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE preset=? AND occupancy='held'").get(preset) as SessionRecord | undefined;
  }
  /** Every session thread ever started here and still retained: known limited lineage. */
  sessionThreads(): Set<string> {
    return new Set((this.db.prepare("SELECT thread_id FROM sessions").all() as Array<{thread_id:string}>).map(r => r.thread_id));
  }
  /** Sessions that still need lifecycle work: logically active, or holding their preset slot. */
  liveSessions(): SessionRecord[] {
    return this.db.prepare("SELECT s.* FROM sessions s JOIN items i ON i.id=s.item WHERE i.state='parked' OR s.occupancy='held' ORDER BY i.created,s.item").all() as unknown as SessionRecord[];
  }
  registerSession(r: SessionRegistration, now = Date.now(), maxActive = MAX_ACTIVE_SESSIONS): Item {
    return this.transaction(() => {
      const existing = this.sessionRequest(r.requestId, r.hash); if (existing) return existing;
      if (r.requestAt <= Number(this.meta("replay_fence"))) throw new Error("requestId retired by retention fence");
      if (this.bytes() > DB_LIMIT - 1024 * 1024) throw new Error("Disk pressure: registration parked");
      if (this.presetHeld(r.preset)) throw new SessionRefusal("preset_busy", "the preset's previous session has not been observed to stop");
      const held = (this.db.prepare("SELECT count(*) AS n FROM sessions WHERE occupancy='held'").get() as {n:number}).n;
      if (held >= maxActive) throw new SessionRefusal("session_limit", "active session limit (" + maxActive + ")");
      this.db.prepare("INSERT INTO items(id,kind,parent,project,request_key,request_at,hash,input,deadline,target_run,state,created) VALUES(?,'session',?,?,?,?,?,?,?,NULL,'parked',?)")
        .run(r.id,r.parent,r.project,r.requestId,r.requestAt,r.hash,JSON.stringify(r.input),r.deadline,now);
      this.db.prepare(`INSERT INTO sessions(item,preset,preset_hash,admission,thread_id,command_id,message_id,t3_project,payload,launch,occupancy)
        VALUES(?,?,?,?,?,?,?,?,?,'intent','held')`)
        .run(r.id,r.preset,r.presetHash,r.admission,r.threadId,r.commandId,r.messageId,r.t3Project,r.payload);
      return this.get(r.id);
    });
  }
  /** Compare-and-set launch transition; false when another path already moved it. */
  sessionLaunch(id: string, from: readonly SessionRecord["launch"][], to: SessionRecord["launch"], detail: string | null = null): boolean {
    return this.transaction(() => {
      const s = this.session(id);
      if (!from.includes(s.launch)) return false;
      this.db.prepare("UPDATE sessions SET launch=?,launch_detail=coalesce(?,launch_detail) WHERE item=?").run(to,detail,id);
      return true;
    });
  }
  sessionRoot(id: string, run: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE sessions SET root_run=coalesce(root_run,?) WHERE item=?").run(run,id);
      this.db.prepare("UPDATE items SET target_run=coalesce(target_run,?) WHERE id=?").run(run,id);
    });
  }
  releaseSession(id: string, reason: string, now = Date.now()): void {
    this.transaction(() => this.db.prepare("UPDATE sessions SET occupancy='released',released=?,released_at=? WHERE item=? AND occupancy='held'").run(reason,now,id));
  }
  /** One terminal outcome and one deterministic wake per session. The slot is unaffected. */
  finishSession(id: string, outcome: SessionOutcome, result: string | null = null, now = Date.now()): Item {
    return this.transaction(() => {
      const row = this.get(id);
      if (row.kind !== "session" || row.state !== "parked") return row;
      const s = this.session(id);
      const runId = outcome.runId ?? s.root_run ?? undefined;
      const final: SessionOutcome = {...outcome, ...(runId ? {runId} : {})};
      const wake = sessionWake({id, parent: row.parent, preset: s.preset, thread: s.thread_id, outcome: final, result});
      final.wake = wake.wake;
      this.db.prepare("UPDATE items SET state='resolved',outcome=?,terminal=? WHERE id=?").run(JSON.stringify(final),now,id);
      this.db.prepare("UPDATE sessions SET result=?,result_state=?,result_bytes=? WHERE item=?")
        .run(result,outcome.reason === "succeeded" ? "stored" : outcome.reason.startsWith("result_") ? outcome.reason : null,outcome.bytes ?? null,id);
      this.db.prepare("INSERT INTO outbox(id,item,channel,payload,state,next_at) VALUES(?,?,'wake',?,'pending',?)")
        .run("chaldea-session:" + id + ":wake",id,wake.payload,now);
      return this.get(id);
    });
  }
  close(): void { try { this.checkpoint(); } finally { try { this.db.close(); } finally { this.releaseOwner(); } } }
}
