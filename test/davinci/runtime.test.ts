import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync, copyFileSync } from "node:fs";
import { Coordinator, WorkerJournal } from "../../src/davinci/store.ts";
import { Worker } from "../../src/davinci/worker.ts";
import { assignment, binding, definition, digest, authenticate, signature, BODY, WINDOW, RETENTION } from "../../src/davinci/protocol.ts";
import { ingress } from "../../src/davinci/service.ts";
import type { Config } from "../../src/davinci/config.ts";
import type { SessionStatus } from "../../src/session/lifecycle.ts";
import { scratchDir } from "../helpers/scratch.ts";
const at=Date.parse("2026-10-21T12:00:00Z");
const def=()=>definition({id:"source-status",worker:"agent-a",environment:"fixture",epoch:"generation-1",preset:"reporter",
  presetHash:"a".repeat(64),source:"b".repeat(40),notBefore:at,utc:"12:00",enabled:true});
const status=(requestId:string,ended=false):SessionStatus=>({
  sessionId:"fixed-session",requestId,preset:"reporter",threadId:"fixed-thread",runId:"fixed-run",
  state:ended?"resolved":"parked",disposition:null,launch:"accepted",deadline:new Date(at+600000).toISOString(),
  outcome:ended?{kind:"session",reason:"completed"}:null,result:ended?"report":null,resultState:ended?"available":null,
  resultBytes:ended?6:null,occupancy:ended?"released":"held",released:ended?"observed":null,delivery:[],
});
test("UTC cursor and occurrence commit atomically; disabled, overlap and misfire are explicit skips",()=>{
  const dir=scratchDir("davinci-cursor"),d=def(),file=join(dir.path,"journal.sqlite");
  let c=new Coordinator(file,d);
  try {
    assert.throws(()=>c.tick(at,true,()=>{throw Error("crash");}),/crash/);
    assert.equal(c.scheduleStatus().cursor,null);assert.equal(c.rows().length,0);
    const a=c.tick(at)!;assert.ok(a);assert.equal(c.tick(at),null);
    c.close();c=new Coordinator(file,d);
    assert.deepEqual(c.status(a.id).assignment,a);
    assert.equal(c.tick(at+86400000),null);assert.match(c.scheduleStatus().lastSkip!,/overlap/);
    assert.equal(c.tick(at+2*86400000+60001),null);assert.match(c.scheduleStatus().lastSkip!,/misfire/);
    assert.equal(c.tick(at+3*86400000,false),null);assert.match(c.scheduleStatus().lastSkip!,/disabled/);
    assert.throws(()=>c.tick(at),/clock_rollback/);
    assert.throws(()=>definition({...d,utc:"* * * * *"}),/utc_daily_only/);
  } finally {c.close();dir.remove();}
});
test("stable webhook receipt, disabled intake, old delivery and changed body reject without new work",()=>{
  const dir=scratchDir("davinci-webhook"),c=new Coordinator(join(dir.path,"c.sqlite"),def());
  try {
    const id=at+":delivery",a=c.webhook(id,BODY,at);
    assert.deepEqual(c.webhook(id,BODY,at,false),a);
    assert.throws(()=>c.webhook(id,'{"job":"other"}',at),/delivery_conflict/);
    assert.throws(()=>c.webhook(at+":new",BODY,at,false),/disabled/);
    assert.throws(()=>c.webhook(id,BODY,at+WINDOW+1),/fixed_webhook/);
    assert.equal(c.rows().length,1);
  } finally {c.close();dir.remove();}
});
test("lost admission answer, worker reopen and original readonly lookup produce one identity; parked keeps slot",async()=>{
  const dir=scratchDir("davinci-worker"),d=def(),file=join(dir.path,"w.sqlite");
  let s=new WorkerJournal(file,d),starts=0,existing:SessionStatus|null=null;
  const a=assignment(d,"one",at);
  const admission={lookup:async()=>existing,status:async()=>existing!,start:async()=>{
    starts++;existing=status(a.requestId);throw Error("lost reply after commit");
  }};
  try {
    s.accept(JSON.stringify(a),at);
    let worker=new Worker(s,"caller",admission,()=>{},()=>at);
    assert.equal((await worker.recover(a.id,at)).disposition,"uncertain");
    s.close();s=new WorkerJournal(file,d);worker=new Worker(s,"caller",admission,()=>{},()=>at);
    const r=await worker.recover(a.id,at+WINDOW+1);
    assert.equal(r.status!.sessionId,"fixed-session");assert.equal(r.closed,false);assert.equal(starts,1);
    assert.throws(()=>s.accept(JSON.stringify(assignment(d,"other",at+WINDOW+1)),at+WINDOW+1),/worker_busy/);
    existing=status(a.requestId,true);
    assert.equal((await worker.recover(a.id,at+WINDOW+2)).closed,true);
    assert.equal(starts,1);
  } finally {s.close();dir.remove();}
});
test("expired uncertain intake cannot retry or free capacity; expiry before attempt can close",async()=>{
  const dir=scratchDir("davinci-expiry"),d=def(),s=new WorkerJournal(join(dir.path,"w.sqlite"),d);
  let starts=0;const a=assignment(d,"one",at);
  const api={lookup:async()=>null,status:async()=>{throw Error("offline");},start:async()=>{starts++;throw Error("lost");}};
  try {
    s.accept(JSON.stringify(a),at);
    const w=new Worker(s,"caller",api,()=>{},()=>at);
    await w.recover(a.id,at);
    assert.equal((await w.recover(a.id,at+WINDOW)).disposition,"uncertain");assert.equal(starts,1);
    assert.equal(s.active().length,1);
    const other=new WorkerJournal(join(dir.path,"unused.sqlite"),d);
    try {
      other.accept(JSON.stringify(a),at);
      const noStart=new Worker(other,"caller",api,()=>{throw Error("must not qualify");},()=>at);
      assert.equal((await noStart.recover(a.id,at+WINDOW)).disposition,"expired");
      assert.equal(starts,1);
    } finally {other.close();}
  } finally {s.close();dir.remove();}
});
test("revoked authority refuses before effect; stale epoch and restored journal cannot admit",async()=>{
  const dir=scratchDir("davinci-fence"),d=def(),file=join(dir.path,"worker.sqlite"),s=new WorkerJournal(file,d);
  let starts=0;const a=assignment(d,"one",at);
  try {
    s.accept(JSON.stringify(a),at);
    const w=new Worker(s,"caller",{lookup:async()=>null,status:async()=>status(a.requestId),start:async()=>{starts++;return status(a.requestId);}},
      ()=>{throw Error("revoked");},()=>at);
    assert.equal((await w.recover(a.id,at)).disposition,"uncertain");assert.equal(starts,0);
    assert.throws(()=>s.accept(JSON.stringify(assignment({...d,epoch:"old"},"two",at)),at),/assignment_binding/);
    s.maintain(at);copyFileSync(file,join(dir.path,"backup.sqlite"));
  } finally {s.close();}
  assert.throws(()=>new WorkerJournal(join(dir.path,"backup.sqlite"),{...d,epoch:"generation-2"}),/journal_binding/);
  dir.remove();
});
test("result sequence ignores reorder, conflicts reject, finite capacity protects pending ownership",async()=>{
  const dir=scratchDir("davinci-results"),d=def(),c=new Coordinator(join(dir.path,"c.sqlite"),d),
    s=new WorkerJournal(join(dir.path,"w.sqlite"),d);
  try {
    const a=c.tick(at)!;s.accept(JSON.stringify(a),at);
    const first=s.observe(a.id,status(a.requestId),"session",at),last=s.observe(a.id,status(a.requestId,true),"session",at);
    const receipt=c.result(JSON.stringify(last),at);c.result(JSON.stringify(first),at);c.result(JSON.stringify(last),at);
    assert.equal(c.status(a.id).result!.closed,true);
    assert.throws(()=>c.result(JSON.stringify({...last,status:{...last.status!,result:"changed"}}),at),/conflict/);
    c.confirm(JSON.stringify({...receipt,kind:"receipt-confirmed"}));
    c.maintain(at+RETENTION+1);assert.equal(c.rows().length,0);
    assert.throws(()=>c.webhook(at+":old",BODY,at+RETENTION+1),/fixed_webhook/);
    // Populate the finite journal with unresolved ownership, using valid bounded assignments.
    const insert=s.db.prepare("INSERT INTO work(id,at,assignment) VALUES(?,?,?)");
    s.db.prepare("DELETE FROM work").run();
    for(let i=0;i<512;i++){const x=assignment(d,"pending-"+i,at);insert.run(x.id,at,JSON.stringify(x));}
    s.maintain(at+RETENTION+1);assert.equal(s.rows().length,512);
    assert.throws(()=>s.accept(JSON.stringify(assignment(d,"fresh",at+RETENTION+1)),at+RETENTION+1),/worker_busy|capacity/);
  } finally {s.close();c.close();dir.remove();}
});

