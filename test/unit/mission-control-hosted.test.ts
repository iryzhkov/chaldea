import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync } from "node:fs";
import { join } from "node:path";
import { request } from "node:http";
import { MissionModel } from "../../src/mission-control/model.ts";
import { captureSnapshot,validateHostSnapshot } from "../../src/mission-control/contract.ts";
import { CacheModel,emptyCache,mergeStatus,writeCache,loadCache,webConfig } from "../../src/mission-control/cache.ts";
import { readerConfig,refreshStatus } from "../../src/mission-control/reader.ts";
import { captureConfig } from "../../src/mission-control/capture.ts";
import { Outbox } from "../../src/events/outbox.ts";
import { collect } from "../../src/events/collector.ts";
import { publish,type PublisherOptions } from "../../src/events/publisher.ts";
import { missionServer } from "../../src/mission-control/server.ts";
import { eventsConfig } from "../../src/config/events.ts";
import type { ShellThread } from "../../src/t3/adapter.ts";
const now0=Date.parse("2026-10-18T19:00:00Z"),epoch="a".repeat(32);
function scratch(){const root=process.env.CHALDEA_TEST_SCRATCH!;assert.ok(root&&!root.startsWith("/tmp"));const path=mkdtempSync(join(root,"mc-"));return{path,close:()=>rmSync(path,{recursive:true,force:true})};}
const row=(id="private-thread"):ShellThread=>({id,title:"PRIVATE arbitrary task /home/igor/key",status:"running",providerInstanceId:"SECRET account alias",modelSelection:{instanceId:"SECRET",model:"gpt-6.1-sol"},latestRunId:"private-run",activeRunId:"private-run",latestRunStartedAt:new Date(now0-1000).toISOString(),latestRunCompletedAt:null,lastErrorClass:null,usageLimitResetAt:null,limitRecovery:null,relationshipToParent:null,archived:false,deleted:false});
function live(clock=()=>now0,rows=[row()]){const m=new MissionModel(false,clock);m.shell({kind:"snapshot",sequence:1,threads:rows});m.shell({kind:"synchronized"});for(const r of rows)m.detail(r.id,{kind:"synchronized"});return m;}
const sample=(sequence=1,now=now0)=>captureSnapshot(live(()=>now),"agent-a",epoch,sequence)!;

