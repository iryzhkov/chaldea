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
// Mutation-heavy fixtures exercise legacy v1 compatibility.
const sample=(sequence=1,now=now0)=>{const s=captureSnapshot(live(()=>now),"agent-a",epoch,sequence)!;delete s.rich;return s;};


for(const existingSlot of [false,true])test("R1 full4096page status admission cannot starve100 protected ordinary deliveries, existingSlot="+existingSlot,async()=>{
  const d=scratch(),o=new Outbox(join(d.path,"full.db"));
  try{
    if(existingSlot)o.statusState();
    const cursor={generation:"fixture",dev:"0",ino:"1",offset:1,prefix:"",prefixLength:0,tail:""};
    for(let i=0;i<280;i++)assert.equal(o.admit({key:"ordinary-"+i,source:"agent-a.toolfeedback",host:"agent-a",payload:{v:1,kind:"tool_call",body:"x".repeat(54000)}},"ordinary",cursor),true);
    o.db.exec("CREATE TABLE fixture_pressure(value BLOB)");
    const fill=o.db.prepare("INSERT INTO fixture_pressure VALUES(zeroblob(3500))");
    while(true){try{fill.run();}catch(error){assert.match(String(error),/full/i);break;}}
    assert.equal(o.db.prepare("PRAGMA page_count").get()!.page_count,4096);
    const s=sample();s.agents=Array.from({length:40},(_,i)=>({...s.agents[0]!,id:i.toString(16).padStart(16,"0")}));s.total=40;
    validateHostSnapshot(s);assert.ok(Buffer.byteLength(JSON.stringify(s))>7000);
    const file=join(d.path,"snapshot.json");writeFileSync(file,JSON.stringify(s),{mode:0o600});
    const sent:string[]=[];
    await collect({outbox:o,host:"agent-a",spool:join(d.path,"absent"),missionControlSnapshotFile:file,now:()=>now0,deliver:async e=>{assert.notEqual(e.payload.kind,"agent_status","unsaved status must never send");sent.push(e.key);return true;}});
    assert.equal(sent.length,100);assert.equal(o.db.prepare("SELECT count(*) AS n FROM pending").get()!.n,180);
    assert.equal(o.next()!.event.key,"ordinary-100");assert.equal((o.next()!.event.payload.body as string).length,54000);
  }finally{o.close();d.close();}
});
test("R1 optional counter/save failures retain frozen status while ordinary errors still propagate",async()=>{
  const d=scratch(),o=new Outbox(join(d.path,"guard.db"));
  try{
    const file=join(d.path,"snapshot.json");writeFileSync(file,JSON.stringify(sample()),{mode:0o600});
    const save=o.saveStatus.bind(o),count=o.count.bind(o);let writes=0;const sent:string[]=[];
    o.saveStatus=s=>{if(++writes===2)throw new Error("database or disk is full");save(s);};
    o.count=(name,n)=>{if(name.startsWith("status_"))throw new Error("database or disk is full");count(name,n);};
    await collect({outbox:o,host:"agent-a",spool:join(d.path,"absent"),missionControlSnapshotFile:file,now:()=>now0,deliver:async e=>{sent.push(JSON.stringify(e));return true;}});
    assert.ok(o.statusState().pending);o.saveStatus=save;o.count=count;
    await collect({outbox:o,host:"agent-a",spool:join(d.path,"absent"),missionControlSnapshotFile:file,now:()=>now0+1000,deliver:async e=>{sent.push(JSON.stringify(e));return true;}});
    assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.equal(o.statusState().pending,null);
    const cursor={generation:"fixture",dev:"0",ino:"1",offset:1,prefix:"",prefixLength:0,tail:""};
    o.admit({key:"ordinary",source:"agent-a.toolfeedback",host:"agent-a",payload:{v:1,kind:"tool_call"}},"ordinary",cursor);
    o.count=()=>{throw new Error("ordinary counter error");};
    await assert.rejects(collect({outbox:o,host:"agent-a",spool:join(d.path,"absent"),deliver:async()=>true}),/ordinary counter error/);
    assert.equal(o.next()!.event.key,"ordinary");
  }finally{o.close();d.close();}
});
test("R1 qualified unknown is a valid wire state and remains unknown within its epoch",()=>{
  const c=emptyCache(),unknown=sample();unknown.tokens={qualified:true,output:null,rate:null,observedAt:null,coverage:"unknown"};
  mergeStatus(c,validateHostSnapshot(unknown),now0);
  const observed={...sample(2,now0+1),tokens:{qualified:true,output:100,rate:1,observedAt:now0,coverage:"observed" as const}};
  mergeStatus(c,validateHostSnapshot(observed),now0+1);assert.deepEqual(c.snapshots[0]!.tokens,unknown.tokens);
  mergeStatus(c,{...observed,epoch:"b".repeat(32),sequence:1,observedAt:now0+2},now0+2);
  assert.equal(c.snapshots[0]!.tokens.output,100);assert.equal(c.gap,true);
});
test("R1 first successful cache load after missing or invalid startup establishes a baseline",()=>{
  for(const initial of ["missing","invalid"]){
    const d=scratch();let now=now0;
    try{
      const path=join(d.path,"late.json");if(initial==="invalid")writeFileSync(path,"invalid");
      const m=new CacheModel(path,()=>now),c=emptyCache();mergeStatus(c,sample(),now);writeCache(path,c);m.reload();
      assert.equal(m.snapshot().source.state,"cached");now+=1000;m.reload();assert.equal(m.snapshot().source.state,"cached");
      mergeStatus(c,sample(2,now),now);writeCache(path,c);m.reload();assert.equal(m.snapshot().source.state,"live");
      const b={...sample(1,now),host:"agent-b"};mergeStatus(c,b,now);writeCache(path,c);m.reload();assert.equal(m.snapshot().agents.find(a=>a.host==="agent-b")!.freshness,"cached");
    }finally{d.close();}
  }
});
test("four-source cache admits at most48 global rows and labels omitted rows honestly",()=>{
  const c=emptyCache();for(const host of ["agent-a","agent-b","omarchy-pc","omarchy-macbook-air-igor"]){
    const s=sample();s.host=host;s.agents=Array.from({length:40},(_,i)=>({...s.agents[0]!,id:i.toString(16).padStart(16,"0")}));s.total=40;s.truncated=false;
    mergeStatus(c,validateHostSnapshot(s),now0);
  }
  assert.equal(c.snapshots.length,4);assert.equal(c.snapshots.reduce((n,s)=>n+s.agents.length,0),48);
  assert.equal(c.snapshots.reduce((n,s)=>n+s.total!,0),160);assert.ok(c.snapshots.every(s=>s.truncated));
  const d=scratch();try{const file=join(d.path,"cache");writeCache(file,c);assert.ok(readFileSync(file).length<=512*1024);const m=new CacheModel(file,()=>now0);assert.equal(m.snapshot().total,160);assert.equal(m.snapshot().agents.length,48);assert.equal(m.snapshot().truncated,true);}finally{d.close();}
});

