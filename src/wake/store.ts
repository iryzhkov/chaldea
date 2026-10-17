// Single writer, transactional journal shared by waits and decisions.
import { DatabaseSync } from "node:sqlite";
import { ownDatabase } from "./owner.ts";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, MAX_AGE, validate, type Input, type DecisionInput, type Outcome, type AnswerSource } from "../waits/types.ts";

export interface Item {
  id: string; kind: "wait" | "decision" | "native"; parent: string; project: string; request_key: string; request_at: number;
  hash: string; input: string; deadline: number; target_run: string | null; cursor: number;
  state: "parked" | "resolved" | "cancelled" | "orphaned" | "needs_attention"; disposition: string | null;
  outcome: string | null; created: number; terminal: number | null;
}
export interface Delivery {
  id: string; item: string; channel: "wake" | "phone" | "native"; payload: string;
  state: "pending" | "sending" | "sent" | "suppressed" | "blocked" | "uncertain" | "undeliverable"; disposition: string | null; attempts: number; next_at: number; expires: number | null;
}
export interface NativePolicy { item: string; request_id: string | null; bind_until: number; baseline: string; questions: string|null; turn_item:string|null; created?:number }
export interface Registration { id: string; kind: Item["kind"]; input: Input; deadline: number; requestAt: number; hash: string }
const DB_LIMIT = 64 * 1024 * 1024;
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
    try { this.db = new DatabaseSync(path); } catch(error) { this.releaseOwner();throw error; }
    try {
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000; PRAGMA max_page_count=7936; PRAGMA cache_spill=OFF; PRAGMA journal_size_limit=0;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
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
    const env = this.meta("environment");
    if (env && env !== environment) throw new Error("Wake database belongs to another environment");
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('environment',?)").run(environment);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('replay_fence','0')").run();
    // 'sending' means an ambiguous RPC after restart. Retry the identical stored payload.
    this.db.prepare("UPDATE outbox SET state='pending' WHERE state='sending'").run();
    try { this.maintain(Date.now()); } catch(error) { if (!(error instanceof CheckpointBlockedError)) throw error; }
    } catch(error) { this.db.close(); this.releaseOwner(); throw error; }
  }
  meta(key: string): string | undefined { return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as {value:string}|undefined)?.value; }
  transaction<T>(body: () => T): T {
    // Refuse another write if an external reader prevents truncation. Disabling
    // cache spill bounds a transaction to one WAL frame per dirty page; 31 MiB
    // main + WAL frame headers fits below the shared 64 MiB physical cap.
    if (!this.checkpoint()) throw new CheckpointBlockedError();
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
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
  prepare(kind: Item["kind"], value: unknown, now = Date.now()): Registration {
    const {input, deadline, requestAt} = validate(kind, value, now);
    const hash = createHash("sha256").update(JSON.stringify({kind,input})).digest("hex");
    return {id: randomUUID(), kind, input, deadline, requestAt, hash};
  }
  existing(reg: Registration): Item | undefined {
    const row = this.db.prepare("SELECT * FROM items WHERE request_key=?").get(reg.input.requestId) as Item|undefined;
    if (row && row.hash !== reg.hash) throw new Error("requestId reused with changed payload");
    return row;
  }
  register(reg: Registration, project: string, targetRun: string | null, phonePayload?: string, now = Date.now(), nativeBaseline: string[] = [], nativeQuestions:string|null=null, nativeItem:string|null=null): Item {
    return this.transaction(() => {
      const existing = this.existing(reg); if (existing) return existing;
      if (reg.requestAt <= Number(this.meta("replay_fence"))) throw new Error("requestId retired by retention fence");
      if (this.bytes() > DB_LIMIT - 1024 * 1024) throw new Error("Disk pressure: registration parked");
      const count = (this.db.prepare("SELECT count(*) AS n FROM items WHERE state='parked' AND (CASE WHEN kind='wait' THEN 'wait' ELSE 'decision' END)=?").get(reg.kind === "wait" ? "wait" : "decision") as {n:number}).n;
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
      if (reg.kind === "wait" && this.active().some(i => i.kind === "wait" && i.parent === reg.input.threadId))
        throw new Error("One active wait per thread");
      if ("condition" in reg.input && reg.input.condition.kind === "thread") {
        let target = reg.input.condition.threadId; const visited = new Set([reg.input.threadId]);
        for (;;) {
          if (visited.has(target)) throw new Error("Dependency cycle");
          visited.add(target);
          const next = this.active().find(i => i.kind === "wait" && i.parent === target);
          if (!next) break;
          const c = (JSON.parse(next.input) as {condition?: {kind:string; threadId?:string}}).condition;
          if (c?.kind !== "thread" || !c.threadId) break;
          target = c.threadId;
        }
      }
      this.db.prepare("INSERT INTO items(id,kind,parent,project,request_key,request_at,hash,input,deadline,target_run,state,created) VALUES(?,?,?,?,?,?,?,?,?,?,'parked',?)")
        .run(reg.id,reg.kind,reg.input.threadId,project,reg.input.requestId,reg.requestAt,reg.hash,JSON.stringify(reg.input),reg.deadline,targetRun,now);
      if (reg.kind === "native") this.db.prepare("INSERT INTO native_decisions(item,request_id,bind_until,baseline,questions,turn_item) VALUES(?,?,?,?,?,?)")
        .run(reg.id,"runtimeRequestId" in reg.input ? reg.input.runtimeRequestId ?? null : null,
          Math.min(reg.deadline,now+10*60_000),JSON.stringify(nativeBaseline),nativeQuestions,nativeItem);
      if (phonePayload) {
        if (Buffer.byteLength(phonePayload) > 4096) throw new Error("Phone payload exceeds cap");
        this.db.prepare("INSERT INTO outbox(id,item,channel,payload,state,next_at,expires) VALUES(?,?,'phone',?,'pending',?,?)")
          .run("chaldea-decision:" + this.environment + ":" + reg.id,reg.id,phonePayload,now,Math.min(reg.deadline,now+DAY));
      }
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
          : JSON.stringify(outcome);
      const text = "Chaldea wake (" + label + " " + id + "): " + summary + "\nchaldea " + label + " status " + id;
      const payload = JSON.stringify({
        type:"message.dispatch",commandId,messageId:commandId,threadId:row.parent,
        createdBy:"agent",creationSource:"server",attachments:[],dispatchMode:{type:"queue_after_active"},
        text,
      });
      if (Buffer.byteLength(payload) > 4096) throw new Error("Wake exceeds 4 KiB");
      this.db.prepare("UPDATE items SET state='resolved',outcome=?,terminal=? WHERE id=?").run(JSON.stringify(outcome),now,id);
      this.db.prepare("INSERT INTO outbox(id,item,channel,payload,state,next_at) VALUES(?,?,'wake',?,'pending',?)").run(commandId,id,payload,now);
      this.db.prepare("UPDATE outbox SET state='suppressed' WHERE item=? AND channel='phone' AND state='pending'").run(id);
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
  bindNative(id: string, requestId: string, phonePayload: string, now=Date.now(), questions:string|null=null, itemId:string|null=null): boolean {
    return this.transaction(() => {
      const row=this.get(id),policy=this.native(id);
      if (row.state !== "parked" || policy.request_id !== null) return false;
      if (this.db.prepare("SELECT item FROM native_decisions WHERE request_id=?").get(requestId)) {
        this.finishNativeLocked(row,{reason:"already_tracked"},now);return false;
      }
      if(questions && Buffer.byteLength(questions)>4096)throw new Error("Native question schema exceeds cap");
      this.db.prepare("UPDATE native_decisions SET request_id=?,questions=?,turn_item=? WHERE item=?").run(requestId,questions,itemId,id);
      this.phoneLocked(row,phonePayload,now);return true;
    });
  }
  captureNative(id:string,questions:string|null,itemId:string|null):void{
    if(questions && Buffer.byteLength(questions)>4096)throw new Error("Native question schema exceeds cap");
    this.transaction(()=>this.db.prepare("UPDATE native_decisions SET questions=coalesce(questions,?),turn_item=coalesce(turn_item,?) WHERE item=?").run(questions,itemId,id));
  }
  private phoneLocked(row: Item, payload: string, now: number): void {
    if (Buffer.byteLength(payload)>4096) throw new Error("Phone payload exceeds cap");
    this.db.prepare("INSERT OR IGNORE INTO outbox(id,item,channel,payload,state,next_at,expires) VALUES(?,?,'phone',?,'pending',?,?)")
      .run("chaldea-decision:"+this.environment+":"+row.id,row.id,payload,now,Math.min(row.deadline,now+DAY));
  }
  nativePhone(id: string, payload: string, now=Date.now()): void {
    this.transaction(() => this.phoneLocked(this.get(id),payload,now));
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
    this.db.prepare("UPDATE outbox SET state='suppressed' WHERE item=? AND channel='phone' AND state='pending'").run(row.id);
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
    return this.transaction(() => {
      const row = this.get(id);
      if (row.kind !== "wait") throw new Error("Only waits can be cancelled");
      if (row.state === "cancelled" || row.state === "orphaned") return {item:row,delivery:row.state};
      const wake = this.deliveries().find(d => d.item === id && d.channel === "wake");
      if (wake?.state === "pending" && wake.attempts > 0) return {item:row,delivery:"uncertain_in_flight"};
      if (wake?.state === "sending" || wake?.state === "sent") return {item:row,delivery:wake.state === "sending" ? "uncertain_in_flight" : "already_delivered"};
      this.db.prepare("UPDATE items SET state='cancelled',disposition='manual',terminal=? WHERE id=?").run(now,id);
      this.db.prepare("UPDATE outbox SET state='suppressed' WHERE item=? AND state IN ('pending','blocked')").run(id);
      return {item:this.get(id),delivery:"suppressed"};
    });
  }
  orphan(id: string, reason: string, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("UPDATE items SET state='orphaned',disposition=?,terminal=? WHERE id=?").run(reason,now,id);
      this.db.prepare("UPDATE outbox SET state='uncertain',disposition=? WHERE item=? AND channel IN ('wake','native') AND attempts>0 AND state IN ('pending','sending')").run(reason,id);
      this.db.prepare("UPDATE outbox SET state='suppressed' WHERE item=? AND state IN ('pending','blocked')").run(id);
    });
  }
  claim(id: string): Delivery | undefined {
    return this.transaction(() => {
      const row = this.db.prepare("UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state='pending' RETURNING *").get(id) as Delivery|undefined;
      return row;
    });
  }
  block(id: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE outbox SET state='blocked' WHERE id=? AND state='sending'").run(id);
      this.db.prepare("UPDATE items SET disposition='delivery_rejected' WHERE id=(SELECT item FROM outbox WHERE id=?)").run(id);
    });
  }
  undeliverable(id: string): void {
    this.transaction(() => { this.db.prepare("UPDATE outbox SET state='undeliverable',disposition='relay_unprovisioned' WHERE id=? AND channel='phone' AND state='pending'").run(id); });
  }
  sent(id: string): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='sent' WHERE id=?").run(id); }); }
  retry(id: string, at: number): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='pending',next_at=? WHERE id=? AND state IN ('pending','sending')").run(at,id); }); }
  suppress(id: string): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='suppressed' WHERE id=? AND state='pending'").run(id); }); }
  maintain(now: number): void {
    this.transaction(() => {
      // Never prune unresolved or ambiguous delivery. Retire request keys before removing tombstones.
      const candidates = this.db.prepare(`SELECT id,request_at,terminal FROM items WHERE state<>'parked'
        AND id NOT IN (SELECT item FROM outbox WHERE state IN ('pending','sending','blocked','uncertain'))
        ORDER BY terminal DESC,id`).all() as unknown as Array<{id:string;request_at:number;terminal:number}>;
      const remove = candidates.filter((r,i) => i >= 10000 || r.terminal < now - MAX_AGE);
      if (remove.length) {
        const fence = Math.max(Number(this.meta("replay_fence")), ...remove.map(r => r.request_at));
        this.db.prepare("UPDATE meta SET value=? WHERE key='replay_fence'").run(String(fence));
        const del = this.db.prepare("DELETE FROM items WHERE id=?"); for (const r of remove) del.run(r.id);
      }
    });
  }
  close(): void { try { this.checkpoint(); } finally { try { this.db.close(); } finally { this.releaseOwner(); } } }
}
