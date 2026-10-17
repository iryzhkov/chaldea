import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { WakeStore } from "../../src/wake/store.ts";
import { DAY, MAX_AGE } from "../../src/waits/types.ts";
import { completion } from "../../src/waits/completion.ts";
import { scratchDir } from "../helpers/scratch.ts";
import type { WaitSnapshot,WaitRun } from "../../src/t3/waits.ts";

const iso=(n:number)=>new Date(n).toISOString();
function fixture(){
  const dir=scratchDir("wake-store");
  const path=join(dir.path,"wake.sqlite");const store=new WakeStore(path,"test-env");
  return {path,store,close(){store.close();dir.remove();}};
}
const wait=(n=0,now=Date.now())=>({threadId:"parent-"+n,requestId:now+":wait-"+n,condition:{kind:"time",at:iso(now)}});
const question=(now=Date.now())=>({threadId:"parent",requestId:now+":question",question:"Proceed later?",options:["Defer","Run"],
  default:"Defer",defaultSafe:true,defaultAction:"defer",deadline:iso(now+1000)});
test("transactional resolution, stable retry keys, cancel, payload limits, reopen",()=>{
  const f=fixture();
  try{
    const now=Date.now();const input=wait(0,now);
    const reg=f.store.prepare("wait",input);
    const row=f.store.register(reg,"project",null);
    assert.equal(f.store.register(f.store.prepare("wait",input),"project",null).id,row.id);
    assert.throws(()=>f.store.prepare("wait",{...input,condition:{kind:"time",at:"2026-10-16T10:00:00"}}),/offset/);
    assert.throws(()=>f.store.existing(f.store.prepare("wait",{...input,deadline:iso(now+1234)})),/changed payload/);
    f.store.resolve(row.id,{reason:"time"});f.store.resolve(row.id,{reason:"timeout"});
    assert.equal(f.store.deliveries().length,1);
    const delivery=f.store.deliveries()[0]!;
    const payload=JSON.parse(delivery.payload);
    assert.equal(payload.commandId,payload.messageId);
    assert.deepEqual(payload.dispatchMode,{type:"queue_after_active"});
    assert.equal(payload.notification,undefined);
    assert.ok(payload.text.startsWith("Chaldea wake"));
    assert.ok(Buffer.byteLength(delivery.payload)<=4096);
    assert.equal(f.store.cancel(row.id).delivery,"suppressed");
    f.store.retry(delivery.id,now);
    assert.equal(f.store.deliveries()[0]!.state,"suppressed","retry cannot revive a cancelled delivery");
    const other=f.store.register(f.store.prepare("wait",wait(1,now)),"project",null);
    f.store.resolve(other.id,{reason:"time"});const d=f.store.deliveries().find(d=>d.item===other.id)!;
    f.store.claim(d.id);assert.equal(f.store.cancel(other.id).delivery,"uncertain_in_flight");
    f.store.sent(d.id);assert.equal(f.store.cancel(other.id).delivery,"already_delivered");
    assert.throws(()=>f.store.prepare("decision",{...question(),defaultSafe:false}),/Default/);
    assert.throws(()=>f.store.prepare("decision",{...question(),defaultAction:"approve"}),/Default/);
    assert.throws(()=>f.store.prepare("decision",{...question(),default:"other"}),/Default/);
    assert.throws(()=>f.store.prepare("decision",{...question(),question:"x".repeat(1025)}),/question/);
    assert.throws(()=>new WakeStore(f.path,"changed-environment"),/another environment/);
  }finally{f.close();}
});
test("answer/deadline serializations and concurrent processes latch exactly one immutable outcome",async()=>{
  const f=fixture();
  try{
    const now=Date.now();const q=question(now);q.deadline=iso(now+250);
    const row=f.store.register(f.store.prepare("decision",q),"project",null);
    const children=Array.from({length:8},(_,i)=>new Promise<void>((resolveChild,reject)=>{
      const child=spawn(process.execPath,[resolve("test/helpers/answer-racer.ts"),f.path,row.id,i%2?"Run":"Defer"],
        {env:{...process.env,TMPDIR:process.env.TMPDIR!},stdio:"pipe"});
      let err="";child.stderr.on("data",b=>err+=b);
      child.once("exit",code=>code===0?resolveChild():reject(new Error(err)));
    }));
    await Promise.all(children);
    const outcome=f.store.get(row.id).outcome;
    f.store.answer(row.id,"Run",now+5000);
    assert.equal(f.store.get(row.id).outcome,outcome);
    assert.equal(f.store.deliveries().length,1);
    const q2={...question(now),requestId:now+":q2",deadline:iso(now-1)};
    const row2=f.store.register(f.store.prepare("decision",q2),"project",null);
    assert.deepEqual(JSON.parse(f.store.answer(row2.id,"Run",now).outcome!),{reason:"deadline",answer:"Defer",defaulted:true});
    const q3={...question(now),requestId:now+":q3"};
    const row3=f.store.register(f.store.prepare("decision",q3),"project",null);
    assert.deepEqual(JSON.parse(f.store.answer(row3.id,"Run",now).outcome!),{reason:"answered",answer:"Run",defaulted:false});
  }finally{f.close();}
});
test("active bounds, cycle rejection, retention fence and protected pending delivery",()=>{
  const f=fixture();
  try{
    const now=Date.now();
    const a={...wait(0,now),threadId:"a",condition:{kind:"thread",threadId:"b"}};
    f.store.register(f.store.prepare("wait",a),"project","run");
    assert.throws(()=>f.store.register(f.store.prepare("wait",{...a,requestId:now+":b",threadId:"b",condition:{kind:"thread",threadId:"a"}}),"project","run"),/cycle/);
    for(let i=1;i<128;i++)f.store.register(f.store.prepare("wait",wait(i,now)),"project",null);
    assert.throws(()=>f.store.register(f.store.prepare("wait",wait(128,now)),"project",null),/limit/);
    const first=f.store.active()[0]!;f.store.resolve(first.id,{reason:"done"});
    f.store.db.prepare("UPDATE items SET terminal=? WHERE id=?").run(now-MAX_AGE-1,first.id);
    f.store.maintain(now);assert.equal(f.store.get(first.id).state,"resolved","pending wake survives age expiry");
    const d=f.store.deliveries()[0]!;f.store.sent(d.id);
    f.store.maintain(now);
    assert.throws(()=>f.store.get(first.id),/Unknown/);
    assert.throws(()=>f.store.register(f.store.prepare("wait",a),"project","run"),/retired/);
    assert.ok(f.store.bytes()<64*1024*1024);
    assert.throws(()=>f.store.prepare("wait",{...wait(),requestId:(now-MAX_AGE-1)+":old"}),/replay age/);
    assert.throws(()=>f.store.prepare("wait",{...wait(),deadline:iso(now+37*DAY)}),/maximum/);
  }finally{f.close();}
});
test("retention caps terminal tombstones at 10,000 while protecting active/pending rows",()=>{
  const f=fixture();
  try{
    const now=Date.now();
    f.store.transaction(()=>{
      const insert=f.store.db.prepare("INSERT INTO items(id,kind,parent,project,request_key,request_at,hash,input,deadline,state,created,terminal) VALUES(?,'wait','p','project',?,?,'hash','{}',?,'cancelled',?,?)");
      for(let i=0;i<10010;i++)insert.run(String(i),now+":r"+i,now-i,now,now,now-i);
    });
    f.store.maintain(now);
    assert.equal((f.store.db.prepare("SELECT count(*) AS n FROM items").get() as {n:number}).n,10000);
    assert.ok(Number(f.store.meta("replay_fence"))>0);
  }finally{f.close();}
});
const run=(id:string,status="completed",extra:Partial<WaitRun>={}):WaitRun=>({id,status,ordinal:1,started:"2026-10-17T00:00:00Z",workStarted:null,restartOf:null,failure:null,root:"node",...extra});
const snapshot=(runs:WaitRun[]):WaitSnapshot=>({id:"target",project:"p",archived:false,deleted:false,settled:false,runs,pendingRuns:[],children:[]});
test("completion pins a run, follows restart/quota/provider lineage and children; questions/limits stay pending",()=>{
  const s=snapshot([run("a")]);
  assert.equal(completion(s,"missing"),null);
  assert.deepEqual(completion(s,"a"),{reason:"completed",runId:"a"});
  s.runs.push(run("b","running",{ordinal:2,restartOf:"a"}));
  assert.equal(completion(s,"a"),null);
  s.runs[1]!.status="completed";assert.equal(completion(s,"a")?.runId,"b");
  s.runs[1]!.failure="usage_limit";s.runs[1]!.status="failed";assert.equal(completion(s,"a"),null);
  s.runs.push(run("c","running",{ordinal:3,workStarted:s.runs[0]!.started}));
  assert.equal(completion(s,"a"),null);
  s.runs[2]!.status="completed";
  s.children.push({id:"child",runId:"c",childThreadId:"child-thread",status:"waiting"});
  assert.equal(completion(s,"a"),null);
  s.children[0]!.status="completed";s.pendingRuns.push("c");assert.equal(completion(s,"a"),null);
  s.pendingRuns=[];assert.equal(completion(s,"a")?.runId,"c");
});
