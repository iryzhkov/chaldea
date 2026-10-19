import test from "node:test";
import { once } from "node:events";
import { generateKeyPairSync } from "node:crypto";
import { CompactSign } from "jose";
import { project, event } from "./helpers.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { hash, type Envelope } from "../../src/akasha/schema.ts";
import { emptyCache,writeCache,CacheModel } from "../../src/mission-control/cache.ts";
import { refreshStatus, type ReaderConfig } from "../../src/mission-control/reader.ts";
import { missionServer } from "../../src/mission-control/server.ts";
import { request } from "node:http";
import { join } from "node:path";
async function hostedRig(host="agent-a"){
  const identity={issuer:"chaldea:"+host,source:host+".mission-control",host,source_id:host+"--mission-control",profile:"mission-control-publisher",project:"chaldea"};
  const x=await rig("service",host),key=generateKeyPairSync("ed25519");
  const publisher={issuer:identity.issuer,source:identity.source,host:identity.host,source_id:identity.source_id,profile:identity.profile,project:identity.project,mode:"service" as const,kinds:["agent_status" as const]};
  const reader={issuer:"chaldea:omarchy-normandy",source:"mission-control-reader",host:"omarchy-normandy",source_id:"omarchy-normandy--mission-control-reader",profile:"mission-control-reader",project:"chaldea",mode:"service" as const,kinds:["agent_status" as const],mission_control_read_sources:[identity.source_id]};
  const bundle=structuredClone(x.bundle);bundle.sequence++;
  bundle.keys[0]!.ceilings=[{audience:"akasha",profile:publisher.profile,project:publisher.project,source:publisher.source,grants:[{resource:publisher.source,actions:["append","read"]}]}];
  // Disposable key only. Append ceiling proves the server selector independently denies writes.
  bundle.keys.push({issuer:reader.issuer,kid:"reader",public_key:{kty:"OKP",crv:"Ed25519",x:key.publicKey.export({format:"jwk"}).x!},not_before:N-3600,issue_until:N+3600,verify_until:N+4410,
    ceilings:[{audience:"akasha",profile:reader.profile,project:reader.project,source:reader.source,grants:[{resource:reader.source,actions:["read","append"]}]}]});
  await x.install(bundle);
  const auth=new Authorization([publisher,reader],x.trust,x.clock);
  const ingress=new Ingress(auth,x.store,()=>queueMicrotask(()=>project(x.store,x.clock.check())));
  const server=httpServer(ingress);server.listen(0,"127.0.0.1");await once(server,"listening");
  const base="http://127.0.0.1:"+(server.address()as{port:number}).port;
  const appendToken=await x.token({iss:publisher.issuer,host:publisher.host,sub:publisher.profile,project:publisher.project,source:publisher.source,grants:[{resource:publisher.source,actions:["append"]}]});
  const readerToken=async(overrides:Record<string,unknown>={})=>new CompactSign(Buffer.from(JSON.stringify({v:1,iss:reader.issuer,sub:reader.profile,project:reader.project,source:reader.source,host:reader.host,aud:"akasha",run_id:"fixture",iat:N,nbf:N,exp:N+300,jti:"abcdefghijklmnopqrstuv",grants:[{resource:reader.source,actions:["read"]}],...overrides}))).setProtectedHeader({alg:"EdDSA",typ:"chaldea-run+jwt",kid:"reader"}).sign(key.privateKey);
  const readToken=await readerToken();
  const post=(p:unknown,key="status-1",token=appendToken)=>fetch(base+"/api/v1/events",{method:"POST",headers:{authorization:"Bearer "+token,"content-type":"application/json","idempotency-key":key},body:JSON.stringify(p)});
  const window="?from="+new Date((N-3600)*1000).toISOString()+"&to="+new Date(N*1000).toISOString();
  const get=(path="/api/v1/events"+window,token=readToken)=>fetch(base+path,{headers:{authorization:"Bearer "+token}});
  const config:ReaderConfig={url:"https://akasha.fixture",tokenHelper:"/unused",source:"mission-control-reader",host:"omarchy-normandy",profile:"mission-control-reader",project:"chaldea",allowedSourceIds:[publisher.source_id],cacheFile:join(x.dir.path,"cache.json"),refreshMs:5000};
  const readerFetch:typeof fetch=async(input,init)=>{const url=new URL(String(input));assert.equal(url.origin,"https://akasha.fixture");return fetch(base+url.pathname+url.search,init);};
  return {x,auth,publisher,reader,config,readerFetch,readerToken,readToken,post,get,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));x.close();}};
}

