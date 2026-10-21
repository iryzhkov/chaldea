import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createServer as reserve } from "node:net";
import { once } from "node:events";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { broker } from "./broker.ts";
import { run } from "../../src/davinci/service.ts";
import { signature, BODY } from "../../src/davinci/protocol.ts";
import { presetHash, loadSessionPolicy } from "../../src/session/policy.ts";
import { scratchDir } from "../helpers/scratch.ts";
import type { SessionStatus } from "../../src/session/lifecycle.ts";
async function until<T>(label:string,read:()=>Promise<T | null>,ms=45000):Promise<T> {
  const end=Date.now()+ms;
  while(Date.now()<end) {try {const r=await read();if(r!==null)return r;} catch {} await new Promise(r=>setTimeout(r,100));}
  throw Error("fixture timeout: "+label);
}
test("production loops survive broker outage and worker/coordinator reopen; one fixed admission and result", {timeout:150000},async()=>{
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
    notBefore:Date.now()-1000,utc:"00:00",enabled:true};
  let session:SessionStatus|null=null,starts=0,lookups=0;
  const ipc=createServer(async(req,res)=>{
    let bytes="";for await(const p of req)bytes+=p.toString();
    const {method,input}=JSON.parse(bytes);
    let value:SessionStatus|null;
    if(method==="chaldea_session_lookup") {lookups++;value=session;}
    else if(method==="chaldea_session_start") {
      starts++;assert.deepEqual(Object.keys(input).sort(),["preset","requestId","threadId"]);
      assert.equal(input.threadId,caller);assert.equal(input.preset,"reporter");
      session={sessionId:"fixed-session",requestId:input.requestId,preset:"reporter",threadId:"fixed-thread",runId:"fixed-run",
        state:"parked",disposition:null,launch:"accepted",deadline:new Date(Date.now()+600000).toISOString(),
        outcome:null,result:null,resultState:null,resultBytes:null,occupancy:"held",released:null,delivery:[]};
      // Admission committed, worker never gets the handle in this answer.
      req.socket.destroy();return;
    } else {assert.equal(method,"chaldea_session_status");value=session;}
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
  const call=async(method:string,path:string,body="")=>{
    // Repeated webhook retries keep exactly the original delivery and timestamp.
    const time=method==="POST"?stamp:String(Date.now()),id=method==="POST"?delivery:time+":status";
    return fetch("http://127.0.0.1:"+port+path,{method,headers:{"davinci-key":"current","davinci-delivery":id,
      "davinci-time":time,"davinci-signature":signature(key,"current",id,time,method+" "+path+"\n"+body)},
      ...(method==="POST"?{body}:{})});
  };
  try {
    const id=await until("HTTP commit",async()=>{
      const r=await call("POST","/webhook",BODY);if(r.status!==202)return null;return (await r.json() as {id:string}).id;
    });
    await until("one uncertain native start",async()=>starts===1?true:null);
    ws.abort();await wr; // worker journal survives, native session still parked
    await bus.restart();
    ws=new AbortController();wr=run(wp,ws.signal);wr.catch(e=>errors.push(e));
    cs.abort();await cr;cs=new AbortController();cr=run(cp,cs.signal);cr.catch(e=>errors.push(e));
    await until("recovered parked observation",async()=>{
      const r=await call("GET","/jobs/"+id);if(r.status!==200)return null;
      const x=await r.json() as {result:{status:SessionStatus|null}|null};
      return x.result?.status?.sessionId==="fixed-session"?x:null;
    });
    assert.equal(starts,1);
    session={...session!,state:"resolved",occupancy:"released",released:"observed",result:"Done.",resultBytes:5,
      resultState:"stored",outcome:{reason:"succeeded"}};
    const final=await until("terminal result commit",async()=>{
      const r=await call("GET","/jobs/"+id);if(r.status!==200)return null;
      const x=await r.json() as {result:{closed:boolean;status:SessionStatus}|null};
      return x.result?.closed?x:null;
    });
    assert.equal(final.result!.status.result,"Done.");assert.equal(starts,1);assert.ok(lookups>=2);
    assert.deepEqual(errors,[]);
    writeFileSync("davinci-runtime.json",JSON.stringify({passed:true,proof:"production-loops-with-admission-fixture",
      id,starts,lookups,brokerRestart:true,workerRestart:true,coordinatorRestart:true,result:final.result})+"\n");
  } catch(error) {
    assert.deepEqual(errors,[],"service startup/cycle failure");throw error;
  } finally {
    cs.abort();ws.abort();await Promise.allSettled([cr,wr]);
    ipc.closeAllConnections();await new Promise<void>(r=>ipc.close(()=>r()));
    await bus.close();dir.remove();
  }
});
