import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync, writeFileSync, symlinkSync } from "node:fs";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import { privateFile } from "../../src/waits/config.ts";
import { Deadlines } from "../../src/waits/deadlines.ts";
import { scratchDir } from "../helpers/scratch.ts";
import type { WaitT3, WaitSnapshot } from "../../src/t3/waits.ts";
const iso=(n:number)=>new Date(n).toISOString();
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(probe:()=>boolean){const end=Date.now()+5000;while(!probe()){if(Date.now()>end)throw new Error("Timed out");await sleep(10);}}
function fake(){
  let parent:WaitSnapshot|null={id:"parent",project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[]};
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
  let engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385"});
  try{
    engine.start();
    const row=await engine.register("wait",{threadId:"parent",requestId:Date.now()+":wait",condition:{kind:"time",at:iso(Date.now()-1)}});
    await until(()=>store.deliveries()[0]?.state==="sent");
    assert.equal(t3.committed.size,1);assert.equal(t3.payloads.length,2);
    assert.equal(t3.payloads[0],t3.payloads[1]);assert.equal(store.get(row.id).state,"resolved");
    await engine.stop();store.close();
    store=new WakeStore(path,"test-env");engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385"});engine.start();
    await sleep(100);assert.equal(t3.payloads.length,2);
  }finally{await engine.stop();store.close();dir.remove();}
});
test("deleted parent parks a resolved wake; missing relay cannot delay the default",async()=>{
  const dir=scratchDir("wake-orphan");const t3=fake();const store=new WakeStore(join(dir.path,"db"),"test-env");
  const engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385"});
  try{
    engine.start();
    const row=await engine.register("decision",{threadId:"parent",requestId:Date.now()+":decision",
      question:"Should this wait?",options:["Defer","Continue"],dependentAction:"run the dependent step",defaultAction:"defer",deadline:iso(Date.now()+150)});
    await until(()=>store.get(row.id).outcome!==null);
    await until(()=>store.deliveries().find(d=>d.channel==="wake")?.state==="sent");
    assert.equal(JSON.parse(store.get(row.id).outcome!).defaulted,true);
    const phone=store.deliveries().find(d=>d.item===row.id && d.channel==="phone")!;
    assert.equal(phone.state,"undeliverable");assert.equal(phone.disposition,"relay_unprovisioned");assert.equal(phone.attempts,0);
    for(let i=0;i<10;i++)engine.poke();
    await sleep(350);
    assert.deepEqual(store.deliveries().find(d=>d.id===phone.id),phone);
    const reg=store.prepare("wait",{threadId:"parent",requestId:Date.now()+":orphan",condition:{kind:"time",at:iso(Date.now()-1)}});
    const orphan=store.register(reg,"project",null);store.resolve(orphan.id,{reason:"time"});t3.remove();engine.poke();
    await until(()=>store.get(orphan.id).state==="orphaned");
    assert.equal(store.get(orphan.id).disposition,"parent_deleted");
    assert.ok(!t3.payloads.some(p=>JSON.parse(p).commandId.includes(orphan.id)));
  }finally{await engine.stop();store.close();dir.remove();}
});
test("calendar timer fires an overdue absolute deadline and rearming cancels the old one",async()=>{
  const timer=new Deadlines();let fires=0;let failure=false;
  try{
    timer.arm(Date.now()+50,()=>fires++,()=>{failure=true;});
    timer.arm(Date.now()+150,()=>fires++,()=>{failure=true;});
    await sleep(90);assert.equal(fires,0);
    await until(()=>fires===1);
    timer.arm(Date.now()-1000,()=>fires++,()=>{failure=true;});
    await until(()=>fires===2);assert.equal(failure,false);
    await sleep(50);assert.equal(fires,2);
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
    const row=store.register(reg,"project",null);store.resolve(row.id,{reason:"time"});
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

test("stalled relay requests never occupy wake delivery capacity",async()=>{
  const dir=scratchDir("wake-relay-slots");const t3=fake();const store=new WakeStore(join(dir.path,"db"),"test-env");
  let release!:()=>void;const stalled=new Promise<void>(r=>release=r);
  const engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385",notify:()=>stalled});
  try{
    engine.start();
    for(let i=0;i<8;i++)await engine.register("decision",{threadId:"parent",requestId:Date.now()+":q"+i,
      question:"Defer?",options:["Defer","Continue"],dependentAction:"run the dependent step",defaultAction:"defer",deadline:iso(Date.now()+5000)});
    const row=await engine.register("wait",{threadId:"parent",requestId:Date.now()+":independent",condition:{kind:"time",at:iso(Date.now()+50)}});
    await until(()=>store.deliveries().some(d=>d.item===row.id&&d.state==="sent"));
    assert.ok(store.deliveries().filter(d=>d.channel==="phone"&&d.state==="sending").length===2);
    assert.equal(store.get(row.id).state,"resolved");
  }finally{release();await engine.stop();store.close();dir.remove();}
});

test("configured relay retries use persisted bounded backoff",async()=>{
  const dir=scratchDir("wake-relay-backoff");const t3=fake();const store=new WakeStore(join(dir.path,"db"),"test-env");
  const attempts:number[]=[];
  const engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385",notify:async()=>{attempts.push(Date.now());throw new Error("Fake offline relay");}});
  try{
    engine.start();
    const row=await engine.register("decision",{threadId:"parent",requestId:Date.now()+":retry",
      question:"Deploy?",options:["Approve deploy","Hold"],dependentAction:"deploy",defaultAction:"defer",deadline:iso(Date.now()+10_000)});
    await until(()=>attempts.length>=3);
    const phone=store.deliveries().find(d=>d.item===row.id && d.channel==="phone")!;
    assert.equal(phone.state,"pending");assert.equal(phone.attempts,3);
    assert.ok(attempts[1]!-attempts[0]!>=200);assert.ok(attempts[2]!-attempts[1]!>=450);
    assert.ok(phone.next_at>Date.now());assert.ok(phone.next_at<=Date.now()+30_000);
  }finally{await engine.stop();store.close();dir.remove();}
});
test("archived parent after ambiguous send is uncertain, retained and never resent after restart",async()=>{
  const dir=scratchDir("wake-archived-ambiguous");const path=join(dir.path,"db");const t3=fake();
  const dispatch=t3.port.dispatch;
  t3.port.dispatch=async p=>{try{await dispatch(p);}finally{t3.archive();}};
  let store=new WakeStore(path,"test-env");let engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385"});
  try{
    engine.start();
    const row=await engine.register("wait",{threadId:"parent",requestId:Date.now()+":ambiguous",condition:{kind:"time",at:iso(Date.now()-1)}});
    await until(()=>store.get(row.id).state==="orphaned");
    const wake=store.deliveries().find(d=>d.item===row.id)!;
    assert.equal(wake.state,"uncertain");assert.equal(wake.disposition,"parent_inactive");
    assert.equal(t3.payloads.length,1);assert.equal(t3.committed.size,1);
    store.maintain(Date.now()+43*86_400_000);assert.equal(store.get(row.id).state,"orphaned");
    await engine.stop();store.close();
    store=new WakeStore(path,"test-env");engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385"});engine.start();
    await sleep(400);assert.equal(store.deliveries()[0]!.state,"uncertain");assert.equal(t3.payloads.length,1);
  }finally{await engine.stop();store.close();dir.remove();}
});
test("external SQLite reader backs off once and recovers an overdue deadline, including startup",async()=>{
  const dir=scratchDir("wake-checkpoint");const path=join(dir.path,"db");const t3=fake();
  let store=new WakeStore(path,"test-env");let reader:DatabaseSync|undefined;
  const events:string[]=[];let engine:WaitEngine|undefined;
  try{
    const reg=store.prepare("wait",{threadId:"parent",requestId:Date.now()+":reader",condition:{kind:"time",at:iso(Date.now()+100)}});
    const row=store.register(reg,"project",null);
    reader=new DatabaseSync(path,{readOnly:true});reader.exec("BEGIN");reader.prepare("SELECT * FROM items").all();
    // Pin a previous WAL generation exactly as an external reader does.
    store.db.prepare("UPDATE meta SET value='1' WHERE key='replay_fence'").run();
    store.close();store=new WakeStore(path,"test-env");
    engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385",report:e=>events.push(e)});engine.start();
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
  const engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385",report:e=>events.push(e)});
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

test("checkpoint backoff during synchronous phone claims logs once for the blocked episode",async()=>{
  const dir=scratchDir("wake-phone-checkpoint");const path=join(dir.path,"db");
  const store=new WakeStore(path,"test-env");const t3=fake();let reader:DatabaseSync|undefined;
  const events:string[]=[];let calls=0;let release!:()=>void;
  const stalled=new Promise<void>(r=>release=r);
  const engine=new WaitEngine(store,t3.port,{answerBaseUrl:"http://127.0.0.1:7385",report:e=>events.push(e),notify:async()=>{
    if(calls++===0){
      reader=new DatabaseSync(path,{readOnly:true});reader.exec("BEGIN");reader.prepare("SELECT * FROM items").all();
      store.db.prepare("UPDATE meta SET value='1' WHERE key='replay_fence'").run();await stalled;
    }
  }});
  try{
    const now=Date.now();
    for(let i=0;i<2;i++)store.register(store.prepare("decision",{threadId:"parent",requestId:now+":phone"+i,
      question:"Deploy?",options:["Approve","Hold"],dependentAction:"deploy",defaultAction:"defer",deadline:iso(now+10_000)}),"project",null,"{}");
    engine.start();await until(()=>events.includes("checkpoint_blocked"));await sleep(850);
    assert.equal(events.filter(e=>e==="checkpoint_blocked").length,1);assert.equal(calls,1);
    reader!.exec("ROLLBACK");reader!.close();reader=undefined;release();
    await until(()=>store.deliveries().filter(d=>d.state==="sent").length===2);
    assert.equal(calls,2);assert.equal(events.filter(e=>e==="checkpoint_blocked").length,1);
  }finally{reader?.close();release();await engine.stop();store.close();dir.remove();}
});