test("lookup completing across admission deadline never starts; expired first delivery clears overlap",async()=>{
  const dir=scratchDir("davinci-deadline-boundary"),d=def(),c=new Coordinator(join(dir.path,"c.sqlite"),d),
    s=new WorkerJournal(join(dir.path,"w.sqlite"),d);
  let clock=at+WINDOW-1,starts=0;
  try {
    const a=c.tick(at)!;s.accept(JSON.stringify(a),clock);
    const w=new Worker(s,"caller",{lookup:async()=>{clock=at+WINDOW+1;return null;},
      status:async()=>{throw Error("absent");},start:async()=>{starts++;return status(a.requestId);}},()=>{},()=>clock);
    const expired=await w.recover(a.id,at+WINDOW-1);
    assert.equal(expired.disposition,"expired");assert.equal(starts,0);
    c.result(JSON.stringify(expired),clock);
    assert.ok(c.tick(at+86400000),"deadline produces a committed outcome and permits next occurrence");
    const later=new WorkerJournal(join(dir.path,"late.sqlite"),d);
    try {
      later.accept(JSON.stringify(a),at+WINDOW+10);
      const never=new Worker(later,"caller",{lookup:async()=>null,status:async()=>status(a.requestId),
        start:async()=>{starts++;return status(a.requestId);}},()=>{throw Error("must not qualify expired work");},()=>at+WINDOW+10);
      assert.equal((await never.recover(a.id,at+WINDOW+10)).disposition,"expired");
      assert.equal(starts,0);
    } finally {later.close();}
  } finally {s.close();c.close();dir.remove();}
});
test("late terminal results retain closure-age window and never prune before coordinator custody receipt",()=>{
  const dir=scratchDir("davinci-terminal-custody"),d=def(),c=new Coordinator(join(dir.path,"c.sqlite"),d),
    s=new WorkerJournal(join(dir.path,"w.sqlite"),d);
  try {
    const a=c.tick(at)!;s.accept(JSON.stringify(a),at);
    const closedAt=at+RETENTION+1000;
    const result=s.observe(a.id,status(a.requestId,true),"session",closedAt);
    s.maintain(closedAt+1);assert.ok(s.get(a.id),"old occurrence does not delete newly obtained result");
    s.maintain(closedAt+RETENTION+1);assert.ok(s.get(a.id),"unconfirmed terminal custody is protected even when old");
    c.result(JSON.stringify(result),closedAt); // lose the coordinator receipt while the worker is offline
    c.maintain(closedAt+RETENTION+1);
    assert.ok(c.get(a.id),"coordinator retains receipt evidence until worker confirms it");
    const receipt=c.result(JSON.stringify(result),closedAt+RETENTION+1);
    assert.throws(()=>s.confirm(JSON.stringify({...receipt,hash:"0".repeat(64)})),/receipt_binding/);
    s.confirm(JSON.stringify(receipt));s.confirm(JSON.stringify(receipt));
    s.maintain(closedAt+RETENTION+2);assert.ok(s.get(a.id),"worker retains the receipt confirmation until broker custody");
    s.published(a.id,receipt.seq,true,closedAt+RETENTION+2);
    const confirmation=JSON.stringify({...receipt,kind:"receipt-confirmed"});
    c.confirm(confirmation);
    c.maintain(closedAt+RETENTION+2);assert.equal(c.get(a.id),undefined);
    c.confirm(confirmation); // duplicate after pruning is harmless and transport-ackable
    s.maintain(closedAt+RETENTION+3);assert.equal(s.get(a.id),undefined);
  } finally {s.close();c.close();dir.remove();}
});

