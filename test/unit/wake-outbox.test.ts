import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import childProcess, { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { chmodSync, writeFileSync, symlinkSync } from "node:fs";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import { privateFile } from "../../src/waits/config.ts";
import { Deadlines } from "../../src/waits/deadlines.ts";
import { scratchDir } from "../helpers/scratch.ts";
import type { WaitT3, WaitSnapshot } from "../../src/t3/waits.ts";
const guard={version:1 as const,projectId:"project",lastStopCommandId:null,invalidationCommandId:null};
const iso=(n:number)=>new Date(n).toISOString();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(probe:()=>boolean){const end=Date.now()+5000;while(!probe()){if(Date.now()>end)throw new Error("Timed out");await sleep(10);}}
function fake(){
  let parent:WaitSnapshot|null={id:"parent",project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[],externalWakeGuard:guard};
  const payloads:string[]=[];const committed=new Set<string>();
  let ackLost=true;
  const port:WaitT3={
    async environment(){return "test-env";},async snapshot(){return parent;},
    async observe(_id,signal,on){await Promise.resolve();if(!signal.aborted)on(parent,1);
      if(!signal.aborted)await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
    async dispatch(payload){payloads.push(payload);committed.add(JSON.parse(payload).commandId);if(ackLost){ackLost=false;throw new Error("ACK lost after commit");}},
  };
  return {port,payloads,committed,remove(){parent=null;},archive(){parent={...parent!,archived:true};}};
}
test("outbox retries identical bytes after ambiguity, receipt gates delivery; restart never duplicates commit",async()=>{
  const dir=scratchDir("wake-outbox");const path=join(dir.path,"db.sqlite");
  const t3=fake();let store=new WakeStore(path,"test-env");
  let engine=new WaitEngine(store,t3.port,{});
  try{
    engine.start();
    const row=await engine.register("wait",{threadId:"parent",requestId:Date.now()+":wait",condition:{kind:"time",at:iso(Date.now()-1)}});
    await until(()=>store.deliveries()[0]?.state==="sent");
    assert.equal(t3.committed.size,1);assert.equal(t3.payloads.length,2);
    assert.equal(t3.payloads[0],t3.payloads[1]);assert.equal(store.get(row.id).state,"resolved");
    await engine.stop();store.close();
    store=new WakeStore(path,"test-env");engine=new WaitEngine(store,t3.port,{});engine.start();
    await sleep(100);assert.equal(t3.payloads.length,2);
  }finally{await engine.stop();store.close();dir.remove();}
});
test("deleted parent parks a resolved wake after a decision deadline",async()=>{
  const dir=scratchDir("wake-orphan");const t3=fake();const store=new WakeStore(join(dir.path,"db"),"test-env");
  const engine=new WaitEngine(store,t3.port,{});
  try{
    engine.start();
    const row=await engine.register("decision",{threadId:"parent",requestId:Date.now()+":decision",
      question:"Should this wait?",options:["Defer","Continue"],dependentAction:"run the dependent step",defaultAction:"defer",deadline:iso(Date.now()+150)});
    await until(()=>store.get(row.id).outcome!==null);
    await until(()=>store.deliveries().find(d=>d.channel==="wake")?.state==="sent");
    assert.equal(JSON.parse(store.get(row.id).outcome!).defaulted,true);
    assert.equal(store.deliveries().length,1);
    const reg=store.prepare("wait",{threadId:"parent",requestId:Date.now()+":orphan",condition:{kind:"time",at:iso(Date.now()-1)}});
    const orphan=store.register(reg,"project",null);store.resolve(orphan.id,{reason:"time"});t3.remove();engine.poke();
    await until(()=>store.get(orphan.id).state==="orphaned");
    assert.equal(store.get(orphan.id).disposition,"parent_deleted");
    assert.ok(!t3.payloads.some(p=>JSON.parse(p).commandId.includes(orphan.id)));
  }finally{await engine.stop();store.close();dir.remove();}
});
test("fatal storage errors log once, refuse registrations and exit non-zero for systemd recovery",{timeout:10_000},async()=>{
  const dir=scratchDir("wake-storage-fatal");
  try{
    for(const mode of ["maintenance","receipt","logger","tracking"]){
      const path=join(dir.path,mode+".sqlite");
      const result=await new Promise<{code:number|null;signal:string|null;out:string;err:string}>((resolveChild,reject)=>{
        const child=spawn(process.execPath,[resolve("test/helpers/waits-storage-failure.ts"),path,mode],{stdio:["ignore","pipe","pipe"],timeout:5000});
        let out="",err="";child.stdout.on("data",b=>out+=b);child.stderr.on("data",b=>err+=b);
        child.once("error",reject);child.once("exit",(code,signal)=>resolveChild({code,signal,out,err}));
      });
      assert.equal(result.signal,null,mode+": "+result.err);assert.equal(result.code,1,mode+": "+result.err);
      assert.equal(result.out.split("Watcher needs attention").length-1,1);
      assert.equal(result.out.split("storage_fault").length-1,mode==="receipt"?2:1);
      if(mode==="logger"){
        assert.equal(result.out.split("report_attempt").length-1,1);
        const records=result.err.trim().split("\n").map(line=>JSON.parse(line));
        assert.equal(records.length,1);
        assert.equal(records[0].message,"Chaldea waits: fatal storage error; restarting");
        assert.equal(records[0].level,"error");
        assert.equal(new Date(records[0].at).toISOString(),records[0].at);
      }else{
        assert.equal(result.out.split("watcher_needs_attention").length-1,1);assert.equal(result.err,"");
      }
      const recovered=new WakeStore(path,"test-env");
      try{if(mode==="receipt"){
        assert.equal(recovered.deliveries().length,2);
        assert.ok(recovered.deliveries().every(d=>d.state==="pending"&&d.attempts===1));
      }}finally{recovered.close();}
    }
  }finally{dir.remove();}
});
test("calendar rearming cancels the old helper and ignores stale completion", t=>{
  // Drive helper completion explicitly: no race between 50/90ms sleeps and
  // Python startup. The real timerfd path is exercised separately below.
  const children: Array<ChildProcess & { killedByTest: boolean }> = [];
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  t.mock.method(childProcess,"spawn",(command:string,args:readonly string[])=>{
    const child=Object.assign(new EventEmitter(),{
      killedByTest:false,
      kill(){this.killedByTest=true;return true;},
    }) as unknown as ChildProcess & { killedByTest: boolean };
    children.push(child);calls.push({command,args});return child;
  });
  syncBuiltinESMExports();
  const timer=new Deadlines();let fires=0;let failures=0;
  try{
    timer.arm(50,()=>fires++,()=>failures++);
    timer.arm(150,()=>fires++,()=>failures++);
    assert.equal(children.length,2);assert.equal(children[0]!.killedByTest,true);
    assert.equal(calls[0]!.command,"python3");
    assert.match(calls[0]!.args[0]!,/calendar\.py$/);
    assert.equal(calls[0]!.args[1],"50");assert.equal(calls[1]!.args[1],"150");
    children[0]!.emit("exit",0);assert.equal(fires,0);
    timer.arm(150,()=>fires++,()=>failures++);assert.equal(children.length,2);
    children[1]!.emit("exit",0);assert.equal(fires,1);
    timer.arm(0,()=>fires++,()=>failures++);
    assert.equal(calls[2]!.args[1],"1"); // Nonpositive absolute times are overdue.
    children[2]!.emit("exit",0);assert.equal(fires,2);assert.equal(failures,0);
    timer.arm(200,()=>fires++,()=>failures++);timer.clear();
    assert.equal(children[3]!.killedByTest,true);
    children[3]!.emit("exit",0);assert.equal(fires,2);
  }finally{timer.clear();t.mock.restoreAll();syncBuiltinESMExports();}
});
test("real calendar helper completes an overdue absolute deadline", {timeout:15_000}, async()=>{
  const timer=new Deadlines();
  try{
    await new Promise<void>((resolve,reject)=>{
      timer.arm(Date.now()-1000,resolve,()=>reject(new Error("calendar helper failed")));
    });
    assert.equal(timer.processId,undefined);
  }finally{timer.clear();}
});
test("credentials require owner-private regular files, and cannot be read via symlinks",()=>{
  const dir=scratchDir("wake-credentials");try{
    const path=join(dir.path,"token");writeFileSync(path,"fake-token",{mode:0o600});assert.equal(privateFile(path),"fake-token");
    symlinkSync(path,join(dir.path,"link"));assert.throws(()=>privateFile(join(dir.path,"link")));
    chmodSync(path,0o644);assert.throws(()=>privateFile(path),/0600/);
  }finally{dir.remove();}
});

test("recovered ambiguous wake cannot be cancelled as if it never reached T3",()=>{
  const dir=scratchDir("wake-cancel-recovery");const path=join(dir.path,"db");
  let store=new WakeStore(path,"test-env");
  try{
    const reg=store.prepare("wait",{threadId:"parent",requestId:Date.now()+":uncertain",condition:{kind:"time",at:iso(Date.now()-1)}});
    const row=store.register(reg,"project",null,Date.now(),[],null,null,guard);store.resolve(row.id,{reason:"time"});
    store.claim(store.deliveries()[0]!.id);store.close();store=new WakeStore(path,"test-env");
    assert.equal(store.cancel(row.id).delivery,"uncertain_in_flight");
    assert.equal(store.get(row.id).state,"resolved");
    assert.equal(store.deliveries()[0]!.state,"pending");
    assert.equal((store.db.prepare("PRAGMA max_page_count").get() as {max_page_count:number}).max_page_count,7936);
    assert.equal((store.db.prepare("PRAGMA cache_spill").get() as {cache_spill:number}).cache_spill,0);
  }finally{store.close();dir.remove();}
});
test("a killed calendar helper recovers its absolute deadline with one fire",async()=>{
  const timer=new Deadlines();let fires=0;let failures=0;
  try{
    timer.arm(Date.now()+400,()=>fires++,()=>failures++);
    assert.ok(timer.processId);process.kill(timer.processId,"SIGKILL");
    await until(()=>fires===1);
    assert.equal(failures,1);await sleep(100);assert.equal(fires,1);
  }finally{timer.clear();}
});

test("external SQLite reader backs off once and recovers an overdue deadline, including startup",async()=>{
  const dir=scratchDir("wake-checkpoint");const path=join(dir.path,"db");const t3=fake();
  let store=new WakeStore(path,"test-env");let reader:DatabaseSync|undefined;
  const events:string[]=[];let engine:WaitEngine|undefined;
  try{
    const reg=store.prepare("wait",{threadId:"parent",requestId:Date.now()+":reader",condition:{kind:"time",at:iso(Date.now()+100)}});
    const row=store.register(reg,"project",null,Date.now(),[],null,null,guard);
    reader=new DatabaseSync(path,{readOnly:true});reader.exec("BEGIN");reader.prepare("SELECT * FROM items").all();
    // Pin a previous WAL generation exactly as an external reader does.
    store.db.prepare("UPDATE meta SET value='1' WHERE key='replay_fence'").run();
    store.close();store=new WakeStore(path,"test-env");
    engine=new WaitEngine(store,t3.port,{report:e=>events.push(e)});engine.start();
    for(let i=0;i<10;i++)engine.poke();
    await sleep(850);
    assert.equal(events.filter(e=>e==="checkpoint_blocked").length,1);
    assert.equal(store.get(row.id).state,"parked");assert.equal(t3.payloads.length,0);
    assert.ok(!events.includes("watcher_needs_attention"));
    reader.exec("ROLLBACK");reader.close();reader=undefined;
    await until(()=>store.deliveries().some(d=>d.item===row.id&&d.state==="sent"));
    assert.equal(t3.committed.size,1);
  }finally{reader?.close();await engine?.stop();store.close();dir.remove();}
});
test("reader blocking receipt persistence never re-dispatches while waiting for checkpoint recovery",async()=>{
  const dir=scratchDir("wake-receipt-checkpoint");const path=join(dir.path,"db");
  const t3=fake();const store=new WakeStore(path,"test-env");let reader:DatabaseSync|undefined;
  const events:string[]=[];
  t3.port.dispatch=async payload=>{
    t3.payloads.push(payload);t3.committed.add(JSON.parse(payload).commandId);
    reader=new DatabaseSync(path,{readOnly:true});reader.exec("BEGIN");reader.prepare("SELECT * FROM items").all();
    store.db.prepare("UPDATE meta SET value='1' WHERE key='replay_fence'").run();
  };
  const engine=new WaitEngine(store,t3.port,{report:e=>events.push(e)});
  try{
    engine.start();
    const row=await engine.register("wait",{threadId:"parent",requestId:Date.now()+":receipt",condition:{kind:"time",at:iso(Date.now()-1)}});
    await until(()=>events.includes("checkpoint_blocked"));await sleep(850);
    assert.equal(events.filter(e=>e==="checkpoint_blocked").length,1);
    assert.equal(store.deliveries()[0]!.state,"sending");assert.equal(t3.payloads.length,1);
    reader!.exec("ROLLBACK");reader!.close();reader=undefined;
    await until(()=>store.deliveries()[0]!.state==="sent");
    assert.equal(t3.payloads.length,1);assert.equal(store.get(row.id).state,"resolved");
  }finally{reader?.close();await engine.stop();store.close();dir.remove();}
});