test("canonical four-host capture and collector retain exact private snapshot identities",async()=>{
  const d=scratch(),path=join(d.path,"config.json");
  const hosts=["agent-a","agent-b","omarchy-pc","omarchy-macbook-air-igor"];
  try{
    const reader={url:"https://akasha.example",tokenHelper:"/fixed/helper",source:"mission-control-reader",host:"omarchy-normandy",profile:"mission-control-reader",project:"chaldea",allowedSourceIds:hosts.map(h=>h+"--mission-control"),cacheFile:join(d.path,"cache"),refreshMs:5000};
    writeFileSync(path,JSON.stringify(reader));assert.deepEqual(readerConfig(path).allowedSourceIds,reader.allowedSourceIds);
    for(const host of hosts){
      const config={host,t3BaseDir:"/t3",tokenFile:"/private/token",snapshotFile:join(d.path,"snapshot-"+host)};
      writeFileSync(path,JSON.stringify(config));assert.equal(captureConfig(path).host,host);
      const snapshot=captureSnapshot(live(),host,epoch,1)!;writeFileSync(config.snapshotFile,JSON.stringify(snapshot),{mode:0o600});
      const outbox=new Outbox(join(d.path,host+".db"));
      try{let sent=0;await collect({outbox,host,spool:join(d.path,"absent"),missionControlSnapshotFile:config.snapshotFile,now:()=>now0,deliver:async e=>{
        sent++;assert.equal(e.host,host);assert.equal(e.source,host+".mission-control");assert.deepEqual((e.payload.data as any).snapshot,snapshot);return true;
      }});assert.equal(sent,1);}finally{outbox.close();}
    }
    assert.throws(()=>captureSnapshot(live(),"laptop",epoch,1),/invalid_host_snapshot/);
    writeFileSync(path,JSON.stringify({...reader,allowedSourceIds:["laptop--mission-control"]}));assert.throws(()=>readerConfig(path),/invalid_reader_config/);
    writeFileSync(path,JSON.stringify({host:"laptop",t3BaseDir:"/t3",tokenFile:"/private/token",snapshotFile:"/private/latest"}));assert.throws(()=>captureConfig(path),/invalid_capture_config/);
  }finally{d.close();}
});

