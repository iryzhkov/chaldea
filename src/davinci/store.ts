// One local writer, finite journal, immutable assignment and result sequence.
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { openDb, tx, meta } from "../store/sqlite.ts";
import { ownDatabase } from "../wake/owner.ts";
import { requireMessage as check } from "../message.ts";
import { assignment, assignmentHash, binding, decodeAssignment, decodeResult, decodeReceipt, BODY, WINDOW, RETENTION,
  type Assignment, type Definition, type Result, type ResultReceipt } from "./protocol.ts";

export interface Row {
  id: string; at: number; assignment: string; session: string | null; attempted: number;
  result: string | null; seq: number; closed: number; sent_at: number; closed_at: number | null; confirmed_seq: number; notified_seq: number;
}
export class Journal {
  readonly db!: ReturnType<typeof openDb>;
  readonly definition: Definition;
  private readonly release: () => void;
  private readonly role: "coordinator" | "worker";
  constructor(path: string, role: "coordinator" | "worker", d: Definition) {
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.release=ownDatabase(path);
    this.definition=d;this.role=role;
    try {
      this.db=openDb(path,"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=7936; PRAGMA journal_size_limit=0");
      chmodSync(path,0o600);
      this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      this.db.exec("CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY,at INTEGER NOT NULL,assignment TEXT NOT NULL,session TEXT,attempted INTEGER NOT NULL DEFAULT 0,result TEXT,seq INTEGER NOT NULL DEFAULT 0,closed INTEGER NOT NULL DEFAULT 0,sent_at INTEGER NOT NULL DEFAULT 0,closed_at INTEGER,confirmed_seq INTEGER NOT NULL DEFAULT 0,notified_seq INTEGER NOT NULL DEFAULT 0)");
      tx(this.db,()=>{
        const m=meta(this.db,"meta","key"), value=role+"\n"+binding(d);
        check(m.get("binding")===undefined || m.get("binding")===value,"davinci_journal_binding");
        m.put("binding",value);
      });
    } catch(e) { try { this.db!.close(); } catch {} this.release(); throw e; }
  }
  close(): void { try {this.db.close();} finally {this.release();} }
  get(id: string): Row | undefined { return this.db.prepare("SELECT * FROM work WHERE id=?").get(id) as unknown as Row | undefined; }
  rows(): Row[] { return this.db.prepare("SELECT * FROM work ORDER BY at,id LIMIT 512").all() as unknown as Row[]; }
  active(): Row[] { return this.rows().filter(r=>!r.closed); }
  /** Status is a journal read, never an admission/recovery effect. */
  status(id: string) {
    const r=this.get(id); check(r,"davinci_unknown_job");
    return {assignment:JSON.parse(r.assignment) as Assignment,result:r.result?JSON.parse(r.result) as Result:null};
  }
  protected clock(now: number): void {
    check(Number.isSafeInteger(now) && now>=this.definition.notBefore,"davinci_clock");
    const m=meta(this.db,"meta","key"), old=Number(m.get("clock")??0);
    check(now>=old,"davinci_clock_rollback"); m.put("clock",String(now));
    // Never evict active/uncertain ownership; admission refuses when full.
    this.db.prepare("DELETE FROM work WHERE closed=1 AND closed_at<? AND confirmed_seq>=seq AND (?=1 OR notified_seq>=seq)")
      .run(now-RETENTION,Number(this.role==="coordinator"));
  }
  protected insert(a: Assignment): Row {
    check(Number(this.db.prepare("SELECT count(*) AS n FROM work").get()!.n)<512,"davinci_capacity");
    this.db.prepare("INSERT INTO work(id,at,assignment) VALUES(?,?,?)").run(a.id,a.at,JSON.stringify(a));
    return this.get(a.id)!;
  }
  maintain(now: number): void {
    tx(this.db,()=>this.clock(now));
    const r=this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    check(Number(r?.busy)===0,"davinci_checkpoint_busy");
  }
}
export class Coordinator extends Journal {
  constructor(path: string,d: Definition) {super(path,"coordinator",d);}
  private accept(key: string,at: number): Assignment {
    const a=assignment(this.definition,key,at), old=this.get(a.id);
    if(old) {check(old.assignment===JSON.stringify(a),"davinci_delivery_conflict");return a;}
    check(this.active().length===0,"davinci_overlap");
    this.insert(a);return a;
  }
  webhook(delivery: string,body: string,now: number,enabled=this.definition.enabled): Assignment {
    return tx(this.db,()=>{
      this.clock(now);
      check(/^[0-9]{13}:[A-Za-z0-9_-]{1,80}$/.test(delivery) &&
        Math.abs(now-Number(delivery.slice(0,13)))<=WINDOW,"davinci_fixed_webhook");
      const at=Number(delivery.slice(0,13)),a=assignment(this.definition,"webhook:"+delivery,at);
      const old=this.get(a.id);
      if(old) {check(body===BODY,"davinci_delivery_conflict");return JSON.parse(old.assignment) as Assignment;}
      check(body===BODY,"davinci_fixed_webhook");
      check(enabled && at>=this.definition.notBefore,"davinci_disabled");
      return this.accept("webhook:"+delivery,at);
    });
  }
  /** Daily UTC, skip missed (>60s) and overlapping occurrences; no catch-up burst. */
  tick(now: number,enabled=this.definition.enabled,boundary?:()=>void): Assignment | null {
    return tx(this.db,()=>{
      this.clock(now);
      const [h,m]=this.definition.utc.split(":").map(Number);
      const today=new Date(now);today.setUTCHours(h!,m!,0,0);
      let due=today.getTime();if(due>now)due-=86400_000;
      const md=meta(this.db,"meta","key"),cursor=Number(md.get("cursor")??(this.definition.notBefore-1));
      if(due<=cursor || due<this.definition.notBefore)return null;
      md.put("cursor",String(due));
      boundary?.(); // test a crash before occurrence commit: cursor must roll back too
      if(!enabled || now-due>60_000 || this.active().length>0) {
        md.put("lastSkip",JSON.stringify({due,reason:!enabled?"disabled":now-due>60_000?"misfire":"overlap"}));return null;
      }
      return this.accept("schedule:"+due,due);
    });
  }
  scheduleStatus() { const m=meta(this.db,"meta","key");return {cursor:m.get("cursor")??null,lastSkip:m.get("lastSkip")??null}; }
  /** Worker already holds our custody receipt; only now may its outcome expire. */
  confirm(bytes: string): void {
    const r=decodeReceipt(bytes,"receipt-confirmed"),row=this.get(r.id);
    if(!row)return; // harmless confirmation replay after completed retention
    check(r.hash===assignmentHash(JSON.parse(row.assignment) as Assignment) && r.seq<=row.seq,"davinci_confirmation_binding");
    this.db.prepare("UPDATE work SET confirmed_seq=max(confirmed_seq,?) WHERE id=?").run(r.seq,r.id);
  }
  result(bytes: string,now=Date.now()): ResultReceipt {
    const r=decodeResult(bytes),row=this.get(r.id);check(row,"davinci_unknown_result");
    const a=JSON.parse(row.assignment) as Assignment;
    check(r.hash===assignmentHash(a),"davinci_result_binding");
    if(r.status)check(r.status.requestId===a.requestId && r.status.preset===this.definition.preset &&
      (!row.session || row.session===r.status.sessionId),"davinci_session_binding");
    const receipt:ResultReceipt={version:1,kind:"result-receipt",id:r.id,hash:r.hash,seq:r.seq};
    if(r.seq<row.seq)return receipt; // stale/reordered observation
    if(r.seq===row.seq) {check(row.result===bytes,"davinci_result_conflict");return receipt;}
    check(!row.closed,"davinci_terminal_result_changed");
    this.db.prepare("UPDATE work SET result=?,seq=?,closed=?,session=?,sent_at=0,closed_at=? WHERE id=?")
      .run(bytes,r.seq,Number(r.closed),r.status?.sessionId??null,r.closed?now:null,r.id);
    return receipt;
  }
}
export class WorkerJournal extends Journal {
  constructor(path: string,d: Definition) {super(path,"worker",d);}
  accept(bytes: string,now: number): Row {
    const a=decodeAssignment(bytes,this.definition);
    return tx(this.db,()=>{
      this.clock(now);
      const old=this.get(a.id);
      if(old) {check(old.assignment===JSON.stringify(a),"davinci_assignment_conflict");return old;}
      check(a.at<=now+30_000,"davinci_assignment_future");
      check(this.active().length===0,"davinci_worker_busy");
      return this.insert(a);
    });
  }
  attempted(id: string): void { this.db.prepare("UPDATE work SET attempted=1 WHERE id=?").run(id); }
  confirm(bytes: string): void {
    const r=decodeReceipt(bytes),row=this.get(r.id);check(row,"davinci_unknown_receipt");
    check(r.hash===assignmentHash(JSON.parse(row.assignment) as Assignment) && r.seq<=row.seq,"davinci_receipt_binding");
    this.db.prepare("UPDATE work SET confirmed_seq=?,sent_at=0 WHERE id=? AND confirmed_seq<?").run(r.seq,r.id,r.seq);
  }
  published(id: string,seq: number,confirmation: boolean,now: number): void {
    const row=this.get(id);check(row && (!confirmation || row.confirmed_seq>=seq),"davinci_confirmation_unobserved");
    this.db.prepare("UPDATE work SET sent_at=?,notified_seq=max(notified_seq,?) WHERE id=? AND seq=?")
      .run(now,confirmation?seq:0,id,seq);
  }
  observe(id: string,status: Result["status"],disposition: Result["disposition"],now=Date.now()): Result {
    const row=this.get(id);check(row,"davinci_unknown_job");
    const a=JSON.parse(row.assignment) as Assignment;
    if(status)check(status.requestId===a.requestId && status.preset===this.definition.preset &&
      (!row.session || row.session===status.sessionId),"davinci_session_identity");
    const r:Result={version:1,id,hash:assignmentHash(a),seq:row.seq+1,
      closed:status ? status.occupancy==="released" && status.state!=="parked" : disposition==="expired",status,disposition};
    const previous=row.result?JSON.parse(row.result) as Result:null;
    if(previous && JSON.stringify({...r,seq:0})===JSON.stringify({...previous,seq:0}))return previous;
    check(!row.closed,"davinci_closed");
    const bytes=JSON.stringify(r);decodeResult(bytes);
    this.db.prepare("UPDATE work SET result=?,seq=?,closed=?,session=?,sent_at=0,closed_at=? WHERE id=?")
      .run(bytes,r.seq,Number(r.closed),status?.sessionId??row.session,r.closed?now:null,id);
    return r;
  }
}