test("R1 complete authenticated refresh clears transient gaps but preserves current epoch/reset/clipping and token evidence",async()=>{
  const h=await hostedRig();
  try{
    const p=payload();p.data.snapshot.tokens={qualified:true,output:100,rate:1,observedAt:N*1000,coverage:"observed"} as any;
    assert.equal((await h.post(p)).status,201);
    const deps={token:async()=>h.readToken,fetch:h.readerFetch,now:()=>h.x.sample.unixSeconds*1000};
    const good=await refreshStatus(h.config,emptyCache(),deps);
    const failed=await refreshStatus(h.config,good,{...deps,fetch:async()=>{throw new Error("temporary outage");}});assert.equal(failed.gap,true);
    const recovered=await refreshStatus(h.config,failed,deps);assert.equal(recovered.gap,false);assert.equal(recovered.snapshots[0]!.observedAt,N*1000);
    writeCache(h.config.cacheFile,recovered);assert.equal(new CacheModel(h.config.cacheFile,()=>N*1000).snapshot().tokens.coverage,"observed");
    let reset=true;const resetCache=await refreshStatus(h.config,recovered,{...deps,fetch:async(u,i)=>{if(reset){reset=false;return new Response("",{status:410});}return h.readerFetch(u,i);}});assert.equal(resetCache.gap,true);
    assert.equal((await refreshStatus(h.config,resetCache,deps)).gap,false);
    h.x.sample={...h.x.sample,unixSeconds:N+31,monotonicSeconds:131};
    const changed=payload();changed.data.snapshot=sample(2,(N+31)*1000);changed.data.snapshot.epoch="b".repeat(32);
    assert.equal((await h.post(changed,"new-epoch")).status,201);
    const epochGap=await refreshStatus(h.config,recovered,deps);assert.equal(epochGap.gap,true);
    assert.equal((await refreshStatus(h.config,epochGap,deps)).gap,false);
    h.x.sample={...h.x.sample,unixSeconds:N+62,monotonicSeconds:162};
    const clipped=payload();clipped.data.snapshot=sample(3,(N+62)*1000);clipped.data.snapshot.epoch="b".repeat(32);clipped.data.snapshot.total=49;clipped.data.snapshot.truncated=true;
    assert.equal((await h.post(clipped,"clipped")).status,201);
    const incomplete=await refreshStatus(h.config,epochGap,deps);assert.equal(incomplete.gap,true);assert.equal(incomplete.snapshots[0]!.truncated,true);
    for(const coverage of ["unknown","partial"]as const){
      const prior=structuredClone(recovered);prior.gap=true;prior.snapshots[0]!.tokens=coverage==="unknown"?{qualified:true,output:null,rate:null,observedAt:null,coverage}:{qualified:true,output:100,rate:1,observedAt:N*1000,coverage};
      const result=await refreshStatus(h.config,prior,{...deps,now:()=>N*1000,fetch:async()=>new Response(JSON.stringify({events:[],next_cursor:null}))});
      assert.equal(result.gap,false);assert.equal(result.snapshots[0]!.tokens.coverage,coverage);
    }
  }finally{await h.close();}
});
test("real HTTP ingest/store/scoped reader/cache/web continue without a PC producer and deduplicate retry",async()=>{
  const h=await hostedRig();
  try{
    const posted=await h.post(payload());assert.equal(posted.status,201);const receipt=await posted.json()as{event_id:string;feed_id:number|null};assert.equal(receipt.feed_id,null);
    const retried=await h.post(payload());assert.equal(retried.status,201);assert.equal((await retried.json()as any).event_id,receipt.event_id);
    assert.equal(h.x.store.scalar("SELECT count(*) FROM events"),1);assert.equal(h.x.store.scalar("SELECT count(*) FROM feed_entries"),0);
    const first=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
    assert.equal(first.gap,false);assert.equal(first.snapshots[0]!.host,"agent-a");assert.equal(first.snapshots[0]!.tokens.output,null);
    h.x.sample={...h.x.sample,unixSeconds:N+35,monotonicSeconds:135};
    const update=payload();update.data.snapshot=sample(2,(N+35)*1000);update.data.snapshot.agents[0]!.state="waiting";
    assert.equal((await h.post(update,"status-2")).status,201);
    const second=await refreshStatus(h.config,first,{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>(N+35)*1000});
    assert.equal(second.snapshots.length,1);assert.equal(second.snapshots[0]!.sequence,2);assert.equal(second.snapshots[0]!.agents[0]!.state,"waiting");
    writeCache(h.config.cacheFile,second);let now=(N+35)*1000;const model=new CacheModel(h.config.cacheFile,()=>now);
    const web=missionServer(model);await web.listen(0);const port=(web.server.address()as{port:number}).port;
    try{
      const page=await fetch("http://127.0.0.1:"+port+"/api/snapshot");const dto=await page.json()as any;
      assert.equal(dto.agents[0].host,"agent-a");assert.equal(dto.agents[0].title,"Task");assert.equal(dto.quota.state,"unknown");assert.equal(dto.source.state,"cached");
      now+=91_000;assert.equal(model.snapshot().source.state,"stale");
      const failed=await refreshStatus(h.config,second,{token:async()=>{throw new Error("Akasha offline, no PC relay");},now:()=>now});
      assert.equal(failed.gap,true);assert.equal(failed.snapshots[0]!.observedAt,(N+35)*1000);
      writeCache(h.config.cacheFile,failed);model.reload();assert.equal(model.snapshot().source.state,"stale");
      assert.equal((await fetch("http://127.0.0.1:"+port+"/healthz")).status,200);
    }finally{await web.close();}
  }finally{await h.close();}
});
test("scoped HTTP denies append, raw endpoints, foreign scope, expired tokens, revocation and bad clock",async()=>{
  const h=await hostedRig();
  try{
    assert.equal((await h.post(payload())).status,201);
    for(const query of ["source=foreign","host=agent-b","kind=tool_call","project=foreign"]){const result=await(await h.get("/api/v1/events?from="+new Date((N-3600)*1000).toISOString()+"&to="+new Date(N*1000).toISOString()+"&"+query)).json()as any;assert.equal(result.events.length,0);}
    for(const path of ["/api/entries","/","/api/v1/health","/api/v1/receipts?kind=agent_status&key=status-1"])assert.equal((await h.get(path)).status,path.startsWith("/api/v1/receipts")?401:403);
    const append=await h.readerToken({grants:[{resource:"mission-control-reader",actions:["append"]}]});assert.equal((await h.post(payload(),"reader-append",append)).status,403);
    for(const change of [{host:"agent-b"},{sub:"fake"},{project:"foreign"},{source:"quota"},{exp:N-1,iat:N-301,nbf:N-301}]){
      assert.equal((await h.get(undefined,await h.readerToken(change))).status,401);
    }
    const p=await h.auth.authorize(h.readToken,"read");assert.equal(h.x.store.ownedReceipt((await(await h.post(payload())).json()as any).event_id,p.scope),undefined);
    h.x.sample={...h.x.sample,healthy:false};assert.equal((await h.get()).status,401);h.x.sample={...h.x.sample,healthy:true};
    await h.x.install({...h.x.bundle,sequence:3,keys:[]});assert.equal((await h.get()).status,401);
  }finally{await h.close();}
});

