import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import { Deadlines } from "../../src/waits/deadlines.ts";
import { WAIT_TOOLS } from "../../src/mcp.ts";
import { scratchDir } from "../helpers/scratch.ts";
import type { WaitT3, WaitSnapshot } from "../../src/t3/waits.ts";

// Capture one test epoch; explicit clock arguments stay deterministic without aging past retention.
const now=Date.now();
const iso=(n:number)=>new Date(n).toISOString();
function fixture(){
  const dir=scratchDir("multiwait"),path=join(dir.path,"db");
  let store=new WakeStore(path,"env");
  return {get store(){return store;},reopen(){store.close();store=new WakeStore(path,"env");},
    close(){store.close();dir.remove();}};
}
function add(store:WakeStore,key:string,parent="parent",target?:string){
  return store.register(store.prepare("wait",{threadId:parent,requestId:now+":"+key,
    condition:target?{kind:"thread",threadId:target}:{kind:"time",at:iso(now+86_400_000)}},now),"project",target?"run":null,now);
}
test("eight active waits, retry at capacity, optional server keys and independent decision rules",()=>{
  const f=fixture();
  try{
    const rows=Array.from({length:8},(_,i)=>add(f.store,"w"+i));
    assert.equal(add(f.store,"w0").id,rows[0]!.id);
    assert.throws(()=>add(f.store,"ninth"),/wait limit \(8\) per thread/);
    f.store.cancel(rows[0]!.id,now);add(f.store,"replacement");
    const input={threadId:"generated",condition:{kind:"time",at:iso(now)}};
    const a=f.store.prepare("wait",input,now),b=f.store.prepare("wait",input,now);
    assert.match(a.input.requestId,new RegExp("^"+now+":[a-f0-9-]+$"));
    assert.notEqual(a.input.requestId,b.input.requestId);
    const generated=f.store.register(a,"project",null,now);
    assert.equal(f.store.register(f.store.prepare("wait",a.input,now),"project",null,now).id,generated.id);
    assert.throws(()=>f.store.prepare("wait",{...input,requestId:null},now),/requestId/);
    const policy={threadId:"parent",requestId:now+":native",dependentAction:"run",defaultAction:"defer",deadline:iso(now+60_000)};
    f.store.register(f.store.prepare("native",policy,now),"project",null,now);
    assert.throws(()=>f.store.register(f.store.prepare("native",{...policy,requestId:now+":native2"},now),"project",null,now),/preparation/);
    assert.throws(()=>f.store.prepare("native",{...policy,requestId:undefined},now),/requestId/);
    const tool=WAIT_TOOLS.find(t=>t.name==="chaldea_wait")!;
    assert.ok(!tool.inputSchema.required.includes("requestId"));
    assert.ok(WAIT_TOOLS.find(t=>t.name==="chaldea_decision_prepare")!.inputSchema.required.includes("requestId"));
  }finally{f.close();}
});
test("wait descriptions validate, persist, reject changed retries and cover legacy pending rows",()=>{
  const f=fixture();
  try{
    const input={threadId:"parent",requestId:now+":context",condition:{kind:"time",at:iso(now)},description:'Recheck review availability "after reset"'};
    const row=f.store.register(f.store.prepare("wait",input,now),"project",null,now);
    assert.equal(f.store.existing(f.store.prepare("wait",input,now))!.id,row.id);
    assert.throws(()=>f.store.existing(f.store.prepare("wait",{...input,description:"different"},now)),/changed payload/);
    assert.throws(()=>f.store.existing(f.store.prepare("wait",{...input,description:undefined},now)),/changed payload/);
    for(const description of ["", " ", "x".repeat(513), "é".repeat(257), "line\nbreak", "tab\ttext", "escape\u001b", "bidi\u202e", "separator\u2028", null, 42])
      assert.throws(()=>f.store.prepare("wait",{...input,description},now),/description/);
    f.store.prepare("wait",{...input,description:"é".repeat(256)},now);
    const legacy=add(f.store,"legacy-pending");
    const thread=add(f.store,"thread-context","other-parent","target");
    f.reopen();
    assert.equal(JSON.parse(f.store.get(row.id).input).description,input.description);
    assert.equal(f.store.existing(f.store.prepare("wait",JSON.parse(f.store.get(legacy.id).input),now))!.id,legacy.id);
    f.store.resolve(row.id,{reason:"time"},undefined,now);
    const single=JSON.parse(f.store.deliveries().find(d=>d.item===row.id)!.payload).text;
    assert.ok(single.includes(JSON.stringify(input.description)));assert.ok(single.includes("target time reached"));
    f.store.resolve(legacy.id,{reason:"timeout"},undefined,now);
    const fallback=JSON.parse(f.store.deliveries().find(d=>d.item===legacy.id)!.payload).text;
    assert.ok(fallback.includes("Wait until "+iso(now+86_400_000)));assert.ok(fallback.includes("wait deadline reached"));
    f.store.resolve(thread.id,{reason:"completed",runId:"run"},undefined,now);
    const threadWake=JSON.parse(f.store.deliveries().find(d=>d.item===thread.id)!.payload).text;
    assert.ok(threadWake.includes("Wait for thread target run run"));assert.ok(threadWake.includes("target run completed"));
    const deleted=add(f.store,"deleted-context","deleted-parent","gone");
    f.store.resolve(deleted.id,{reason:"target_deleted"},undefined,now);
    assert.ok(JSON.parse(f.store.deliveries().find(d=>d.item===deleted.id)!.payload).text.includes("target thread deleted"));
    const tool=WAIT_TOOLS.find(t=>t.name==="chaldea_wait")!;
    assert.ok(!tool.inputSchema.required.includes("description"));
    assert.equal((tool.inputSchema.properties.description as {maxLength:number}).maxLength,512);
  }finally{f.close();}
});
test("cycle search follows every active edge, ignores time waits and permits convergent paths",()=>{
  const f=fixture();
  try{
    add(f.store,"b-time","b");add(f.store,"b-c","b","c");
    add(f.store,"b-d","b","d");add(f.store,"c-e","c","e");add(f.store,"d-e","d","e");
    add(f.store,"a-b","a","b");
    assert.throws(()=>add(f.store,"e-a","e","a"),/Dependency cycle/);
    f.store.cancel(f.store.active().find(i=>i.request_key===now+":b-c")!.id,now);
    assert.throws(()=>add(f.store,"e-a","e","a"),/Dependency cycle/,"second branch still reaches e");
    f.store.cancel(f.store.active().find(i=>i.request_key===now+":b-d")!.id,now);
    add(f.store,"e-a","e","a");
  }finally{f.close();}
});
test("combined wake freezes membership before send and replays byte-identically after crash",()=>{
  const f=fixture();
  try{
    const rows=Array.from({length:8},(_,i)=>f.store.register(f.store.prepare("wait",{
      threadId:"parent",requestId:now+":burst"+i,description:"Check result "+i,
      condition:{kind:"time",at:iso(now)}},now),"project",null,now));
    for(const [i,row] of rows.entries()){
      f.store.resolve(row.id,{reason:i%2?"timeout":"completed",...(i%2?{}:{runId:"run"+i})},undefined,now);
      f.store.resolve(row.id,{reason:"different"},undefined,now);
    }
    assert.equal(f.store.deliveries().length,8);
    assert.equal(f.store.dispatchable().length,1);
    const leader=f.store.dispatchable()[0]!;
    const claimed=f.store.claim(leader.id)!;
    const command=JSON.parse(claimed.payload);
    assert.deepEqual(command.dispatchMode,{type:"queue_after_active"});
    assert.equal(command.text.split("\n").length,10);
    for(const [i,row] of rows.entries()) {
      const line=command.text.split("\n").find((line:string)=>line.startsWith(row.id+": "))!;
      assert.ok(line.includes('Context: "Check result '+i+'"'));
      assert.ok(line.includes(i%2 ? "wait deadline reached" : "target run completed"));
      assert.ok(line.includes(f.store.get(row.id).outcome!));
    }
    assert.equal(new Set(f.store.deliveries().map(d=>d.payload)).size,1);
    assert.ok(f.store.deliveries().every(d=>d.state==="sending"&&d.attempts===1));
    for(const d of f.store.deliveries())if(d.id!==leader.id)assert.equal(f.store.claim(d.id),undefined);
    // Simulate T3 committing but the process dying before recording its receipt.
    const receipts=new Set([command.commandId]);
    const late=add(f.store,"late");f.store.resolve(late.id,{reason:"time"},undefined,now);
    f.reopen();
    const replay=f.store.claim(f.store.dispatchable()[0]!.id)!;
    assert.equal(replay.id,leader.id);assert.equal(replay.payload,claimed.payload);
    receipts.add(JSON.parse(replay.payload).commandId);assert.equal(receipts.size,1);
    assert.equal(f.store.cancel(rows[3]!.id).delivery,"uncertain_in_flight");
    f.store.sent(replay.id);
    assert.ok(f.store.deliveries().filter(d=>d.item!==late.id).every(d=>d.state==="sent"&&d.attempts===2));
    assert.equal(f.store.dispatchable().length,1);
    const next=f.store.claim(f.store.dispatchable()[0]!.id)!;
    assert.ok(JSON.parse(next.payload).text.includes(late.id));
    f.store.sent(next.id);f.reopen();assert.deepEqual(f.store.dispatchable(),[]);
  }finally{f.close();}
});
test("legacy outbox migration replays attempted bytes before batching new wakes",()=>{
  const f=fixture();
  try{
    const a=add(f.store,"legacy-attempted"),b=add(f.store,"legacy-new"),c=add(f.store,"legacy-new2");
    for(const row of [a,b,c])f.store.resolve(row.id,{reason:"time"},undefined,now);
    const old=f.store.deliveries().find(d=>d.item===a.id)!;
    // Reproduce the pre-multiwait schema and a crash during an ambiguous send.
    f.store.db.prepare("UPDATE outbox SET payload=? WHERE id=?").run(JSON.stringify({...JSON.parse(old.payload),text:"Chaldea wake (wait "+a.id+'): {"reason":"time"}'}),old.id);
    old.payload=f.store.deliveries().find(d=>d.id===old.id)!.payload;
    f.store.db.prepare("UPDATE outbox SET state='sending',attempts=1 WHERE id=?").run(old.id);
    f.store.db.exec("ALTER TABLE outbox DROP COLUMN batch_id; PRAGMA user_version=0");
    f.reopen();
    const recovered=f.store.dispatchable();
    assert.equal(recovered.length,1);assert.equal(recovered[0]!.id,old.id);
    const replay=f.store.claim(old.id)!;
    assert.equal(replay.payload,old.payload);assert.equal(replay.batch_id,null);
    assert.equal(replay.attempts,2);
    assert.ok(f.store.deliveries().filter(d=>d.id!==old.id).every(d=>d.attempts===0&&d.batch_id===null));
    f.store.sent(old.id);
    const next=f.store.claim(f.store.dispatchable()[0]!.id)!;
    assert.notEqual(next.id,old.id);
    assert.ok(JSON.parse(next.payload).text.includes(b.id));assert.ok(JSON.parse(next.payload).text.includes(c.id));
    assert.ok(!JSON.parse(next.payload).text.includes(a.id));
    f.store.sent(next.id);f.reopen();
    assert.ok(f.store.deliveries().every(d=>d.state==="sent"));
  }finally{f.close();}
});
test("a long undelivered backlog remains one combined message with every outcome",()=>{
  const f=fixture();
  try{
    const rows=Array.from({length:40},(_,i)=>{
      const row=add(f.store,"backlog"+i);
      f.store.resolve(row.id,{reason:"completed",runId:"r".repeat(256)},undefined,now);
      return row;
    });
    assert.ok(f.store.deliveries().every(d=>Buffer.byteLength(d.payload)<=4096));
    const claimed=f.store.claim(f.store.dispatchable()[0]!.id)!;
    assert.ok(Buffer.byteLength(claimed.payload)>4096);
    const text=JSON.parse(claimed.payload).text;
    for(const row of rows) { assert.ok(text.includes(row.id+": Context: ")); assert.ok(text.includes(f.store.get(row.id).outcome!)); }
    f.store.sent(claimed.id);
    assert.equal(f.store.deliveries().length,40);
    assert.ok(f.store.deliveries().every(d=>d.state==="sent"));
  }finally{f.close();}
});
test("decision retry keeps its own timer while a wait on the same parent is in flight", {timeout:10_000},async t=>{
  const f=fixture(),gate=Promise.withResolvers<void>(),armed:Array<number|undefined>=[];
  t.mock.method(Deadlines.prototype,"arm",(at:number|undefined)=>{armed.push(at);});
  const t3:WaitT3={
    async environment(){return "env";},
    async snapshot(id){await gate.promise;return {id,project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[]};},
    async observe(_id,signal){if(!signal.aborted)await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
    async dispatch(){},
  };
  const engine=new WaitEngine(f.store,t3);
  try{
    const a=add(f.store,"timer");f.store.resolve(a.id,{reason:"time"},undefined,now);
    const decision=f.store.register(f.store.prepare("decision",{threadId:"parent",requestId:now+":timer-decision",
      question:"Run?",options:["Run","Defer"],dependentAction:"run",defaultAction:"defer",deadline:iso(now+86_400_000)},now),"project",null,now);
    f.store.answer(decision.id,"Run","cli",now);
    const d=f.store.deliveries().find(d=>d.item===decision.id)!;
    const retryAt=Date.now()+30_000;f.store.retry(d.id,retryAt);
    engine.start();
    assert.equal(armed.at(-1),retryAt);
  }finally{gate.resolve();await engine.stop();f.close();}
});
test("cancellation before batching and rejection/orphan dispositions apply to each member",()=>{
  for(const action of ["block","orphan"] as const){
    const f=fixture();
    try{
      const a=add(f.store,"a"),b=add(f.store,"b"),cancelled=add(f.store,"cancel");
      for(const row of [a,b,cancelled])f.store.resolve(row.id,{reason:"time"},undefined,now);
      f.store.cancel(cancelled.id,now);
      const claimed=f.store.claim(f.store.dispatchable()[0]!.id)!;
      assert.ok(!JSON.parse(claimed.payload).text.includes(cancelled.id));
      if(action==="block")f.store.block(claimed.id);else f.store.orphan(b.id,"parent_deleted",now);
      const members=f.store.deliveries().filter(d=>d.item!==cancelled.id);
      assert.ok(members.every(d=>d.state===(action==="block"?"blocked":"uncertain")));
      assert.ok([a,b].every(row=>f.store.get(row.id).disposition===(action==="block"?"delivery_rejected":"parent_deleted")));
      f.reopen();assert.deepEqual(f.store.dispatchable(),[]);
    }finally{f.close();}
  }
});
test("engine joins waits resolved during async preflight, serializes one thread and drains from events", {timeout:10_000},async()=>{
  const dir=scratchDir("multi-engine"),store=new WakeStore(join(dir.path,"db"),"env");
  const snapshot=(id:string):WaitSnapshot=>({id,project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[]});
  const gate=Promise.withResolvers<void>(),preflight=Promise.withResolvers<void>();
  const firstSend=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),done=Promise.withResolvers<void>();
  const payloads:string[]=[];let engine:WaitEngine;
  const t3:WaitT3={
    async environment(){return "env";},
    async snapshot(id){preflight.resolve();await gate.promise;return snapshot(id);},
    async observe(_id,signal){if(!signal.aborted)await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
    async dispatch(payload){payloads.push(payload);if(payloads.length===1){firstSend.resolve();await release.promise;}},
  };
  engine=new WaitEngine(store,t3,{boundary(name){if(name==="delivered"&&payloads.length===2)done.resolve();}});
  try{
    const a=add(store,"engine-a"),b=add(store,"engine-b");
    store.resolve(a.id,{reason:"time"},undefined,now);engine.start();
    await preflight.promise;
    store.resolve(b.id,{reason:"timeout"},undefined,now);gate.resolve();
    await firstSend.promise;
    assert.ok(JSON.parse(payloads[0]!).text.includes(a.id));assert.ok(JSON.parse(payloads[0]!).text.includes(b.id));
    const late=add(store,"engine-late");store.resolve(late.id,{reason:"time"},undefined,now);engine.poke();
    assert.equal(payloads.length,1);
    release.resolve();await done.promise;
    assert.equal(payloads.length,2);assert.ok(store.deliveries().every(d=>d.state==="sent"));
    await engine.stop();engine=new WaitEngine(store,t3);engine.start();
    assert.equal(payloads.length,2);
  }finally{gate.resolve();release.resolve();await engine.stop();store.close();dir.remove();}
});