test("four-source cache admits at most48 global rows and labels omitted rows honestly",()=>{
  const c=emptyCache();for(const host of ["agent-a","agent-b","omarchy-pc","laptop"]){
    const s=sample();s.host=host;s.agents=Array.from({length:40},(_,i)=>({...s.agents[0]!,id:i.toString(16).padStart(16,"0")}));s.total=40;s.truncated=false;
    mergeStatus(c,validateHostSnapshot(s),now0);
  }
  assert.equal(c.snapshots.length,4);assert.equal(c.snapshots.reduce((n,s)=>n+s.agents.length,0),48);
  assert.equal(c.snapshots.reduce((n,s)=>n+s.total!,0),160);assert.ok(c.snapshots.every(s=>s.truncated));
  const d=scratch();try{const file=join(d.path,"cache");writeCache(file,c);assert.ok(readFileSync(file).length<=512*1024);const m=new CacheModel(file,()=>now0);assert.equal(m.snapshot().total,160);assert.equal(m.snapshot().agents.length,48);assert.equal(m.snapshot().truncated,true);}finally{d.close();}
});
test("capture samples quiet live state, preserves activity age and private metadata never escapes",()=>{
  let now=now0;const m=live(()=>now);m.detail("private-thread",{kind:"activity",tool:"read"});
  let s=captureSnapshot(m,"agent-a",epoch,1)!;
  assert.equal(s.tokens.qualified,false);assert.equal(s.tokens.output,null);assert.equal(s.agents[0]!.steps[0],"read");
  for(const secret of ["PRIVATE","/home/igor","SECRET","private-run","private-thread"])assert.equal(JSON.stringify(s).includes(secret),false);
  now+=60_000;s=captureSnapshot(m,"agent-a",epoch,2)!;
  assert.equal(s.observedAt,now);assert.equal(s.agents[0]!.detailObservedAt,now0);assert.equal(s.agents[0]!.observedAt,now0);
  m.disconnected();const stopped=captureSnapshot(m,"agent-a",epoch,3)!;now+=60_000;
  assert.equal(captureSnapshot(m,"agent-a",epoch,4)!.observedAt,stopped.observedAt);
  m.shell({kind:"synchronized"});assert.equal(captureSnapshot(m,"agent-a",epoch,5)!.observedAt,now);
  const many=live(()=>now,Array.from({length:49},(_,i)=>row("private-"+i)));
  s=captureSnapshot(many,"agent-a",epoch,6)!;assert.equal(s.total,49);assert.ok(s.agents.length<=48);assert.equal(s.truncated,true);assert.ok(Buffer.byteLength(JSON.stringify(s))<=8192);
});
test("cache replaces epoch samples and keeps unknown/partial sticky without fetching a newer age",()=>{
  const c=emptyCache(),s=sample();assert.equal(mergeStatus(c,s,now0),true);
  assert.equal(mergeStatus(c,s,now0+10_000),false);
  const future={...s,sequence:10,observedAt:now0+1};assert.equal(mergeStatus(c,future,now0),false);
  const qualified={...sample(2,now0+1),tokens:{qualified:true,output:100,rate:1,observedAt:now0,coverage:"observed" as const}};
  mergeStatus(c,qualified,now0+1);assert.equal(c.snapshots[0]!.tokens.output,null);
  const c2=emptyCache();mergeStatus(c2,{...qualified,tokens:{...qualified.tokens,coverage:"partial"}},now0+1);
  mergeStatus(c2,{...qualified,sequence:3,tokens:{...qualified.tokens,output:120}},now0+1);assert.equal(c2.snapshots[0]!.tokens.output,120);assert.equal(c2.snapshots[0]!.tokens.coverage,"partial");
  mergeStatus(c2,{...qualified,epoch:"c".repeat(32),sequence:1,observedAt:now0+2,tokens:{...qualified.tokens,output:5}},now0+2);
  assert.equal(c2.snapshots[0]!.tokens.output,5);assert.equal(c2.gap,true);
  assert.equal(mergeStatus(c2,{...qualified,sequence:999},now0+3),false);
});
test("restarted web treats retained cache as cached until newer source evidence arrives",()=>{
  const d=scratch();let now=now0;
  try{
    const path=join(d.path,"restart.json"),cache=emptyCache();mergeStatus(cache,sample(),now);writeCache(path,cache);
    const model=new CacheModel(path,()=>now);
    assert.equal(model.snapshot().source.state,"cached");
    now+=5000;model.reload();assert.equal(model.snapshot().source.state,"cached");
    assert.equal(model.snapshot().source.observedAt,now0);
    mergeStatus(cache,sample(2,now),now);writeCache(path,cache);model.reload();
    assert.equal(model.snapshot().source.state,"live");assert.equal(model.snapshot().source.observedAt,now);
  }finally{d.close();}
});
test("boot fence rejects older epochs and preserves stale/disconnected newer evidence",()=>{
  const d=scratch();let now=now0;
  try{
    const path=join(d.path,"fence.json"),cache=emptyCache();mergeStatus(cache,sample(),now);writeCache(path,cache);
    const model=new CacheModel(path,()=>now);
    const oldEpoch={...sample(1,now0-1),epoch:"b".repeat(32)};
    writeCache(path,{...cache,snapshots:[oldEpoch]});model.reload();assert.equal(model.snapshot().source.state,"cached");assert.equal(model.snapshot().source.observedAt,now0-1);
    now+=10000;const disconnected=sample(2,now);disconnected.connected=false;disconnected.agents[0]!.connected=false;mergeStatus(cache,disconnected,now);writeCache(path,cache);model.reload();assert.equal(model.snapshot().source.state,"disconnected");
    now+=110000;const stale=sample(3,now0+20000);mergeStatus(cache,stale,now);writeCache(path,cache);model.reload();assert.equal(model.snapshot().source.state,"stale");assert.equal(model.snapshot().source.observedAt,now0+20000);
  }finally{d.close();}
});
test("atomic group-readable cache survives offline reload, then expires and does not make heartbeats live",async()=>{
  const d=scratch();try{
    const path=join(d.path,"latest.json"),c=emptyCache();mergeStatus(c,sample(),now0);writeCache(path,c);
    assert.equal(statSync(path).mode&0o777,0o640);assert.equal(loadCache(path,now0).snapshots.length,1);
    let now=now0;const m=new CacheModel(path,()=>now);assert.equal(m.snapshot().source.state,"cached");
    now+=91_000;m.reload();assert.equal(m.snapshot().source.state,"stale");assert.equal(m.snapshot().source.observedAt,now0);
    const {projectClientSnapshot}=await import("../../src/mission-control/static/client.js" as string);
    const projected=projectClientSnapshot(m.snapshot(),now,true);assert.equal(projected.source.observedAt,now0);assert.equal(projected.agents[0].detailObservedAt,now0);
    writeFileSync(path,"corrupt",{mode:0o640});m.reload();assert.equal(m.snapshot().agents.length,1);assert.equal(m.snapshot().source.observedAt,now0);
    now=now0+86400_001;assert.equal(m.snapshot().source.state,"nosource");assert.equal(m.snapshot().agents.length,0);
  }finally{d.close();}
});
test("collector coalesces latest state behind one frozen retry, expires gaps, keeps ordinary backlog semantics",async()=>{
  const d=scratch(),outbox=new Outbox(join(d.path,"collector.db"));let now=now0;const seen:string[]=[];
  try{
    const file=join(d.path,"snapshot.json"),spool=join(d.path,"spool");mkdirSync(spool);
    const write=(seq:number)=>writeFileSync(file,JSON.stringify(sample(seq,now)),{mode:0o600});
    const deliver=async(e:any)=>{seen.push(JSON.stringify(e));return false;};
    write(1);await collect({outbox,host:"agent-a",spool,missionControlSnapshotFile:file,deliver,now:()=>now});
    const original=seen[0];now+=31_000;write(2);await collect({outbox,host:"agent-a",spool,missionControlSnapshotFile:file,deliver,now:()=>now});
    assert.equal(seen[1],original);assert.equal(outbox.statusState().latest!.key.endsWith(":2"),true);
    outbox.close();const reopened=new Outbox(join(d.path,"collector.db"));
    try{
      now+=31_000;write(3);await collect({outbox:reopened,host:"agent-a",spool,missionControlSnapshotFile:file,deliver,now:()=>now});assert.equal(seen[2],original);
      now+=60_000;write(4);await collect({outbox:reopened,host:"agent-a",spool,missionControlSnapshotFile:file,deliver:async(e)=>{seen.push(JSON.stringify(e));return true;},now:()=>now});
      assert.notEqual(seen[3],original);assert.ok(seen[3]!.includes(epoch+":4"));assert.equal(reopened.statusState().pending,null);
      assert.equal(reopened.counters().status_expired_gap,1);assert.equal(reopened.counters().status_delivered,1);
      await collect({outbox:reopened,host:"agent-a",spool,missionControlSnapshotFile:file,deliver:async()=>{throw new Error("duplicate");},now:()=>now});
      assert.equal(reopened.statusState().pending,null);
      assert.equal(reopened.db.prepare("PRAGMA max_page_count").get()!.max_page_count,4096);
    }finally{reopened.close();}
  }finally{try{outbox.close();}catch{}d.close();}
});