test("status admission compares millisecond sample time in the trusted clock's integer-second units",async()=>{
  const h=await hostedRig();
  try{
    const within=payload();within.data.snapshot=sample(1,N*1000+500);
    assert.equal((await h.post(within,"same-second")).status,201);
  }finally{await h.close();}
  const other=await hostedRig();
  try{
    const future=payload();future.data.snapshot=sample(1,N*1000+1000);
    assert.equal((await other.post(future,"future-second")).status,409);
  }finally{await other.close();}
});
test("status admission rate, one-hour payload TTL and24h receipts cannot resurrect old broker payload",async()=>{
  const h=await hostedRig();
  try{
    assert.equal((await h.post(payload())).status,201);
    const original=JSON.parse(String(h.x.store.db.prepare("SELECT envelope FROM events").get()!.envelope))as Envelope;
    const next=payload();next.data.snapshot=sample(2);assert.equal((await h.post(next,"too-fast")).status,429);
    const stale=payload();stale.data.snapshot=sample(2,(N-121)*1000);h.x.sample={...h.x.sample,unixSeconds:N+31,monotonicSeconds:131};assert.equal((await h.post(stale,"too-old")).status,409);
    assert.equal(h.x.store.scalar("SELECT expires FROM receipts")-N,86400);
    assert.equal(h.x.store.scalar("SELECT expiry FROM events")-N,3600);
    // SQL expiry hides status even before the ordinary bounded pruner runs.
    h.x.sample={...h.x.sample,unixSeconds:N+3601,monotonicSeconds:3701};
    const scope={issuer:h.reader.issuer,profile:h.reader.profile,project:h.reader.project,source:h.reader.source,host:h.reader.host,global:false,missionControlSources:[identity.source_id]};
    const {eventPage}=await import("../../src/akasha/compat.ts");const q=new URLSearchParams({from:new Date(N*1000).toISOString(),to:new Date((N+3600)*1000).toISOString()});
    assert.equal([...eventPage(h.x.store,q,scope,N+3601).rows].length,0);
    h.x.store.prune(N+3601);assert.equal(h.x.store.scalar("SELECT count(*) FROM events"),0);assert.equal(h.x.store.receipt(original.event_id)!.state,"tombstone");
    h.x.store.prune(N+86401);assert.equal(h.x.store.receipt(original.event_id),undefined);
    h.x.store.project(original,h.x.store.cursor("nats")+1,N+7*86400);assert.equal(h.x.store.scalar("SELECT count(*) FROM events"),0);
    assert.equal(h.x.store.receipt(original.event_id),undefined);
    const forged={...original,source_id:"agent-b--mission-control"};assert.throws(()=>validateEnvelope(forged));
    const raw=sample();(raw as any).prompt="secret";assert.throws(()=>normalize({...payload(),data:{snapshot:raw}},identity,false));
  }finally{await h.close();}
});

