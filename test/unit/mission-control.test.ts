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

test("new post-start single-report turns count output; old/unknown starts baseline and reconnect does not recount",()=>{
  let now=1_000_000;const m=initialized(()=>now),id="private-thread-id";
  const usage=(turnId:string,output:number,stamp:number,startedAt?:number|null,baseline=false)=>{
    const event={kind:"usage" as const,turnId,output,at:stamp,...(startedAt === undefined ? {} : {startedAt}),baseline};m.detail(id,event);
  };
  const preexisting=initialized(()=>now);
  preexisting.detail(id,{kind:"usage",turnId:"unknown-first",output:500,at:now,baseline:false});
  assert.equal(preexisting.snapshot().tokens.output,null);assert.equal(preexisting.snapshot().tokens.rate,null);
  now+=1000;usage("new",500,now,now-500);
  assert.equal(m.snapshot().tokens.output,500);assert.equal(m.snapshot().tokens.rate,500/60);
  usage("new",500,now,now-500);usage("new",800,now-1,now-500);assert.equal(m.snapshot().tokens.output,500);
  usage("old",1000,now,0);usage("unknown",1000,now);usage("unknown-null",1000,now,null);
  assert.equal(m.snapshot().tokens.output,500);
  m.detailDisconnected(id);m.detail(id,{kind:"synchronized"});
  usage("new",500,now+1,now-500,true);usage("new",550,now+2,now-500);
  assert.equal(m.snapshot().tokens.output,550);
  usage("new",5,now+3,now-500);assert.equal(m.snapshot().tokens.output,555);
  usage("snapshot-only",5000,now+4,now-500,true);assert.equal(m.snapshot().tokens.output,555);
  assert.equal(JSON.stringify(m.snapshot()).includes("snapshot-only"),false);
});
test("historical baseline floods cannot evict a live turn baseline",()=>{
  let now=1_000_000;const m=initialized(()=>now),id="private-thread-id";
  m.detail(id,{kind:"usage",turnId:"live",output:100,at:1,baseline:true});
  m.detail(id,{kind:"usage",turnId:"live",output:150,at:2,baseline:false});
  for(let i=0;i<600;i++)m.detail(id,{kind:"usage",turnId:"history"+i,output:500,at:3+i,baseline:true});
  m.detail(id,{kind:"usage",turnId:"live",output:200,at:1000,baseline:false});
  assert.equal(m.snapshot().tokens.output,100);
});

test("live counter eviction never reports Sol's 762 as complete output when full truth is 662",()=>{
  let now=1_000_000;const m=new MissionModel(false,()=>now);
  m.shell({kind:"snapshot",sequence:1,threads:[row("long-thread"),row("short-thread")]});m.shell({kind:"synchronized"});
  m.detail("long-thread",{kind:"synchronized"});m.detail("short-thread",{kind:"synchronized"});
  const start=++now;
  m.detail("long-thread",{kind:"usage",turnId:"long",output:100,at:now,startedAt:start,baseline:false});
  for(let i=0;i<512;i++){now++;m.detail("short-thread",{kind:"usage",turnId:"short-"+i,output:1,at:now,startedAt:now,baseline:false});}
  now++;m.detail("long-thread",{kind:"usage",turnId:"long",output:150,at:now,startedAt:start,baseline:false});
  const tokens=m.snapshot().tokens;
  assert.ok(tokens.output! <= 662,"full truth662, duplicate100 produced "+tokens.output);
  assert.equal(tokens.output,612);assert.equal(Reflect.get(tokens,"coverage"),"partial");
  assert.equal(tokens.rate,612/60);assert.match(tokens.scope,/lower bound/i);
  assert.equal(Reflect.get(m,"turns").size,512); // Explicit retained-state bound, no diagnostic payload added.
  m.detailDisconnected("long-thread");m.detail("long-thread",{kind:"synchronized"});
  now++;m.detail("long-thread",{kind:"usage",turnId:"long",output:155,at:now,startedAt:start,baseline:false});
  assert.equal(m.snapshot().tokens.output,617);
  m.detail("long-thread",{kind:"usage",turnId:"long",output:999,at:now-1,startedAt:start,baseline:false});
  assert.equal(m.snapshot().tokens.output,617);
  now++;m.detail("long-thread",{kind:"usage",turnId:"long",output:5,at:now,startedAt:start,baseline:false});
  assert.equal(m.snapshot().tokens.output,622);
  now++;m.detail("long-thread",{kind:"usage",turnId:"demonstrably-new",output:40,at:now,startedAt:now,baseline:false});
  assert.equal(m.snapshot().tokens.output,662);
  m.shell({kind:"snapshot",sequence:2,threads:[row("long-thread"),row("short-thread")]});m.shell({kind:"synchronized"});
  assert.equal(Reflect.get(m.snapshot().tokens,"coverage"),"partial");
});

