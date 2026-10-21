import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as reserve } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { broker } from "./broker.ts";
import { run } from "../../src/davinci/service.ts";
import { WorkerJournal } from "../../src/davinci/store.ts";
import { signature, BODY, definition } from "../../src/davinci/protocol.ts";
import { presetHash, loadSessionPolicy } from "../../src/session/policy.ts";
import { scratchDir } from "../helpers/scratch.ts";
import type { SessionStatus } from "../../src/session/lifecycle.ts";
async function until<T>(label:string,read:()=>Promise<T | null>,ms=45000):Promise<T> {
  const end=Date.now()+ms;
  while(Date.now()<end) {try {const r=await read();if(r!==null)return r;} catch {} await new Promise(r=>setTimeout(r,100));}
  throw Error("fixture timeout: "+label);
}
test("production loops survive broker outage and worker/coordinator reopen; three occurrences recover full streams and expired confirmation", {timeout:150000},async()=>{
  writeFileSync("davinci-runtime.json",JSON.stringify({passed:false})+"\n");
  const dir=scratchDir("davinci-service"),bus=await broker(dir.path,true);
  const key=randomBytes(32),keyFile=join(dir.path,"webhook.key"),policyFile=join(dir.path,"policy.json"),
    socket=join(dir.path,"admission.sock"),caller="mcp:00000000-0000-4000-8000-000000000001";
  writeFileSync(keyFile,key.toString("hex"),{mode:0o600});
  const services=[{audience:"jocasta",grants:[{resource:"project:source-report",actions:["get"]}]}];
  writeFileSync(policyFile,JSON.stringify({version:1,environment:"fixture",presets:{reporter:{
    instanceId:"codex",model:"gpt-6.1-sol",options:[{id:"reasoningEffort",value:"high"}],
    runtimeMode:"approval-required",interactionMode:"default",projectId:"fixed-project",title:"source report",
    prompt:"Read the fixed published source only.",inputs:{ref:"b".repeat(40)},project:"source-report",
    services,maxSeconds:600,delegate:false,destinations:["fixed-project"]}},
    ceilings:[{project:"source-report",services,maxSeconds:600,destinations:["fixed-project"]}]}),{mode:0o644});
  const d={id:"source-status",worker:"agent-a",environment:"fixture",epoch:"generation-1",preset:"reporter",
    presetHash:presetHash(loadSessionPolicy(policyFile,"fixture").presets.reporter!),source:"b".repeat(40),
    notBefore:Date.now()-1000,utc:new Date(Date.now()+3600000).toISOString().slice(11,16),enabled:true};
  let session:SessionStatus|null=null,starts=0,lookups=0;
  const sessions=new Map<string,SessionStatus>();
  const ipc=createServer(async(req,res)=>{
    let bytes="";for await(const p of req)bytes+=p.toString();
    const {method,input}=JSON.parse(bytes);
    let value:SessionStatus|null;
    if(method==="chaldea_session_lookup") {lookups++;value=session?.requestId===input.requestId?session:sessions.get(input.requestId)??null;}
    else if(method==="chaldea_session_start") {
      starts++;assert.deepEqual(Object.keys(input).sort(),["preset","requestId","threadId"]);
      assert.equal(input.threadId,caller);assert.equal(input.preset,"reporter");
      if(session)sessions.set(session.requestId,session);
      session={sessionId:"fixed-session-"+starts,requestId:input.requestId,preset:"reporter",threadId:"fixed-thread-"+starts,runId:"fixed-run-"+starts,
        state:"parked",disposition:null,launch:"accepted",deadline:new Date(Date.now()+600000).toISOString(),
        outcome:null,result:null,resultState:null,resultBytes:null,occupancy:"held",released:null,delivery:[]};
      // Admission committed, worker never gets the handle in this answer.
      req.socket.destroy();return;
    } else {assert.equal(method,"chaldea_session_status");value=session?.sessionId===input.id?session:[...sessions.values()].find(s=>s.sessionId===input.id)??null;}
    res.writeHead(200,{"Content-Type":"application/json"});res.end(JSON.stringify(value));
  });
  ipc.listen(socket);await once(ipc,"listening");
  const listener=reserve();listener.listen(0,"127.0.0.1");await once(listener,"listening");
  const port=(listener.address() as {port:number}).port;
  await new Promise<void>(r=>listener.close(()=>r()));
  const cp=join(dir.path,"coordinator.json"),wp=join(dir.path,"worker.json");
  const coordinator={role:"coordinator",definition:d,database:join(dir.path,"c.sqlite"),logFile:join(dir.path,"c.log"),
    ...bus.runtimeConfig("coordinator"),port,keys:{current:keyFile}};
  const worker={role:"worker",definition:d,database:join(dir.path,"w.sqlite"),logFile:join(dir.path,"w.log"),
    ...bus.runtimeConfig("worker"),socket,caller,policy:policyFile};
  writeFileSync(cp,JSON.stringify(coordinator),{mode:0o600});writeFileSync(wp,JSON.stringify(worker),{mode:0o600});
  let cs=new AbortController(),ws=new AbortController(),cr=run(cp,cs.signal),wr=run(wp,ws.signal);
  const errors:unknown[]=[];cr.catch(e=>errors.push(e));wr.catch(e=>errors.push(e));
  const stamp=String(Date.now()),delivery=stamp+":runtime";
  const call=async(method:string,path:string,body="",postTime=stamp,postDelivery=delivery)=>{
    // Repeated webhook retries keep exactly the original delivery and timestamp.
    const time=method==="POST"?postTime:String(Date.now()),id=method==="POST"?postDelivery:time+":status";
    return fetch("http://127.0.0.1:"+port+path,{method,headers:{"davinci-key":"current","davinci-delivery":id,
      "davinci-time":time,"davinci-signature":signature(key,"current",id,time,method+" "+path+"\n"+body)},
      ...(method==="POST"?{body}:{})});
  };
  try {
    const id=await until("HTTP commit",async()=>{
      const r=await call("POST","/webhook",BODY);if(r.status!==202)return null;return (await r.json() as {id:string}).id;
    });
    await until("one uncertain native start",async()=>starts===1?true:null);
    cs.abort();await cr;ws.abort();await wr; // native session still parked
    const journal=new WorkerJournal(worker.database,definition(d));
    const saved=journal.status(id);journal.close();
    assert.ok(saved.result);
    await bus.restart();
    // Both discard-new streams have capacity one and are full. Neither side may
    // let its rejected output publish prevent consuming the input that drains it.
    assert.equal(await bus.inspect("command",JSON.stringify(saved.assignment)),1);
    assert.equal(await bus.inspect("result",JSON.stringify(saved.result)),1);
    cs=new AbortController();cr=run(cp,cs.signal);cr.catch(e=>errors.push(e));
    await until("coordinator reads while assignment stream full",async()=>{
      const r=await call("GET","/jobs/"+id);if(r.status!==200)return null;
      const x=await r.json() as {result:unknown};return x.result?true:null;
    });
    assert.equal(await bus.inspect("command"),1);
    ws=new AbortController();wr=run(wp,ws.signal);wr.catch(e=>errors.push(e));
    await until("recovered parked observation",async()=>{
      const r=await call("GET","/jobs/"+id);if(r.status!==200)return null;
      const x=await r.json() as {result:{status:SessionStatus|null}|null};
      return x.result?.status?.sessionId==="fixed-session-1"?x:null;
    });
    assert.equal(starts,1);
    ws.abort();await wr;
    session={...session!,state:"resolved",occupancy:"released",released:"observed",result:"Done.",resultBytes:5,
      resultState:"stored",outcome:{reason:"succeeded"}};
    // Controlled crash boundary: A's terminal local commit precedes publication,
    // and its coordinator receipt cannot publish into the full command stream.
    const endingJournal=new WorkerJournal(worker.database,definition(d));
    const ending=endingJournal.observe(id,session,"session",Date.now());endingJournal.close();
    await until("first terminal publication slot",async()=>(await bus.inspect("result"))===0?true:null);
    if((await bus.inspect("command"))===0)await bus.inspect("command",JSON.stringify(saved.assignment));
    await bus.inspect("result",JSON.stringify(ending));
    await until("first terminal result durable before receipt",async()=>{
      const r=await call("GET","/jobs/"+id);if(r.status!==200)return null;
      const x=await r.json() as {result:{closed:boolean}|null};return x.result?.closed?true:null;
    });
    const secondTime=String(Date.now()),secondDelivery=secondTime+":runtime-two";
    const secondReply=await call("POST","/webhook",BODY,secondTime,secondDelivery);
    assert.equal(secondReply.status,202);
    const secondId=(await secondReply.json() as {id:string}).id;
    assert.notEqual(secondId,id);assert.equal(await bus.inspect("command"),1);
    ws=new AbortController();wr=run(wp,ws.signal);wr.catch(e=>errors.push(e));
    await until("second original admission after receipt drainage",async()=>starts===2?true:null);
    session={...session!,state:"resolved",occupancy:"released",released:"observed",result:"Second.",resultBytes:7,
      resultState:"stored",outcome:{reason:"succeeded"}};
    const final=await until("second terminal result commit",async()=>{
      const r=await call("GET","/jobs/"+secondId);if(r.status!==200)return null;
      const x=await r.json() as {result:{closed:boolean;status:SessionStatus;hash:string;seq:number}|null};
      return x.result?.closed?x:null;
    });
    assert.equal(final.result!.status.result,"Second.");assert.equal(starts,2);assert.ok(lookups>=3);
    // Coordinator is offline after committing B, before sending its custody
    // receipt. Publish that exact durable receipt as a controlled crash boundary.
    cs.abort();await cr;
    await until("command slot before controlled receipt",async()=>(await bus.inspect("command"))===0?true:null);
    if((await bus.inspect("result"))!==0) {
      const drain=await bus.client("coordinator");
      try {await bus.ack(drain,"result",await bus.take(drain,"result"));} finally {await drain.close();}
    }
    await bus.inspect("command",JSON.stringify({version:1,kind:"result-receipt",id:secondId,
      hash:final.result!.hash,seq:final.result!.seq}));
    await until("confirmation PubAck while coordinator offline",async()=>{
      const db=new DatabaseSync(worker.database,{readOnly:true});
      try {
        const row=db.prepare("SELECT seq,confirmed_seq,notified_seq FROM work WHERE id=?").get(secondId)!;
        return row.seq===row.confirmed_seq && row.seq===row.notified_seq?true:null;
      } finally {db.close();}
    });
    ws.abort();await wr;
    assert.equal(await bus.inspect("result"),1);
    await bus.expiry("result",true);
    await until("PubAcked confirmation expires from broker",async()=>(await bus.inspect("result"))===0?true:null);
    await bus.expiry("result",false);
    const retained=new DatabaseSync(coordinator.database,{readOnly:true});
    try {
      const row=retained.prepare("SELECT seq,confirmed_seq FROM work WHERE id=?").get(secondId)!;
      assert.ok(Number(row.confirmed_seq)<Number(row.seq));
    } finally {retained.close();}
    cs=new AbortController();cr=run(cp,cs.signal);cr.catch(e=>errors.push(e));
    const thirdTime=String(Date.now()),thirdDelivery=thirdTime+":runtime-three";
    const thirdId=await until("third HTTP commit",async()=>{
      const r=await call("POST","/webhook",BODY,thirdTime,thirdDelivery);
      return r.status===202?(await r.json() as {id:string}).id:null;
    });
    assert.notEqual(thirdId,secondId);
    ws=new AbortController();wr=run(wp,ws.signal);wr.catch(e=>errors.push(e));
    await until("third admission after retained receipt rearms confirmation",async()=>starts===3?true:null);
    session={...session!,state:"resolved",occupancy:"released",released:"observed",result:"Third.",resultBytes:6,
      resultState:"stored",outcome:{reason:"succeeded"}};
    const third=await until("third terminal result commit",async()=>{
      const r=await call("GET","/jobs/"+thirdId);if(r.status!==200)return null;
      const x=await r.json() as {result:{closed:boolean;status:SessionStatus}|null};
      return x.result?.closed?x:null;
    });
    assert.equal(third.result!.status.result,"Third.");
    await until("application custody receipt committed at worker",async()=>{
      const db=new DatabaseSync(worker.database,{readOnly:true});
      try {
        const rows=[id,secondId,thirdId].map(key=>db.prepare("SELECT seq,confirmed_seq,notified_seq FROM work WHERE id=?").get(key)!);
        return rows.every(row=>row.seq===row.confirmed_seq && row.seq===row.notified_seq)?true:null;
      } finally {db.close();}
    });
    await until("worker receipt confirmation committed at coordinator",async()=>{
      const db=new DatabaseSync(coordinator.database,{readOnly:true});
      try {
        const rows=[id,secondId,thirdId].map(key=>db.prepare("SELECT seq,confirmed_seq FROM work WHERE id=?").get(key)!);
        return rows.every(row=>row.seq===row.confirmed_seq)?true:null;
      } finally {db.close();}
    });
    await until("result stream drained",async()=>(await bus.inspect("result"))===0?true:null);
    await bus.inspect("result",JSON.stringify({...final.result,id:"0".repeat(64)}));
    await until("stale unknown result terminated without blocking intake",async()=>(await bus.inspect("result"))===0?true:null);
    await bus.inspect("command",JSON.stringify({version:1,kind:"result-receipt",id:"f".repeat(64),hash:"e".repeat(64),seq:1}));
    await until("retired worker receipt reconfirmed without new work",async()=>
      (await bus.inspect("command"))===0 && (await bus.inspect("result"))===0?true:null);
    assert.equal(starts,3);
    assert.deepEqual(errors,[]);
    writeFileSync("davinci-runtime.json",JSON.stringify({passed:true,proof:"production-loops-with-admission-fixture",
      id,secondId,thirdId,occurrences:3,starts,lookups,confirmationExpiredAfterPubAck:true,retainedReceiptRearmed:true,receiptPriority:true,lateTerminalPublication:true,brokerRestart:true,workerRestart:true,coordinatorRestart:true,bothStreamsFull:true,applicationReceipt:true,receiptConfirmation:true,staleResultDrained:true,retiredReceiptConfirmed:true,result:third.result})+"\n");
  } catch(error) {
    assert.deepEqual(errors,[],"service startup/cycle failure");throw error;
  } finally {
    cs.abort();ws.abort();await Promise.allSettled([cr,wr]);
    ipc.closeAllConnections();await new Promise<void>(r=>ipc.close(()=>r()));
    await bus.close();dir.remove();
  }
});