test("real scoped event cursors bind the exact query and reset with410 after retention floor changes",async()=>{
  const h=await hostedRig();
  try{
    assert.equal((await h.post(payload())).status,201);
    h.x.sample={...h.x.sample,unixSeconds:N+31,monotonicSeconds:131};
    const second=payload();second.data.snapshot=sample(2,(N+31)*1000);assert.equal((await h.post(second,"second")).status,201);
    const path="/api/v1/events?from="+new Date((N-3600+31)*1000).toISOString()+"&to="+new Date((N+31)*1000).toISOString()+"&limit=1";
    const first=await(await h.get(path)).json()as any;assert.equal(first.events.length,1);assert.equal(typeof first.next_cursor,"string");
    const cursor="&cursor="+encodeURIComponent(first.next_cursor);
    assert.equal((await h.get(path+cursor)).status,200);
    assert.equal((await h.get(path+cursor+"&host=agent-a")).status,400);
    h.x.store.put("floor","999999");assert.equal((await h.get(path+cursor)).status,410);
    assert.equal((await h.get("/api/v1/events?from="+new Date((N-7200)*1000).toISOString()+"&to="+new Date(N*1000).toISOString())).status,403);
    const forgedScope={issuer:"chaldea:agent-b",profile:"mission-control-reader",source:"mission-control-reader",host:"omarchy-normandy",project:"chaldea",global:false,missionControlSources:[identity.source_id]};
    assert.throws(()=>scopeSql(forgedScope));
  }finally{await h.close();}
});
test("status pressure refuses admission without evicting unrelated protected events",async()=>{
  const h=await hostedRig();
  try{
    const ordinary=event(500);h.x.store.admit(ordinary,hash("ordinary"),N);project(h.x.store);
    const before=h.x.store.scalar("SELECT count(*) FROM events");
    const original=h.x.store.capacity.bind(h.x.store);
    h.x.store.capacity=()=>{throw new Error("protected_state_capacity");};
    assert.equal((await h.post(payload())).status,503);assert.equal(h.x.store.scalar("SELECT count(*) FROM events"),before);
    h.x.store.capacity=original;
    const stored=h.x.store.db.prepare("SELECT envelope FROM events").get()!;
    assert.equal(JSON.parse(String(stored.envelope)).event_id,ordinary.event_id);
  }finally{await h.close();}
});