test("a snapshot baseline dropped at the cap cannot later masquerade as a new first report",()=>{
  let now=1_000_000;const m=initialized(()=>now),id="private-thread-id";
  for(let i=0;i<512;i++){now++;m.detail(id,{kind:"usage",turnId:"live-"+i,output:1,at:now,startedAt:now,baseline:false});}
  now++;const start=now;
  m.detail(id,{kind:"usage",turnId:"unretained-snapshot",output:100,at:now,startedAt:start,baseline:true});
  now++;m.detail(id,{kind:"usage",turnId:"unretained-snapshot",output:120,at:now,startedAt:start,baseline:false});
  assert.equal(m.snapshot().tokens.output,512);
  assert.equal(Reflect.get(m.snapshot().tokens,"coverage"),"partial");
  assert.equal(Reflect.get(m,"turns").size,512);
});

test("eviction fence rebaselines late old or uncertain starts without manufacturing a first zero",()=>{
  let now=1_000_000;const m=initialized(()=>now),id="private-thread-id";
  // Snapshot-only history exhausts bounded knowledge without measuring any live output.
  for(let i=0;i<513;i++){now++;m.detail(id,{kind:"usage",turnId:"baseline-"+i,output:100,at:now+100,startedAt:now,baseline:true});}
  now++;m.detail(id,{kind:"usage",turnId:"baseline-0",output:200,at:now+1000,startedAt:1_000_001,baseline:false});
  assert.equal(m.snapshot().tokens.output,null);assert.equal(m.snapshot().tokens.rate,null);
  m.detailDisconnected(id);m.detail(id,{kind:"synchronized"});
  now++;m.detail(id,{kind:"usage",turnId:"unknown-late",output:500,at:now+1000,baseline:false});
  assert.equal(m.snapshot().tokens.output,null);
  now++;m.detail(id,{kind:"usage",turnId:"old-late",output:500,at:now+1000,startedAt:0,baseline:false});
  assert.equal(m.snapshot().tokens.output,null);
  // A future official start is not evidence of a new turn.
  now++;const future=now+500;
  m.detail(id,{kind:"usage",turnId:"future",output:500,at:now+1000,startedAt:future,baseline:false});
  now++;m.detail(id,{kind:"usage",turnId:"future",output:1000,at:now+1000,startedAt:future,baseline:false});
  assert.equal(m.snapshot().tokens.output,null);
  assert.equal(Reflect.get(m,"turns").size,512);
  assert.equal(Reflect.get(m.snapshot().tokens,"coverage"),"partial");
});

