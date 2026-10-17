// Single writer, transactional journal shared by waits and decisions.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DAY, MAX_AGE, validate, type Input, type DecisionInput, type Outcome } from "../waits/types.ts";

export interface Item {
  id: string; kind: "wait" | "decision"; parent: string; project: string; request_key: string; request_at: number;
  hash: string; input: string; deadline: number; target_run: string | null; cursor: number;
  state: "parked" | "resolved" | "cancelled" | "orphaned"; disposition: string | null;
  outcome: string | null; created: number; terminal: number | null;
}
export interface Delivery {
  id: string; item: string; channel: "wake" | "phone"; payload: string;
  state: "pending" | "sending" | "sent" | "suppressed" | "blocked"; attempts: number; next_at: number; expires: number | null;
}
export interface Registration { id: string; kind: Item["kind"]; input: Input; deadline: number; requestAt: number; hash: string }
const DB_LIMIT = 64 * 1024 * 1024;
export class WakeStore {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly environment: string;
  constructor(path: string, environment: string) {
    this.path = path; this.environment = environment;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000; PRAGMA max_page_count=8192; PRAGMA journal_size_limit=0;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS items(
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, parent TEXT NOT NULL, project TEXT NOT NULL,
        request_key TEXT UNIQUE NOT NULL, request_at INTEGER NOT NULL, hash TEXT NOT NULL,
        input TEXT NOT NULL, deadline INTEGER NOT NULL, target_run TEXT, cursor INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL, disposition TEXT, outcome TEXT, created INTEGER NOT NULL, terminal INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(
        id TEXT PRIMARY KEY, item TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        channel TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, expires INTEGER,
        UNIQUE(item,channel));
      CREATE INDEX IF NOT EXISTS items_state ON items(state,deadline);
      CREATE INDEX IF NOT EXISTS outbox_due ON outbox(state,next_at);
    `);
    const env = this.meta("environment");
    if (env && env !== environment) { this.db.close(); throw new Error("Wake database belongs to another environment"); }
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('environment',?)").run(environment);
    this.db.prepare("INSERT OR IGNORE INTO meta VALUES('replay_fence','0')").run();
    // 'sending' means an ambiguous RPC after restart. Retry the identical stored payload.
    this.db.prepare("UPDATE outbox SET state='pending' WHERE state='sending'").run();
    this.maintain(Date.now());
  }
  meta(key: string): string | undefined { return (this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as {value:string}|undefined)?.value; }
  transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = body(); this.db.exec("COMMIT"); return result; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
    finally { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); }
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
  register(reg: Registration, project: string, targetRun: string | null, phonePayload?: string, now = Date.now()): Item {
    return this.transaction(() => {
      const existing = this.existing(reg); if (existing) return existing;
      if (reg.requestAt <= Number(this.meta("replay_fence"))) throw new Error("requestId retired by retention fence");
      if (this.bytes() > DB_LIMIT - 1024 * 1024) throw new Error("Disk pressure: registration parked");
      const count = (this.db.prepare("SELECT count(*) AS n FROM items WHERE state='parked' AND kind=?").get(reg.kind) as {n:number}).n;
      if (count >= 128) throw new Error("Active " + reg.kind + " limit (128)");
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
      const commandId = "chaldea-" + row.kind + ":" + id + ":wake";
      const text = "Chaldea wake (" + row.kind + " " + id + "): " + JSON.stringify(outcome) + "\nchaldea " + row.kind + " status " + id;
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
  answer(id: string, answer: string, now = Date.now()): Item {
    // SQLite's writer lock arbitrates the human/deadline race, including separate processes.
    return this.transaction(() => this.answerLocked(id,answer,now));
  }
  private answerLocked(id: string, answer: string, now: number): Item {
    const row = this.get(id);
    if (row.kind !== "decision") throw new Error("Not a decision");
    const input = JSON.parse(row.input) as DecisionInput;
    if (!input.options.includes(answer)) throw new Error("Answer must be one of the options");
    if (row.state !== "parked") return row;
    return this.resolveLocked(row, now >= row.deadline ? {reason:"deadline",answer:input.default,defaulted:true} : {reason:"answered",answer,defaulted:false},now);
  }
  cursor(id: string, sequence: number): void {
    this.transaction(() => this.db.prepare("UPDATE items SET cursor=max(cursor,?) WHERE id=?").run(sequence,id));
  }
  cancel(id: string, now = Date.now()): {item: Item; delivery: string} {
    return this.transaction(() => {
      const row = this.get(id);
      const wake = this.deliveries().find(d => d.item === id && d.channel === "wake");
      if (wake?.state === "sending" || wake?.state === "sent") return {item:row,delivery:wake.state === "sending" ? "uncertain_in_flight" : "already_delivered"};
      this.db.prepare("UPDATE items SET state='cancelled',disposition='manual',terminal=? WHERE id=?").run(now,id);
      this.db.prepare("UPDATE outbox SET state='suppressed' WHERE item=? AND state IN ('pending','blocked')").run(id);
      return {item:this.get(id),delivery:"suppressed"};
    });
  }
  orphan(id: string, reason: string, now = Date.now()): void {
    this.transaction(() => {
      this.db.prepare("UPDATE items SET state='orphaned',disposition=?,terminal=? WHERE id=?").run(reason,now,id);
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
  sent(id: string): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='sent' WHERE id=?").run(id); }); }
  retry(id: string, at: number): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='pending',next_at=? WHERE id=? AND state IN ('pending','sending')").run(at,id); }); }
  suppress(id: string): void { this.transaction(() => { this.db.prepare("UPDATE outbox SET state='suppressed' WHERE id=? AND state='pending'").run(id); }); }
  maintain(now: number): void {
    this.transaction(() => {
      // Never prune unresolved or ambiguous delivery. Retire request keys before removing tombstones.
      const candidates = this.db.prepare(`SELECT id,request_at,terminal FROM items WHERE state<>'parked'
        AND id NOT IN (SELECT item FROM outbox WHERE state IN ('pending','sending','blocked'))
        ORDER BY terminal DESC,id`).all() as unknown as Array<{id:string;request_at:number;terminal:number}>;
      const remove = candidates.filter((r,i) => i >= 10000 || r.terminal < now - MAX_AGE);
      if (remove.length) {
        const fence = Math.max(Number(this.meta("replay_fence")), ...remove.map(r => r.request_at));
        this.db.prepare("UPDATE meta SET value=? WHERE key='replay_fence'").run(String(fence));
        const del = this.db.prepare("DELETE FROM items WHERE id=?"); for (const r of remove) del.run(r.id);
      }
    });
  }
  close(): void { this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); this.db.close(); }
}