test("signed ingress supports rotation, read-only status and disabled intake; route is authenticated",async()=>{
  const dir=scratchDir("davinci-http"),d=def(),c=new Coordinator(join(dir.path,"c.sqlite"),{...d,notBefore:at-86400000});
  const old=randomBytes(32),current=randomBytes(32);
  const oldFile=join(dir.path,"old.key"),newFile=join(dir.path,"new.key");
  writeFileSync(oldFile,old.toString("hex"),{mode:0o600});writeFileSync(newFile,current.toString("hex"),{mode:0o600});
  let config={role:"coordinator",definition:c.definition,port:0,keys:{old:oldFile,next:newFile}} as unknown as Config;
  const server=await ingress(config,c,()=>config);
  const send=async(method:string,path:string,key="old",secret=old,bytes="",stamp=String(Date.now()))=>{
    const delivery=stamp+":fixture";
    return fetch("http://127.0.0.1:"+server.port+path,{method,headers:{"davinci-key":key,"davinci-delivery":delivery,
      "davinci-time":stamp,"davinci-signature":signature(secret,key,delivery,stamp,method+" "+path+"\n"+bytes)},
      ...(method==="POST"?{body:bytes}:{})});
  };
  try {
    const originalTime=String(Date.now());
    const reply=await send("POST","/webhook","old",old,BODY,originalTime);assert.equal(reply.status,202);
    assert.equal((await send("POST","/webhook","old",old,BODY+" ",originalTime)).status,409);
    const id=(await reply.json() as {id:string}).id;
    const count=c.rows().length;
    assert.equal((await send("GET","/jobs/"+id,"next",current)).status,200);
    assert.equal(c.rows().length,count);
    config={...config,keys:{next:newFile},definition:{...config.definition,enabled:false}};
    assert.equal((await send("GET","/jobs/"+id)).status,403);
    assert.equal((await send("GET","/jobs/"+id,"next",current)).status,200);
    assert.equal((await send("POST","/webhook","next",current,BODY,String(Number(originalTime)+1))).status,403);
    const stamp=String(Date.now()),delivery=stamp+":replay";
    const signed=signature(current,"next",delivery,stamp,"POST /webhook\n"+BODY);
    assert.throws(()=>authenticate(current,"next",delivery,stamp,"GET /schedule\n",signed,Date.now()),/refused/);
    assert.throws(()=>authenticate(current,"next",at+":old",String(at),BODY,signed,at+WINDOW+1),/refused/);
  } finally {await server.stop();c.close();dir.remove();}
});