test("ordinary tombstone acknowledgement remains compatible while status records an expired gap",async()=>{
  const d=scratch(),outbox=new Outbox(join(d.path,"tombstone.db"));let attempts=0;
  try{
    const publisher:PublisherOptions={url:"https://fixture.invalid",token:async()=>"fixture",fetch:async()=>{attempts++;return new Response(JSON.stringify({event_id:"f".repeat(64),state:"tombstone"}),{status:410});}};
    assert.equal(await publish({key:"ordinary",source:"agent-a.toolfeedback",host:"agent-a",payload:{v:1,kind:"tool_call"}},publisher),true);
    const file=join(d.path,"snapshot.json");writeFileSync(file,JSON.stringify(sample()),{mode:0o600});
    await collect({outbox,host:"agent-a",spool:d.path,missionControlSnapshotFile:file,publisher,now:()=>now0});
    assert.equal(attempts,2);assert.equal(outbox.counters().status_expired_gap,1);assert.equal(outbox.counters().status_delivered,undefined);assert.equal(outbox.statusState().pending,null);
  }finally{outbox.close();d.close();}
});
test("unconfigured collector leaves optional status table absent and env seam is explicit",async()=>{
  const d=scratch(),o=new Outbox(join(d.path,"collector.db"));
  try{await collect({outbox:o,spool:d.path,host:"agent-a",deliver:async()=>true});assert.equal(o.db.prepare("SELECT name FROM sqlite_master WHERE name='mission_control_status'").get(),undefined);
    const old=process.env.AKASHA_MISSION_CONTROL_SNAPSHOT_FILE;
    try{process.env.AKASHA_MISSION_CONTROL_SNAPSHOT_FILE=join(d.path,"capture.json");assert.equal(eventsConfig().missionControlSnapshotFile,join(d.path,"capture.json"));process.env.AKASHA_MISSION_CONTROL_SNAPSHOT_FILE="relative";assert.throws(()=>eventsConfig());}
    finally{if(old===undefined)delete process.env.AKASHA_MISSION_CONTROL_SNAPSHOT_FILE;else process.env.AKASHA_MISSION_CONTROL_SNAPSHOT_FILE=old;}
  }finally{o.close();d.close();}
});
test("fixed configuration rejects source selectors, helper contamination and raw endpoints",()=>{
  const d=scratch(),path=join(d.path,"config.json");
  const reader={url:"https://akasha.example",tokenHelper:"/fixed/helper",source:"mission-control-reader",host:"omarchy-normandy",profile:"mission-control-reader",project:"chaldea",allowedSourceIds:["agent-a--mission-control"],cacheFile:join(d.path,"cache"),refreshMs:5000};
  const check=(value:unknown,fn:(p:string)=>unknown)=>{writeFileSync(path,JSON.stringify(value));return fn(path);};
  try{
    assert.equal((check(reader,readerConfig)as any).source,"mission-control-reader");
    for(const v of [{...reader,url:"http://akasha.example"},{...reader,url:"https://akasha.example/api/entries"},{...reader,allowedSourceIds:[]},{...reader,allowedSourceIds:["arbitrary"]},{...reader,source:"quota"},{...reader,refreshMs:1},{...reader,tokenFile:"/secret"}])assert.throws(()=>check(v,readerConfig));
    assert.equal((check({mode:"cache",siteOrigin:"https://chaldeas.ryzhkov.dev",listen:"127.0.0.1",port:7392,cacheFile:reader.cacheFile},webConfig)as any).mode,"cache");
    assert.throws(()=>check({mode:"cache",siteOrigin:"https://chaldeas.ryzhkov.dev",listen:"127.0.0.1",port:7392,cacheFile:reader.cacheFile,t3BaseDir:"/secret"},webConfig));
    assert.equal((check({host:"agent-a",t3BaseDir:"/t3",tokenFile:"/private/token",snapshotFile:"/private/latest"},captureConfig)as any).tokenSemanticsQualified,false);
  }finally{d.close();}
});
test("reader binds pagination to one window, resets410 as a gap and fails closed on redirects/oversize/partial pages",async()=>{
  const c={url:"https://akasha.example",tokenHelper:"/helper",source:"mission-control-reader",host:"omarchy-normandy",profile:"mission-control-reader",project:"chaldea",allowedSourceIds:["agent-a--mission-control"],cacheFile:"/cache",refreshMs:5000} as const;
  const config={...c,allowedSourceIds:[...c.allowedSourceIds]};
  const old=emptyCache();mergeStatus(old,sample(),now0);
  let page=0;const urls:string[]=[];
  const result=await refreshStatus(config,old,{now:()=>now0+1000,token:async()=>"fixture",fetch:async(url,options)=>{
    assert.equal(options!.redirect,"error");assert.equal(new URL(String(url)).searchParams.get("limit"),"128");urls.push(String(url));page++;
    return page===1?new Response(JSON.stringify({events:[],next_cursor:"cursor"})):page===2?new Response("",{status:410}):new Response(JSON.stringify({events:[],next_cursor:null}));
  }});
  assert.equal(result.gap,true);assert.equal(result.snapshots[0]!.observedAt,now0);
  assert.equal(new URL(urls[0]!).searchParams.get("from"),new URL(urls[1]!).searchParams.get("from"));assert.equal(new URL(urls[2]!).searchParams.has("cursor"),false);
  for(const response of [new Response("",{status:302}),new Response(" ".repeat(2*1024**2+1)),new Response(JSON.stringify({events:[],next_cursor:"same"}))]){
    const next=await refreshStatus(config,old,{now:()=>now0+1000,token:async()=>"fixture",fetch:async()=>response.clone()});
    assert.equal(next.gap,true);assert.equal(next.snapshots[0]!.observedAt,now0);
  }
});
test("hosted HTTP is independent of T3, enforces fixed proxy origin and keeps liveness apart from readiness",async()=>{
  const d=scratch();let now=now0;const path=join(d.path,"cache.json"),c=emptyCache();mergeStatus(c,sample(),now);writeCache(path,c);
  const model=new CacheModel(path,()=>now);now++;mergeStatus(c,sample(2,now),now);writeCache(path,c);model.reload();
  const server=missionServer(model,8,{siteOrigin:"https://chaldeas.ryzhkov.dev"});await server.listen(0);
  const port=(server.server.address()as{port:number}).port;
  const get=(url:string,headers:Record<string,string>={},method="GET")=>new Promise<{status:number;headers:any;body:string}>(resolve=>{
    const req=request({host:"127.0.0.1",port,path:url,method,headers:{Host:"chaldeas.ryzhkov.dev",...headers}},res=>{let body="";res.on("data",b=>body+=b);res.on("end",()=>resolve({status:res.statusCode!,headers:res.headers,body}));});req.end();
  });
  try{
    assert.equal((await get("/healthz")).status,200);assert.equal((await get("/readyz")).status,200);
    for(const headers of [{Host:"evil.example"},{Origin:"https://evil.example"},{"Sec-Fetch-Site":"cross-site"},{"Cf-Ray":"forbidden"},{"X-Forwarded-Host":"chaldeas.ryzhkov.dev",Host:"evil.example"}])assert.equal((await get("/api/snapshot",headers)).status,403);
    assert.equal((await get("/api/snapshot",{Origin:"https://chaldeas.ryzhkov.dev"})).status,200);assert.equal((await get("/api/snapshot",{},"POST")).status,405);
    assert.equal((await get("/rpc")).status,404);assert.match((await get("/")).headers["content-security-policy"],/frame-ancestors 'none'/);
    now+=601_000;const stale=await get("/api/snapshot");assert.equal(JSON.parse(stale.body).source.state,"lost");assert.equal((await get("/healthz")).status,200);assert.equal((await get("/readyz")).status,503);
  }finally{await server.close();d.close();}
});