import assert from "node:assert/strict";
import { normalize, validateEnvelope } from "../../src/akasha/schema.ts";
import { Authorization } from "../../src/akasha/auth.ts";
import { scopeSql } from "../../src/akasha/store.ts";
import { rig, N } from "./helpers.ts";
const sample = (sequence=1, observedAt=N*1000) => ({
  schema:"mission-control.host.v1",host:"agent-a",epoch:"a".repeat(32),sequence,observedAt,connected:true,
  total:1,truncated:false,agents:[{id:"b".repeat(16),model:"gpt-6.1-sol",state:"working",startedAt:observedAt-1000,observedAt,detailObservedAt:observedAt,connected:true,steps:["read"]}],
  tokens:{qualified:false,output:null,rate:null,observedAt:null,coverage:"unknown"}
});
const identity={issuer:"chaldea:agent-a",profile:"mission-control-publisher",project:"chaldea",source:"agent-a.mission-control",host:"agent-a",run_id:"fixture",source_id:"agent-a--mission-control"};
const payload=()=>({v:1,kind:"agent_status",title:"Mission control status",data:{snapshot:sample()}});

for(const host of ["agent-a","agent-b","omarchy-pc","omarchy-macbook-air-igor"])test("authenticated status roundtrip preserves canonical host "+host,async()=>{
  const h=await hostedRig(host);
  try{
    const p=payload();p.data.snapshot.host=host;
    assert.equal((await h.post(p)).status,201);
    const cache=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
    assert.equal(cache.gap,false);assert.equal(cache.snapshots[0]!.host,host);
    const wrong=payload();wrong.data.snapshot.host=host==="agent-a"?"agent-b":"agent-a";
    assert.equal((await h.post(wrong,"mismatch")).status,403);
    const laptop=payload();laptop.data.snapshot.host="laptop";assert.equal((await h.post(laptop,"unissued-laptop")).status,400);
    assert.throws(()=>new Authorization([{...h.publisher,issuer:"chaldea:laptop"}],h.x.trust,h.x.clock),/registry_host_mismatch/);
    assert.throws(()=>new Authorization([{...h.publisher,host:"laptop",issuer:"chaldea:laptop",source:"laptop.mission-control",source_id:"laptop--mission-control"}],h.x.trust,h.x.clock),/invalid_mission_control_publisher/);
    assert.throws(()=>scopeSql({...h.reader,global:false,missionControlSources:["laptop--mission-control"]}),/invalid_mission_control_scope/);
  }finally{await h.close();}
});

test("strict hosted form accepts bounded metadata and rejects all extra prose/identity fields",()=>{
  assert.equal(normalize(payload(),identity,false).kind,"agent_status");
  for (const mutate of [
    (v:any)=>v.body="a private command", (v:any)=>v.title="secret task",
    (v:any)=>v.data.snapshot.agents[0].title="private", (v:any)=>v.data.thread_id="secret",
    (v:any)=>v.data.snapshot.host="agent-b", (v:any)=>v.data.snapshot.schema="mission-control.host.v2",
    (v:any)=>v.data.snapshot.agents[0].model="/home/igor/private", (v:any)=>v.data.snapshot.agents[0].steps=["secret"],
    (v:any)=>v.data.snapshot.tokens.output=10, (v:any)=>v.data.snapshot.agents.push(...Array(48).fill(v.data.snapshot.agents[0])),
    (v:any)=>v.data.snapshot.total=0, (v:any)=>v.data.snapshot.observedAt=-1
  ]) {const p=payload();mutate(p);assert.throws(()=>normalize(p,identity,false));}
});
test("reader selector validates coherent registry and produces only approved snapshot SQL",async()=>{
  const x=await rig("service");
  try {
    const {run_id:_run,...registrationIdentity}=identity;
    const publisher={...registrationIdentity,mode:"service" as const,kinds:["agent_status" as const]};
    const reader={issuer:"chaldea:omarchy-normandy",profile:"mission-control-reader",project:"chaldea",source:"mission-control-reader",host:"omarchy-normandy",source_id:"omarchy-normandy--mission-control-reader",mode:"service" as const,kinds:["agent_status" as const],mission_control_read_sources:["agent-a--mission-control"]};
    assert.doesNotThrow(()=>new Authorization([publisher,reader] as any,x.trust,x.clock));
    for(const change of [{profile:"other"},{project:"other"},{mode:"operator"},{kinds:["feed_post"]},{mission_control_read_sources:[]},{mission_control_read_sources:["missing"]},{mission_control_read_sources:Array(5).fill("agent-a--mission-control")}])
      assert.throws(()=>new Authorization([publisher,{...reader,...change}] as any,x.trust,x.clock));
    const q=scopeSql({...reader,global:false,missionControlSources:reader.mission_control_read_sources} as any);
    assert.match(q.sql,/source_id/);assert.match(q.sql,/snapshot/);assert.ok(q.params.includes("agent_status"));
  } finally{x.close();}
});
