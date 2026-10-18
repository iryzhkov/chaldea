import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { MissionModel, safeLabel, MAX_AGENTS } from "../../src/mission-control/model.ts";
import { fixtureModel } from "../../src/mission-control/fixture.ts";
import { missionServer } from "../../src/mission-control/server.ts";
import { runSource, type ReadSource } from "../../src/mission-control/source.ts";
import type { ShellThread } from "../../src/t3/adapter.ts";
import { emptyHeadroom, newProvider } from "../../src/quota/headroom.ts";
const row=(id="private-thread-id"):ShellThread=>({id,title:"Implement canary",status:"running",providerInstanceId:"private-account",modelSelection:{instanceId:"private-account",model:"gpt-6.1-sol"},latestRunId:"private-run",activeRunId:"private-run",latestRunStartedAt:"2026-10-18T00:00:00Z",latestRunCompletedAt:null,lastErrorClass:null,usageLimitResetAt:null,limitRecovery:null,relationshipToParent:null,archived:false,deleted:false});
const initialized=(now:()=>number=Date.now)=>{const m=new MissionModel(false,now);m.shell({kind:"snapshot",sequence:1,threads:[row()]});m.shell({kind:"synchronized"});m.detail("private-thread-id",{kind:"synchronized"});return m;};
test("allowlisted DTOs redact titles and ignore raw payloads; legitimate zero survives",()=>{
  const m=initialized(); const dirty={...row(),title:"bearer SECRET /home/igor/private",input:"RAW_INPUT_SECRET",output:"RAW_OUTPUT_SECRET",arguments:"RAW_ARGUMENT_SECRET"};
  m.shell({kind:"thread",sequence:2,thread:dirty});m.detail(dirty.id,{kind:"activity",tool:"UNKNOWN_SECRET"});
  const p=newProvider("private-account-alias","codex");p.accountKey="SECRET_ACCOUNT";
  p.included={value:[{id:"secret-window",kind:"session",usedPercent:0,remainingPercent:100,windowDurationMins:300,resetsAt:null}],state:"fresh",source:"secret source",observedAt:new Date().toISOString(),error:null};
  p.credits={value:{balance:"0",unlimited:false,hasCredits:false},state:"fresh",source:"fixture",observedAt:new Date().toISOString(),error:null};
  const h=emptyHeadroom();h.providers=[p,{...p,alias:"duplicate"}];m.setQuota(h);
  const s=m.snapshot(), serialized=JSON.stringify(s);
  for(const secret of ["SECRET","private-thread-id","private-account","private-run","secret source","secret-window","RAW_","/home/igor"]) assert.equal(serialized.includes(secret),false,secret);
  assert.equal(s.agents[0]!.title,"Task");assert.equal(s.agents[0]!.steps[0],"Activity unavailable");
  assert.equal(s.quota.accounts.length,1);assert.equal(s.quota.accounts[0]!.used,0);assert.equal(s.quota.accounts[0]!.credits,"0");
  assert.equal(safeLabel("Normal bounded task"),"Normal bounded task");
});
test("quiet synchronized streams stay live; disconnect keeps readable last known values",()=>{
  let now=Date.parse("2026-10-18T00:00:00Z");const m=initialized(()=>now);
  now+=3600000;assert.equal(m.snapshot().source.state,"live");assert.equal(m.snapshot().agents[0]!.activityFreshness,"live");
  m.disconnected();now+=31000;assert.equal(m.snapshot().source.state,"stale");
  assert.equal(m.snapshot().agents[0]!.title,"Implement canary");
  now+=300000;assert.equal(m.snapshot().source.state,"lost");
  m.shell({kind:"synchronized"});assert.equal(m.snapshot().source.state,"live");
});
test("usage baseline, duplicates, zero, reset and missing counters remain distinct",()=>{
  let now=1000000;const m=initialized(()=>now),id="private-thread-id";
  const usage=(output:number|null,stamp:number,baseline=false)=>m.detail(id,{kind:"usage",turnId:"turn",output,at:stamp,baseline});
  assert.equal(m.snapshot().tokens.rate,null);
  usage(100,1,true);assert.equal(m.snapshot().tokens.output,null);
  usage(160,2);assert.equal(m.snapshot().tokens.rate,1);assert.equal(m.snapshot().tokens.output,60);
  usage(160,2);usage(null,3);assert.equal(m.snapshot().tokens.output,60);
  usage(5,4);assert.equal(m.snapshot().tokens.output,65);
  usage(5,5);assert.equal(m.snapshot().tokens.output,65);
  now+=61000;assert.equal(m.snapshot().tokens.rate,0);
  m.detailDisconnected(id);assert.equal(m.snapshot().tokens.rate,null);assert.equal(m.snapshot().tokens.output,65);
});
test("snapshot and removals bound thread retention and reject replayed shell events",()=>{
  const m=new MissionModel();m.shell({kind:"snapshot",sequence:4,threads:Array.from({length:100},(_,i)=>row("t"+i))});
  assert.equal(m.ids().length,MAX_AGENTS);assert.equal(m.snapshot().total,100);assert.equal(m.snapshot().truncated,true);
  m.shell({kind:"thread",sequence:3,thread:row("replay")});assert.equal(m.ids().includes("replay"),false);
  const id=m.ids()[0]!;m.shell({kind:"removed",sequence:5,threadId:id});assert.equal(m.ids().includes(id),false);
  m.shell({kind:"snapshot",sequence:6,threads:[]});assert.equal(m.ids().length,0);
});
test("cached quota unknown, unsupported and error are distinct from zero",()=>{
  const m=new MissionModel(),h=emptyHeadroom(),p=newProvider("x","codex");h.providers=[p];m.setQuota(h);
  assert.equal(m.snapshot().quota.accounts[0]!.state,"unknown");assert.equal(m.snapshot().quota.accounts[0]!.used,null);
  p.included={...p.included,state:"unsupported"};assert.equal(m.snapshot().quota.accounts[0]!.state,"unsupported");
  m.setQuota(h,true);assert.equal(m.snapshot().quota.accounts[0]!.state,"error");
});
test("source reconnect resumes cursors, rediscovers origin and aborts removed detail subscriptions",async()=>{
  const model=new MissionModel(),controller=new AbortController();
  let shells=0,details=0,stopped=0,discovered=0;const cursors:(number|undefined)[]=[];
  const source:ReadSource={
    async shell(options,sub){
      shells++;cursors.push(sub.afterSequence);
      if(shells===1){await sub.onEvent({kind:"snapshot",sequence:10,threads:[row()]});await sub.onEvent({kind:"synchronized"});await delay(10);throw Error("fixture_disconnect");}
      if(shells===2){await sub.onEvent({kind:"cursor",sequence:11});await sub.onEvent({kind:"synchronized"});await delay(10);throw Error("fixture_disconnect");}
      assert.equal(options.serverUrl,"http://127.0.0.1:2222");await sub.onEvent({kind:"snapshot",sequence:0,threads:[]});controller.abort();
    },
    async detail(options,_id,cursor,emit){details++;if(details===2)assert.equal(cursor,8);emit({kind:"cursor",sequence:8});emit({kind:"synchronized"});
      await new Promise<void>(resolve=>options.signal!.addEventListener("abort",()=>{stopped++;resolve();},{once:true}));},
  };
  await runSource(model,()=>({serverUrl:++discovered<3?"http://127.0.0.1:1111":"http://127.0.0.1:2222",token:"fixture"}),controller.signal,source,1);
  assert.deepEqual(cursors,[undefined,10,undefined]);assert.equal(stopped,details);assert.equal(model.ids().length,0);assert.equal(model.snapshot().source.state,"disconnected");
});
async function get(port:number,path:string,headers:Record<string,string>={},method="GET") {
  return new Promise<{status:number;headers:Record<string,unknown>;body:string}>((resolve,reject)=>{
    const req=request({host:"127.0.0.1",port,path,method,headers},res=>{let body="";res.on("data",chunk=>body+=chunk);res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.on("error",reject);req.end();
  });
}
test("HTTP exposes only fixed read paths with security headers and same-origin checks",async()=>{
  const m=new MissionModel(true);fixtureModel(m);const app=missionServer(m);await app.listen(0);
  const port=(app.server.address() as {port:number}).port;
  try{
    assert.equal((app.server.address() as {address:string}).address,"127.0.0.1");
    const s=await get(port,"/api/snapshot");assert.equal(s.status,200);assert.ok(s.body.length<128*1024);assert.ok(String(s.headers["content-security-policy"]).includes("default-src 'none'"));
    assert.equal(s.headers["access-control-allow-origin"],undefined);
    for(const path of ["/../../etc/passwd","/data.js","/api/rpc","/api/snapshot?file=secret"])assert.equal((await get(port,path)).status,404);
    assert.equal((await get(port,"/api/snapshot",{},"POST")).status,405);
    assert.equal((await get(port,"/api/snapshot",{Origin:"https://evil.example"})).status,403);
    assert.equal((await get(port,"/api/snapshot",{Host:"evil.example"})).status,403);
    assert.equal((await get(port,"/core.css")).status,200);
  }finally{await app.close();}
});
test("SSE client cap releases on disconnect and transports normalized snapshots only",async()=>{
  const m=initialized(),app=missionServer(m,1);await app.listen(0);const port=(app.server.address() as {port:number}).port;
  const opened=()=>new Promise<{req:ReturnType<typeof request>;body:string}>(resolve=>{
    const req=request({host:"127.0.0.1",port,path:"/api/events"},res=>res.once("data",chunk=>resolve({req,body:String(chunk)})));req.end();
  });
  const first=await opened();
  try{
    assert.equal(app.clientCount(),1);assert.equal((await get(port,"/api/events")).status,503);
    first.req.destroy();await delay(10);assert.equal(app.clientCount(),0);
    const second=await opened();assert.equal(app.clientCount(),1);second.req.destroy();
  }finally{await app.close();}
});