test("full snapshot coverage is exact; ambiguous incremental overflow stays honestly unknown without duplicate inflation",()=>{
  const m=new MissionModel();
  m.shell({kind:"snapshot",sequence:1,threads:Array.from({length:49},(_,i)=>row("t"+i))});
  assert.equal(m.snapshot().total,49);assert.equal(m.snapshot().truncated,true);
  m.shell({kind:"snapshot",sequence:2,threads:Array.from({length:48},(_,i)=>row("t"+i))});
  m.shell({kind:"thread",sequence:3,thread:row("overflow")});
  assert.equal(m.ids().length,48);assert.equal(m.snapshot().total,null);assert.equal(m.snapshot().truncated,true);
  m.shell({kind:"thread",sequence:4,thread:row("overflow")});
  m.shell({kind:"removed",sequence:5,threadId:m.ids()[0]!});
  m.shell({kind:"thread",sequence:6,thread:row("overflow")});
  assert.equal(m.snapshot().total,null);assert.equal(m.snapshot().truncated,true);
  m.shell({kind:"snapshot",sequence:7,threads:[row("only")]});
  assert.equal(m.snapshot().total,1);assert.equal(m.snapshot().truncated,false);
});
test("reconnect churn forgets departed cursors independently of cleared child subscriptions",async()=>{
  const model=new MissionModel(),controller=new AbortController();let round=0;const stale:number[]=[];
  const source:ReadSource={
    async shell(_options,sub){
      const id=round<60?"thread-"+round:"thread-0";round++;
      await sub.onEvent({kind:"snapshot",sequence:round,threads:[row(id)]});await sub.onEvent({kind:"synchronized"});
      await delay(1);if(round===61)controller.abort();
    },
    async detail(options,_id,cursor,emit){if(cursor!==undefined)stale.push(cursor);emit({kind:"cursor",sequence:8});emit({kind:"synchronized"});
      await new Promise<void>(resolve=>options.signal!.addEventListener("abort",()=>resolve(),{once:true}));},
  };
  await runSource(model,()=>({serverUrl:"http://127.0.0.1:1111",token:"fixture"}),controller.signal,source,1);
  assert.equal(round,61);assert.deepEqual(stale,[]);
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

test("detail adapter uses only official read subscription and omits unknown raw payload",async()=>{
  const {createServer}=await import("node:http");
  const {WebSocketServer}=await import("ws");
  const {connectMissionThread}=await import("../../src/t3/adapter.ts");
  const http=createServer(),wss=new WebSocketServer({server:http}),controller=new AbortController();
  const seen:unknown[]=[],requests:string[]=[];
  wss.on("connection",socket=>socket.on("message",data=>{
    const req=JSON.parse(String(data));
    if(req._tag==="Ping"){socket.send(JSON.stringify({_tag:"Pong"}));return;}
    if(req._tag!=="Request")return;
    requests.push(req.tag);assert.equal(req.payload.threadId,"fixture-thread");assert.equal(req.payload.afterSequence,7);
    assert.equal(req.payload.requestCompletionMarker,true);assert.equal(req.payload.acceptBoundedSnapshot,true);
    socket.send(JSON.stringify({_tag:"Chunk",requestId:req.id,values:[{kind:"event",sequence:7,event:{id:"command-event",threadId:"fixture-thread",occurredAt:"2026-10-18T18:00:00.000Z",type:"turn-item.updated",payload:{id:"command-item",threadId:"fixture-thread",runId:null,nodeId:null,providerThreadId:null,providerTurnId:null,nativeItemRef:null,parentItemId:null,ordinal:0,status:"running",title:"PRIVATE TITLE",startedAt:null,completedAt:null,updatedAt:"2026-10-18T18:00:00.000Z",type:"command_execution",input:"cat /private/key Bearer SECRET",output:"PRIVATE OUTPUT"}}},{kind:"event",sequence:8,event:{type:"future.safe",payload:{input:"RAW_SECRET"}}},{"kind":"event","sequence":9,"event":{"id":"usage-event","threadId":"fixture-thread","occurredAt":"2026-10-18T18:00:00.000Z","type":"provider-turn.updated","payload":{"id":"fixture-turn","providerThreadId":"provider-thread","nodeId":"node","runAttemptId":null,"nativeTurnRef":null,"ordinal":1,"status":"running","startedAt":"2026-10-18T18:00:00.000Z","completedAt":null,"tokenUsage":{"usedTokens":500,"outputTokens":500,"updatedAt":"2026-10-18T18:00:00.000Z"}}}},{kind:"synchronized"}]}));
  }));
  await new Promise<void>(resolve=>http.listen(0,"127.0.0.1",resolve));
  try{
    const port=(http.address() as {port:number}).port;
    const done=connectMissionThread({serverUrl:"http://127.0.0.1:"+port,token:"DISPOSABLE_FIXTURE",signal:controller.signal},"fixture-thread",7,event=>{seen.push(event);if(event.kind==="synchronized")controller.abort();});
    await assert.rejects(done);assert.deepEqual(seen,[{kind:"activity",tool:"command_execution"},{kind:"cursor",sequence:7},{kind:"cursor",sequence:8},{kind:"usage",turnId:"fixture-turn",output:500,startedAt:Date.parse("2026-10-18T18:00:00.000Z"),at:Date.parse("2026-10-18T18:00:00.000Z"),baseline:false},{kind:"cursor",sequence:9},{kind:"synchronized"}]);assert.deepEqual(requests,["orchestration.subscribeThread"]);
  }finally{wss.close();http.close();}
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
    assert.equal((await get(port,"/?mode=agents")).status,200);
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