test("capture samples quiet live state, preserves activity age and private metadata never escapes",()=>{
  let now=now0;const m=live(()=>now);m.detail("private-thread",{kind:"activity",tool:"read"});
  let s=captureSnapshot(m,"agent-a",epoch,1)!;
  assert.equal(s.tokens.qualified,false);assert.equal(s.tokens.output,null);assert.equal(s.agents[0]!.steps[0],"read");
  for(const secret of ["PRIVATE","/home/igor","SECRET","private-run"])assert.equal(JSON.stringify(s).includes(secret),false);
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
test("collector yields a slow ordinary drain after durable ACKs and both lanes progress",async()=>{
  const d=scratch(),file=join(d.path,"snapshot.json"),db=join(d.path,"sliced.db");
  let now=now0,o=new Outbox(db);const ordinary:string[]=[],statuses:number[]=[];
  try{
    for(let i=0;i<7;i++)o.admit({key:"ordinary-"+i,source:"agent-a.toolfeedback",host:"agent-a",payload:{v:1,kind:"tool_call"}},"input",{generation:"fixture",dev:"0",ino:"1",offset:i+1,prefix:"",prefixLength:0,tail:""});
    for(let seq=1;seq<=4;seq++){
      writeFileSync(file,JSON.stringify(sample(seq,now)),{mode:0o600});
      const start=now;let delivered=0,first=true;
      await collect({outbox:o,host:"agent-a",spool:join(d.path,"absent"),missionControlSnapshotFile:file,now:()=>now,deliver:async e=>{
        if(first){assert.equal(e.payload.kind,"agent_status");first=false;}
        if(e.payload.kind==="agent_status")statuses.push((e.payload.data as any).snapshot.sequence);
        else {ordinary.push(e.key);delivered++;now+=1100;}
        return true;
      }});
      assert.ok(delivered>=1&&delivered<=2);assert.ok(now-start<=3100,"two-second slice plus one request");
      assert.equal(o.cursor("input")!.offset,ordinary.length);
      o.close();o=new Outbox(db);now+=5000;
    }
    assert.deepEqual(statuses,[1,2,3,4]);assert.deepEqual(ordinary,Array.from({length:7},(_,i)=>"ordinary-"+i));
    assert.equal(o.next(),null);
  }finally{o.close();d.close();}
});
test("collector admits latest at five seconds, never early",async()=>{
  const d=scratch(),o=new Outbox(join(d.path,"cadence.db")),file=join(d.path,"sample");let now=now0,sent=0;
  try{
    for(const [seq,offset,expected] of [[1,0,1],[2,4999,1],[3,5000,2]]){
      now=now0+offset!;writeFileSync(file,JSON.stringify(sample(seq,now)),{mode:0o600});
      await collect({outbox:o,host:"agent-a",spool:join(d.path,"absent"),missionControlSnapshotFile:file,now:()=>now,deliver:async()=>{sent++;return true;}});
      assert.equal(sent,expected);
    }
  }finally{o.close();d.close();}
});
test("summary retains fresh zero, missing and stale hosts with independent quiet activity age",()=>{
  const d=scratch();let now=now0;
  try{
    const path=join(d.path,"summary"),cache=emptyCache(),zero=sample();zero.agents=[];zero.total=0;
    mergeStatus(cache,zero,now);const busy=sample();busy.host="agent-b";mergeStatus(cache,busy,now);writeCache(path,cache);
    const model=new CacheModel(path,()=>now);now+=65_000;
    const next={...busy,sequence:2,observedAt:now};mergeStatus(cache,next,now);
    const nextZero={...zero,sequence:2,observedAt:now};mergeStatus(cache,nextZero,now);writeCache(path,cache);model.reload();
    const view=model.snapshot(),a=view.hostSummary.find(h=>h.host==="agent-a")!;
    assert.equal(a.total,0);assert.equal(a.freshness,"live");assert.equal(a.observedAt,now);
    assert.equal(view.hostSummary.find(h=>h.host==="omarchy-pc")!.total,null);
    assert.equal(view.hostSummary.find(h=>h.host==="omarchy-pc")!.freshness,"nosource");
    assert.deepEqual(view.hostSummary.find(h=>h.host==="agent-b")!.models.map(({model,count})=>({model,count})),[{model:"gpt-6.1-sol",count:1}]);
    assert.equal(view.agents[0]!.activityFreshness,"live");assert.equal(view.agents[0]!.detailObservedAt,now0);
    now+=91_000;assert.equal(model.snapshot().hostSummary.find(h=>h.host==="agent-a")!.freshness,"stale");
    assert.equal(model.snapshot().hostSummary.find(h=>h.host==="agent-a")!.observedAt,now0+65_000);
  }finally{d.close();}
});
test("fixed activity normalization crosses old-shape capture without arbitrary text",()=>{
  const m=live();for(const [input,expected] of [["mcp__huyang__read","read"],["functions.mcp__huyang__edit_apply","edit_apply"],["command_execution","Command running"]]){
    m.detail("private-thread",{kind:"activity",tool:input!});
    const s=captureSnapshot(m,"agent-a",epoch,1)!;assert.equal(s.agents[0]!.steps[0],expected);
    assert.equal(validateHostSnapshot(s).schema,"mission-control.host.v1");
  }
  m.detail("private-thread",{kind:"activity",tool:"mcp__evil__read /private/token"});
  const s=captureSnapshot(m,"agent-a",epoch,2)!;assert.ok(!JSON.stringify(s).includes("/private"));
  s.agents[0]!.steps=["arbitrary"];assert.throws(()=>validateHostSnapshot(s));
  assert.equal(validateHostSnapshot(sample()).agents[0]!.steps.length,0);
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
  assert.equal(new URL(urls[0]!).searchParams.get("from"),new Date(now0+1000-120_000).toISOString());
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

test("rich capture crosses ordinary collector/cache with resources, privacy, usage and exact identities",async()=>{
 const d=scratch(),m=live();
 try{
  m.shell({kind:"thread",sequence:2,thread:{...row(),title:"Actual task",providerInstanceId:"custom-work",modelSelection:{instanceId:"custom-work",model:"gpt-6.1-sol"}}});
  m.setProviderCatalog([{instanceId:"custom-work",driver:"codex"}]);
  for(let i=0;i<3;i++)m.detail("private-thread",{kind:"recent-item",id:"actual-"+i,ordinal:i,type:i===1?"command":"assistant",text:i===1?"go test":"Earlier paragraph\n\nActual paragraph "+i,at:now0,status:"unknown"});
  m.setResources({state:"reported",sample:{sampledAt:now0,cpuUtilization:0.25,cpuCount:12,availableMemoryBytes:400,totalMemoryBytes:1000}});
  m.detail("private-thread",{kind:"assistant",text:"Earlier paragraph\n\nThe tests passed <script>alert(1)</script>.",at:now0});
  m.detail("private-thread",{kind:"command",id:"private-command",input:"go test -race ./...",running:true});
  m.detail("private-thread",{kind:"turn-usage",id:"private-turn",at:now0,usage:{usageScope:"main_agent",usageStatus:"complete",inputTokens:100,outputTokens:20,cachedInputTokens:30,cacheCreationTokens:10,reasoningTokens:5,hasSubagents:true}});
  const rich=captureSnapshot(m,"agent-a",epoch,1)!;validateHostSnapshot(rich);
  assert.equal(rich.rich!.resources.sample!.cpuUtilization,0.25);
  const detail=rich.rich!.details[0]!.value as import("../../src/mission-control/details.ts").Detail;
  assert.equal(rich.rich!.v,3);assert.deepEqual(detail.provider,{instanceId:"custom-work",driver:"codex"});assert.equal(detail.recent!.length,3);assert.equal(detail.recent![1]!.preview.text,"go test");assert.equal(detail.recent![1]!.status,"unknown");
  assert.equal(detail.commands[0]!.text,"go test -race ./...");assert.equal(detail.usage.total,120);assert.equal(detail.usage.rate,null);
  assert.equal(detail.assistant.text,"The tests passed <script>alert(1)</script>.");
  assert.equal(JSON.stringify(rich).includes("private-turn"),false);
  const forged=structuredClone(rich);((forged.rich!.details[0]!.value as import("../../src/mission-control/details.ts").Detail).usage as any).arbitrary=1;assert.throws(()=>validateHostSnapshot(forged));
  const wrong=structuredClone(rich);wrong.rich!.details[0]!.id="0".repeat(16);assert.throws(()=>validateHostSnapshot(wrong));
  const file=join(d.path,"rich.json");writeFileSync(file,JSON.stringify(rich),{mode:0o600});
  const outbox=new Outbox(join(d.path,"rich.db"));
  try{
   let delivered:any;
   await collect({outbox,host:"agent-a",spool:join(d.path,"absent"),missionControlSnapshotFile:file,now:()=>now0,deliver:async e=>{delivered=e;return true;}});
   assert.deepEqual(delivered.payload.data.snapshot,rich);
  }finally{outbox.close();}
  const cache=emptyCache();mergeStatus(cache,rich,now0);const cachePath=join(d.path,"cache");writeCache(cachePath,cache);
  const model=new CacheModel(cachePath,()=>now0),view=model.snapshot();
  assert.equal(view.hostSummary.find(h=>h.host==="agent-a")!.resources!.sample!.totalMemoryBytes,1000);
  assert.deepEqual(view.agents[0]!.details.provider,detail.provider);assert.deepEqual(view.agents[0]!.details.recent,detail.recent);
  assert.equal(view.agents[0]!.details.usage.total,120);
  assert.equal(view.hostSummary.find(h=>h.host==="agent-a")!.details!.usage.total,120);
  m.setResources({state:"unavailable",sample:null});const denied=captureSnapshot(m,"agent-a",epoch,2)!;
  assert.equal(denied.agents.length,1);assert.equal(denied.rich!.resources.state,"unavailable");
 }finally{d.close();}
});
test("optional privacy and malformed detail cannot freeze base capture",()=>{
 let now=now0;const m=live(()=>now);
 for(const text of ["Bearer\u200bXYZ","api\u001ckey","Bearer\u202eXYZ","api\tkey"]){
  m.shell({kind:"thread",sequence:m.cursor()!+1,thread:{...row(),title:text}});
  m.detail("private-thread",{kind:"assistant",text,at:now});
  const s=captureSnapshot(m,"agent-a",epoch,1)!;validateHostSnapshot(s);
  const d=s.rich!.details[0]!.value as import("../../src/mission-control/details.ts").Detail;
  assert.equal(s.agents.length,1);assert.equal(d.identity.title.state,"withheld");assert.equal(d.assistant.state,"withheld");
 }
 m.shell({kind:"thread",sequence:m.cursor()!+1,thread:{...row(),title:"Safe title"}});
 m.detail("private-thread",{kind:"command",id:"long",input:"git "+Array(12).fill("--porcelain").join(" "),running:true});
 let s=captureSnapshot(m,"agent-a",epoch,2)!;validateHostSnapshot(s);
 const d=s.rich!.details[0]!.value as import("../../src/mission-control/details.ts").Detail;
 assert.equal(d.commands[0]!.state,"truncated");assert.ok(Buffer.byteLength(d.commands[0]!.text!)<=128);
 m.detail("private-thread",{kind:"turn-usage",id:"bad-optional",at:now,usage:{usageScope:"main_agent",usageStatus:"complete",inputTokens:1,outputTokens:1,reasoningTokens:99,hasSubagents:false}});
 s=captureSnapshot(m,"agent-a",epoch,3)!;validateHostSnapshot(s);
 assert.equal(s.agents.length,1);assert.equal(s.rich!.details[0]!.value.fieldCoverage,"identity-only");
 m.disconnected();now+=1000;
 m.setResources({state:"reported",sample:{sampledAt:now,cpuUtilization:0.2,cpuCount:8,availableMemoryBytes:400,totalMemoryBytes:1000}});
 s=captureSnapshot(m,"agent-a",epoch,4)!;validateHostSnapshot(s);
 assert.equal(s.agents.length,1);assert.equal(s.rich!.resources.state,"unavailable");
 const blank=live();blank.detail("private-thread",{kind:"assistant",text:"\u200b\u001c",at:now0});
 const empty=captureSnapshot(blank,"agent-a",epoch,5)!;validateHostSnapshot(empty);
 assert.equal((empty.rich!.details[0]!.value as import("../../src/mission-control/details.ts").Detail).assistant.text,null);
});
test("rich detail byte budget preserves base rows and legacy validation",()=>{
 const rows=Array.from({length:48},(_,i)=>row("thread-"+i)),m=live(()=>now0,rows);
 for(const r of rows)m.detail(r.id,{kind:"assistant",text:"🧪 ".repeat(300),at:now0});
 const s=captureSnapshot(m,"agent-a",epoch,1)!;
 assert.ok(Buffer.byteLength(JSON.stringify(s))<=8192);assert.equal(s.total,48);
 const base=structuredClone(s);delete base.rich;validateHostSnapshot(base);
 assert.equal(s.agents.length,base.agents.length);
 if(s.rich){assert.equal(s.rich.details.length+s.rich.omitted,s.agents.length);assert.ok(s.rich.omitted>0);}
 const c=emptyCache();mergeStatus(c,s,now0);const second={...structuredClone(s),host:"agent-b"};mergeStatus(c,second,now0);
 for(const value of c.snapshots)validateHostSnapshot(value);
});

test("strict rich v2/v3 are separate exact schemas and recent metadata fails closed",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts"),{validateRich}=await import("../../src/mission-control/detail-contract.ts");
 const d=emptyDetail(),ids=new Set(["row"]),at=now0;
 d.provider={instanceId:"custom-work",driver:"codex"};
 d.recent=[{kind:"command",preview:{text:"go test",state:"reported"},at:now0,status:"unknown"}];
 const rich:any={v:3,resources:{state:"unavailable",sample:null},details:[{id:"row",value:d}],omitted:0};
 assert.deepEqual(validateRich(rich,ids,at),rich);
 const old=structuredClone(rich);old.v=2;delete old.details[0].value.provider;delete old.details[0].value.recent;validateRich(old,ids,at);
 const identity={...structuredClone(rich),details:[{id:"row",value:{identity:d.identity,fieldCoverage:"identity-only"}}]};validateRich(identity,ids,at);
 for(const mutate of [
  (x:any)=>x.v=4,(x:any)=>x.v=2,(x:any)=>delete x.details[0].value.provider,
  (x:any)=>x.details[0].value.provider.auth="secret",(x:any)=>x.details[0].value.provider.instanceId="/home/private",
  (x:any)=>x.details[0].value.recent[0].at=at+1,(x:any)=>x.details[0].value.recent[0].at=-1,
  (x:any)=>x.details[0].value.recent[0].status="success",(x:any)=>x.details[0].value.recent[0].output="private",
  (x:any)=>x.details[0].value.recent[0].preview={text:"Bearer secret",state:"reported"},
  (x:any)=>x.details[0].value.recent[0].preview={text:"git status; cat /private",state:"reported"},
  (x:any)=>x.details[0].value.recent[0].preview={text:"a".repeat(385),state:"reported"},
  (x:any)=>x.details[0].value.recent[0].preview={text:"go\u202e test",state:"reported"},
  (x:any)=>x.details[0].value.recent.push(...Array(3).fill(x.details[0].value.recent[0]))
 ]){const forged=structuredClone(rich);mutate(forged);assert.throws(()=>validateRich(forged,ids,at));}
 const extraOld=structuredClone(old);extraOld.details[0].value.provider=null;assert.throws(()=>validateRich(extraOld,ids,at));
 const identityExtra=structuredClone(identity);(identityExtra.details[0]!.value as any).recent=[];assert.throws(()=>validateRich(identityExtra,ids,at));
});
