// Private bounded intent/receipt journal. Opening never creates missing state.
import { openSync, closeSync, constants, fstatSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { openPrivateDb, tx, meta } from "./store/sqlite.ts";
import { flockSync } from "./fs/flock.ts";

export const WINDOW = 24*60*60*1000;
export const RETENTION = 42*WINDOW;
export type State = "accepted" | "rejected" | "uncertain" | "conflict";
export interface Receipt { state: State; commandId: string; messageId: string; error?: string }
export interface Row {
  id: string; caller: string; hash: string; stamp: number; payload: string | null;
  state: "dispatching" | State; result: string | null;
}
const check = (ok: unknown, reason: string): void => { if (!ok) throw new Error(reason); };
// Short bounded retries serialize CLI/MCP journal transactions across processes.
export async function senderJournal<T>(database:string,binding:string,fn:(s:MessageStore)=>T,until=Date.now()+2000):Promise<T>{
  for(;;){
    let s:MessageStore|undefined,last:unknown;
    try{s=new MessageStore(database,binding);return fn(s);}
    catch(e){
      const busy=e instanceof Error&&(e.message==="message_busy"||(e as Error&{errcode?:number}).errcode===5);
      if(!busy)throw e;last=e;
    }finally{s?.close();}
    if(Date.now()>=until)throw last;
    await new Promise(resolve=>setTimeout(resolve,10));
  }
}

export class MessageStore {
  readonly db: DatabaseSync;
  private lock: number | undefined;
  constructor(path: string, binding: string, initialize = false) {
    this.db = openPrivateDb(path, {initialize,singleLink:true,directoryError:"message_state_directory",
      fileError:"message_state_file",emptyError:"message_state_missing"}, check);
    try {
      if(initialize)this.db.exec("PRAGMA page_size=4096");
      check(Number(this.db.prepare("PRAGMA page_size").get()!.page_size)===4096,"message_page_size");
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=0;");
      check(Number(this.db.prepare("PRAGMA max_page_count=4096").get()!.max_page_count)<=4096,"message_state_capacity");
      if (initialize) tx(this.db, () => {
        this.db.exec(`CREATE TABLE meta(name TEXT PRIMARY KEY,value TEXT NOT NULL);
          CREATE TABLE receipts(id TEXT PRIMARY KEY,caller TEXT NOT NULL,hash TEXT NOT NULL,
            stamp INTEGER NOT NULL,payload TEXT,state TEXT NOT NULL,result TEXT);
          CREATE TABLE buckets(caller TEXT PRIMARY KEY,tokens REAL NOT NULL,observed INTEGER NOT NULL);
          CREATE TABLE attempts(id TEXT PRIMARY KEY,command_id TEXT NOT NULL,binding TEXT NOT NULL,expires INTEGER NOT NULL,result TEXT,caller TEXT NOT NULL);
          CREATE INDEX attempts_caller ON attempts(caller);
          CREATE TABLE transport_buckets(caller TEXT PRIMARY KEY,tokens REAL NOT NULL,observed INTEGER NOT NULL);`);
        meta(this.db).put("binding",binding); meta(this.db).put("observed","0");
      });
      check(meta(this.db).get("binding")===binding,"message_state_binding");
      // Never fix a damaged or partially initialized store by opening it.
      check(this.db.prepare("PRAGMA quick_check").get()!.quick_check==="ok","message_state_corrupt");
      const fd=openSync(path+".lock",constants.O_CREAT|constants.O_RDWR|constants.O_NOFOLLOW,0o600);
      this.lock=fd;
      const s=fstatSync(fd);
      check(s.isFile() && s.nlink===1 && s.uid===process.geteuid!() && (s.mode&0o077)===0,"message_lock_file");
      check(flockSync(fd)==="locked","message_busy");
    } catch(e) { this.close(); throw e; }
  }
  close(): void {
    this.db.close();
    if(this.lock!==undefined) { closeSync(this.lock); this.lock=undefined; }
  }
  get(id:string):Row|undefined { return this.db.prepare("SELECT * FROM receipts WHERE id=?").get(id) as unknown as Row|undefined; }
  /** Clock rollback is measured against observed wall time, never request order. */
  maintain(now:number,callers?:string[]): boolean {
    return tx(this.db,()=>{
      this.db.prepare("DELETE FROM attempts WHERE expires<?").run(now);
      const observed=Number(meta(this.db).get("observed"));
      check(Number.isSafeInteger(observed),"message_clock_state");
      if(now<observed-300_000) return false;
      meta(this.db).put("observed",String(Math.max(now,observed)));
      if(callers){check(callers.length<=8,"message_callers");for(const table of ["buckets","transport_buckets"])this.db.prepare("DELETE FROM "+table+" WHERE caller NOT IN ("+callers.map(()=>"?").join(",")+")").run(...callers);}
      this.db.prepare("UPDATE receipts SET payload=NULL WHERE stamp<? AND state IN ('uncertain','dispatching')").run(now-WINDOW);
      this.db.prepare("DELETE FROM receipts WHERE stamp<?").run(now-RETENTION);
      return true;
    });
  }
  begin(row:Omit<Row,"state"|"result">, rate=false, now=Date.now()):void {
    check(Buffer.byteLength(row.payload??"")<=8192,"message_payload_size");
    tx(this.db,()=>{
      check(Number(this.db.prepare("SELECT count(*) AS n FROM receipts").get()!.n)<10_000,"message_capacity");
      check(Number(this.db.prepare("SELECT count(*) AS n FROM receipts WHERE state IN ('dispatching','uncertain') AND payload IS NOT NULL").get()!.n)<128,"message_unresolved_capacity");
      check(Number(this.db.prepare("SELECT count(*) AS n FROM receipts WHERE caller=? AND state IN ('dispatching','uncertain') AND payload IS NOT NULL").get(row.caller)!.n)<16,"message_caller_capacity");
      if(rate) this.consume(row.caller,now);
      this.db.prepare("INSERT INTO receipts VALUES(?,?,?,?,?,'dispatching',NULL)").run(row.id,row.caller,row.hash,row.stamp,row.payload);
    });
  }
  attempt(id:string):{command_id:string;binding:string;expires:number;result:string|null}|undefined {
    return this.db.prepare("SELECT * FROM attempts WHERE id=?").get(id) as never;
  }
  reserve(id:string,command:string,binding:string,expires:number,now:number,receiver=false,caller=""):void {
    tx(this.db,()=>{
      this.db.prepare("DELETE FROM attempts WHERE expires<?").run(now);
      check(!this.attempt(id),"message_attempt_conflict");
      check(Number(this.db.prepare("SELECT count(*) AS n FROM attempts").get()!.n)<(receiver?10000:128),"message_attempt_capacity");
      if(receiver)check(caller.length>0&&Number(this.db.prepare("SELECT count(*) AS n FROM attempts WHERE caller=?").get(caller)!.n)<1000,"message_caller_attempt_capacity");
      check(Buffer.byteLength(binding)<=2048,"message_attempt_binding");
      this.db.prepare("INSERT INTO attempts VALUES(?,?,?,?,NULL,?)").run(id,command,binding,expires,caller);
    });
  }
  answer(id:string,result:Receipt):void {
    check(Buffer.byteLength(JSON.stringify(result))<=2048,"message_receipt_size");
    this.db.prepare("UPDATE attempts SET result=? WHERE id=? AND result IS NULL").run(JSON.stringify(result),id);
  }
  forget(id:string):void {this.db.prepare("DELETE FROM attempts WHERE id=?").run(id);}
  admit(caller:string,now:number):void {tx(this.db,()=>{
    check(this.db.prepare("SELECT 1 FROM transport_buckets WHERE caller=?").get(caller)||Number(this.db.prepare("SELECT count(*) AS n FROM transport_buckets").get()!.n)<8,"message_callers");
    this.consume(caller,now,"transport_buckets",8,1000);
  });}
  consume(caller:string,now:number,table:"buckets"|"transport_buckets"="buckets",burst=2,interval=6000):void {
    const bucket=this.db.prepare("SELECT * FROM "+table+" WHERE caller=?").get(caller) as {tokens:number;observed:number}|undefined;
    const tokens=Math.min(burst,(bucket?.tokens??burst)+Math.max(0,now-(bucket?.observed??now))/interval);
    check(tokens>=1,"message_rate");
    this.db.prepare("INSERT INTO "+table+" VALUES(?,?,?) ON CONFLICT(caller) DO UPDATE SET tokens=excluded.tokens,observed=excluded.observed")
      .run(caller,tokens-1,Math.max(now,bucket?.observed??now));
  }
  retry(id:string,caller:string,now:number,rate=false):void {
    tx(this.db,()=>{
      if(rate)this.consume(caller,now);
      this.db.prepare("UPDATE receipts SET state='dispatching' WHERE id=?").run(id);
    });
  }
  finish(id:string,receipt:Receipt):void {
    tx(this.db,()=>{
      this.db.prepare("UPDATE receipts SET state=?,result=?,payload=CASE WHEN ? IN ('accepted','rejected','conflict') THEN NULL ELSE payload END WHERE id=?")
        .run(receipt.state,JSON.stringify(receipt),receipt.state,id);
    });
  }
}
