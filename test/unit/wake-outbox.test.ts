import assert from "node:assert/strict";
import { test } from "node:test";
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
  return {port,payloads,committed,remove(){parent=null;}};
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
      question:"Should this wait?",options:["Defer","Continue"],default:"Defer",defaultSafe:true,defaultAction:"defer",deadline:iso(Date.now()+150)});
    await until(()=>store.get(row.id).outcome!==null);
    await until(()=>store.deliveries().find(d=>d.channel==="wake")?.state==="sent");
    assert.equal(JSON.parse(store.get(row.id).outcome!).defaulted,true);
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
