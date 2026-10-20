import test from "node:test";
import { once } from "node:events";
import { createHash,generateKeyPairSync } from "node:crypto";
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
import { OPERATIONS_PAIRS } from "../../src/akasha/store.ts";
import { refreshOperations } from "../../src/mission-control/reader.ts";
async function hostedRig(host="agent-a",operations=false){
  const identity={issuer:"chaldea:"+host,source:host+".mission-control",host,source_id:host+"--mission-control",profile:"mission-control-publisher",project:"chaldea"};
  const x=await rig("service",host),key=generateKeyPairSync("ed25519");
  const publisher={issuer:identity.issuer,source:identity.source,host:identity.host,source_id:identity.source_id,profile:identity.profile,project:identity.project,mode:"service" as const,kinds:["agent_status" as const]};
  const reader={issuer:"chaldea:omarchy-normandy",source:"mission-control-reader",host:"omarchy-normandy",source_id:"omarchy-normandy--mission-control-reader",profile:"mission-control-reader",project:"chaldea",mode:"service" as const,kinds:["agent_status" as const],mission_control_read_sources:[identity.source_id]};
  const bundle=structuredClone(x.bundle);bundle.sequence++;
  bundle.keys[0]!.ceilings=[{audience:"akasha",profile:publisher.profile,project:publisher.project,source:publisher.source,grants:[{resource:publisher.source,actions:["append","read"]}]}];
  // Disposable key only. Append ceiling proves the server selector independently denies writes.
  bundle.keys.push({issuer:reader.issuer,kid:"reader",public_key:{kty:"OKP",crv:"Ed25519",x:key.publicKey.export({format:"jwk"}).x!},not_before:N-3600,issue_until:N+3600,verify_until:N+4410,
    ceilings:[{audience:"akasha",profile:reader.profile,project:reader.project,source:reader.source,grants:[{resource:reader.source,actions:["read","append"]}]}]});
  const producers=OPERATIONS_PAIRS.map(({kind,...p})=>({...p,mode:"service" as const,kinds:[kind as "job_finished"|"report"]}));
  if(operations){
    Object.assign(reader,{mission_control_operations_read:true,kinds:["agent_status","job_finished","report"]});
    for(const p of producers.filter(p=>p.host===host))bundle.keys[0]!.ceilings.push({audience:"akasha",profile:p.profile,project:p.project,source:p.source,grants:[{resource:p.source,actions:["append"]}]});
  }
  await x.install(bundle);
  const auth=new Authorization([publisher,reader,...(operations?producers:[])],x.trust,x.clock);
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
  return {base,x,auth,publisher,reader,config,readerFetch,readerToken,readToken,post,get,async close(){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));x.close();}};
}


test("operations authenticated projection binds five complete tuples and keeps status-only clients compatible",async()=>{
 const h=await hostedRig("agent-a",true),path="/api/v1/events?mission_control_operations=job_finished&window=48h&limit=16";
 try{
  for(const change of [{mission_control_operations_read:false},{global_read:true},{kinds:["agent_status","job_finished","tool_call"]},{mission_control_read_sources:Array(5).fill("agent-a--mission-control")}]){
   const registry=h.auth.registry.map(r=>r.profile==="mission-control-reader"?{...r,...change}:r);
   assert.throws(()=>new Authorization(registry as any,h.x.trust,h.x.clock));
  }
  assert.throws(()=>new Authorization(h.auth.registry.filter(r=>r.source_id!=="agent-a-daily-health") as any,h.x.trust,h.x.clock),/missing_operations_pair/);
  const append=async(kind:"job_finished"|"report",data:unknown,key:string)=>{
   const p=OPERATIONS_PAIRS.find(p=>p.host==="agent-a"&&p.kind===kind)!;
   const token=await h.x.token({source:p.source,host:p.host,sub:p.profile,project:p.project,grants:[{resource:p.source,actions:["append"]}]});
   return h.post({v:1,kind,title:"PRIVATE event title",body:"PRIVATE body /home/igor/private",severity:"info",occurred_at:new Date((N-20)*1000).toISOString(),data},key,token);
  };
  assert.equal((await append("job_finished",{job_id:"chaldea-fleet-pull",invocation_id:"PRIVATE invocation",status:"changed"},"job")).status,201);
  assert.equal((await append("report",{status:"ok",checks:Array.from({length:20},(_,i)=>({name:"check "+i,status:"ok"}))},"report")).status,201);
  assert.equal((await h.post(payload(),"ordinary-status")).status,201);
  const raw=await(await h.get(path)).json() as any;
  assert.equal(raw.events.rows.length,1);assert.equal(raw.events.rows[0].occurredAt,(N-20)*1000);assert.equal(raw.events.checkedAt,N*1000);
  assert.doesNotMatch(JSON.stringify(raw),/PRIVATE|body|title|invocation|source_id|run_id/);
  const page=await(await h.get(path.replace("job_finished","report"))).json() as any;
  assert.equal(page.ops.dailyHealth.report.checks.length,16);assert.equal(page.ops.dailyHealth.report.omitted,4);
  assert.equal((await h.get()).status,200);
  for(const extra of ["&cursor=abc","&from=1h","&host=agent-a","&kind=report","&project=homelab","&source=agent-a.fleet","&window=48h"]){
   assert.equal((await h.get(path+extra)).status,403);
  }
  for(const query of [path.replace("limit=16","limit=17"),path.replace("window=48h","window=1h"),path.replace("job_finished","tool_call")])assert.equal((await h.get(query)).status,403);
  assert.equal((await h.get("/api/entries")).status,403);
  const good=await refreshOperations(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
  assert.equal(good.events.state,"cached");assert.equal(good.ops.dailyHealth.report!.status,"ok");
  const cache={...emptyCache(),operations:good};
  const failed=await refreshOperations(h.config,cache,{token:async()=>{throw new Error("grant_not_installed");},now:()=>N*1000});
  assert.equal(failed.events.state,"error");assert.equal(failed.events.checkedAt,N*1000);assert.equal(failed.events.rows[0]!.occurredAt,(N-20)*1000);
  writeCache(h.config.cacheFile,{...cache,operations:failed});
  const dto=new CacheModel(h.config.cacheFile,()=>(N+60)*1000).snapshot();
  assert.equal(dto.events!.rows[0]!.occurredAt,(N-20)*1000);
  assert.equal((await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000})).snapshots.length,1);
  // Simulate a compromised broker/store with mismatched complete tuples. None may be read.
  const base=JSON.parse(String(h.x.store.db.prepare("SELECT envelope FROM events WHERE kind='job_finished'").get()!.envelope));
  for(const patch of [{project:"homelab"},{profile:"daily-health"},{source:"chaldea.daily-health.agent-a"},{issuer:"chaldea:agent-b"},{source_id:"agent-a-daily-health"}]){
   const e={...base,...patch,event_id:hash(patch)};h.x.store.admit(e,hash(e),N);project(h.x.store);
   assert.throws(()=>h.auth.validateDelivery(e));
  }
  const bound=await(await h.get(path)).json()as any;assert.equal(bound.events.rows.length,1);
  for(const p of OPERATIONS_PAIRS.filter(p=>p.kind==="job_finished"))for(let i=0;i<18;i++){
   const e={...base,...p,event_id:hash([p.source_id,i]),occurred_at:new Date((N-100-i)*1000).toISOString()};h.x.store.admit(e,hash(e),N);project(h.x.store);
  }
  const bounded=await(await h.get(path)).json()as any;
  assert.equal(bounded.events.rows.length,64);assert.equal(bounded.events.truncated,true);
  for(const host of ["agent-a","agent-b","omarchy-pc","omarchy-macbook-air-igor"])assert.equal(bounded.events.rows.filter((r:any)=>r.host===host).length,16);
  assert.ok(Buffer.byteLength(JSON.stringify(bounded))<64*1024);
  // Report names/statuses are validated before public response, including omitted checks.
  assert.equal((await append("report",{status:"ok",checks:[{name:"bad\ncheck",status:"ok"}]},"unsafe-report")).status,201);
  assert.equal((await h.get(path.replace("job_finished","report"))).status,400);
 }finally{await h.close();}
 const legacy=await hostedRig();try{assert.equal((await legacy.get(path)).status,403);assert.equal((await legacy.get()).status,200);}finally{await legacy.close();}
});
test("quota compact account data crosses authenticated ingest with canonical body and age unchanged",async()=>{
 const h=await hostedRig();
 try{
  const p:any=payload();p.data.snapshot.quota={state:"cached",observedAt:(N-100)*1000,omitted:0,accounts:[["codex","fresh",(N-100)*1000,0,null,300,"0","fresh","unsupported",true,0,(N-101)*1000,null]]};
  assert.equal((await h.post(p)).status,201);
  const cache=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});assert.deepEqual(cache.snapshots[0]!.quota,p.data.snapshot.quota);
  writeCache(h.config.cacheFile,cache);const q=new CacheModel(h.config.cacheFile,()=>N*1000).snapshot().quota.hosts![0]!;
  assert.equal(q.accounts[0]!.used,0);assert.equal(q.observedAt,(N-100)*1000);assert.equal(q.accounts[0]!.ageSeconds,100);
  const stored=JSON.parse(String(h.x.store.db.prepare("SELECT envelope FROM events").get()!.envelope));
  assert.deepEqual(stored.data.snapshot,p.data.snapshot);
  const bad=structuredClone(p);bad.data.snapshot.quota.accounts[0].push("PRIVATE");assert.equal((await h.post(bad,"quota-private")).status,400);
 }finally{await h.close();}
});

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
    const originalEnvelope=JSON.parse(String(h.x.store.db.prepare("SELECT envelope FROM events").get()!.envelope));
    const originalTime=first.snapshots[0]!.observedAt;
    const replay=await refreshStatus(h.config,first,{token:async()=>h.readToken,now:()=>N*1000,fetch:async()=>new Response(JSON.stringify({events:[originalEnvelope],next_cursor:null}))});
    assert.equal(replay.snapshots[0]!.sequence,1);assert.equal(replay.snapshots[0]!.observedAt,originalTime);
    const badIdentity={...originalEnvelope,host:"agent-b"};
    const rejected=await refreshStatus(h.config,first,{token:async()=>h.readToken,now:()=>N*1000,fetch:async()=>new Response(JSON.stringify({events:[badIdentity],next_cursor:null}))});
    assert.equal(rejected.gap,true);assert.equal(rejected.snapshots[0]!.observedAt,originalTime);
    const offline=await refreshStatus(h.config,first,{token:async()=>h.readToken,now:()=>(N+301)*1000,fetch:async u=>{
      assert.equal(new URL(String(u)).searchParams.get("from"),new Date((N+181)*1000).toISOString());
      return new Response(JSON.stringify({events:[],next_cursor:null}));
    }});
    assert.equal(offline.snapshots[0]!.observedAt,originalTime);
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

test("backend five-second gate rejects early samples and admits the exact boundary",async()=>{
  const h=await hostedRig();
  try{
    assert.equal((await h.post(payload())).status,201);
    h.x.sample={...h.x.sample,unixSeconds:N+4,monotonicSeconds:104};
    const next=payload();next.data.snapshot=sample(2,(N+4)*1000);
    assert.equal((await h.post(next,"early-four")).status,429);
    h.x.sample={...h.x.sample,unixSeconds:N+5,monotonicSeconds:105};
    next.data.snapshot=sample(3,(N+5)*1000);
    assert.equal((await h.post(next,"exact-five")).status,201);
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

test("rich v2 fields cross authenticated H store and restricted reader to API/SSE; legacy v1 remains valid",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts");
 const h=await hostedRig();
 try{
  const p:any=payload(),d=emptyDetail();delete d.provider;delete d.recent;
  d.identity={title:{text:"Useful actual title",state:"reported"},appThreadId:{text:"mcp:actual-app-thread",state:"reported"}};
  d.assistant={text:"A public assistant paragraph.",state:"reported"};d.effort={value:"high",source:"configured"};
  d.commands=[{text:"go test -race ./...",state:"reported"}];
  const opaque=createHash("sha256").update(p.data.snapshot.epoch+"\0"+d.identity.appThreadId.text).digest("hex").slice(0,16);p.data.snapshot.agents[0].id=opaque;
  p.data.snapshot.rich={v:2,resources:{state:"reported",sample:{sampledAt:N*1000,cpuUtilization:0.4,cpuCount:12,availableMemoryBytes:200,totalMemoryBytes:800}},details:[{id:opaque,value:d}],omitted:0};
  assert.equal((await h.post(p)).status,201);
  const cache=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
  assert.deepEqual(cache.snapshots[0]!.rich,p.data.snapshot.rich);writeCache(h.config.cacheFile,cache);
  const web=missionServer(new CacheModel(h.config.cacheFile,()=>N*1000));await web.listen(0);
  try{
   const port=(web.server.address()as{port:number}).port;
   const response=await fetch("http://127.0.0.1:"+port+"/api/snapshot"),body:any=await response.json();
   assert.equal(body.agents[0].title,"Useful actual title");
   assert.equal(body.agents[0].details.identity.appThreadId.text,"mcp:actual-app-thread");
   const stream=await fetch("http://127.0.0.1:"+port+"/api/events"),reader=stream.body!.getReader();
   let bytes="";for(let i=0;i<4&&!bytes.includes("Useful actual title");i++){const next=await reader.read();bytes+=new TextDecoder().decode(next.value);}
   assert.match(bytes,/Useful actual title/);await reader.cancel();
  }finally{await web.close();}
  const malformed=structuredClone(p);malformed.data.snapshot.rich.details[0].value.identity.providerConversationId="forbidden";
  assert.equal((await h.post(malformed,"extra-id")).status,400);
  const wrong=structuredClone(p);wrong.data.snapshot.host="agent-b";assert.equal((await h.post(wrong,"wrong-host")).status,403);
  assert.equal(normalize(payload(),identity,false).kind,"agent_status");
 }finally{await h.close();}
});


test("rich v3 provider and actual recent items cross authenticated ingest/store/restricted reader/API",async()=>{
 const {emptyDetail}=await import("../../src/mission-control/details.ts");
 const h=await hostedRig();
 try{
  const p:any=payload(),d=emptyDetail();
  d.identity={title:{text:"Current thread",state:"reported"},appThreadId:{text:"mcp:actual-app-thread",state:"reported"}};
  d.provider={instanceId:"custom-work",driver:"opencode"};
  d.recent=[{kind:"command",preview:{text:"go test",state:"reported"},at:null,status:"unknown"},{kind:"assistant",preview:{text:"Last actual paragraph.",state:"reported"},at:N*1000,status:"completed"}];
  const opaque=createHash("sha256").update(p.data.snapshot.epoch+"\0"+d.identity.appThreadId.text).digest("hex").slice(0,16);p.data.snapshot.agents[0].id=opaque;
  p.data.snapshot.rich={v:3,resources:{state:"unavailable",sample:null},details:[{id:opaque,value:d}],omitted:0};
  assert.equal((await h.post(p)).status,201);
  const cache=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
  assert.deepEqual(cache.snapshots[0]!.rich,p.data.snapshot.rich);writeCache(h.config.cacheFile,cache);
  const model=new CacheModel(h.config.cacheFile,()=>N*1000),web=missionServer(model);await web.listen(0);
  try{
   const port=(web.server.address()as{port:number}).port;
   const body:any=await(await fetch("http://127.0.0.1:"+port+"/api/snapshot")).json();
   assert.deepEqual(body.agents[0].details.provider,d.provider);assert.deepEqual(body.agents[0].details.recent,d.recent);
  }finally{await web.close();}
  for(const mutate of [
   (x:any)=>x.data.snapshot.rich.details[0].value.provider.auth="PRIVATE",
   (x:any)=>x.data.snapshot.rich.details[0].value.recent[0].output="PRIVATE",
   (x:any)=>x.data.snapshot.rich.details[0].value.identity.appThreadId.text="mcp:forged-app-thread",
   (x:any)=>x.data.snapshot.rich.v=2
  ]){const forged=structuredClone(p);mutate(forged);assert.equal((await h.post(forged,"forged-"+Math.random())).status,400);}
  const wrong=structuredClone(p);wrong.data.snapshot.host="agent-b";assert.equal((await h.post(wrong,"wrong-v3-host")).status,403);
  h.x.sample={...h.x.sample,unixSeconds:N+31,monotonicSeconds:131};
  const identityOnly=structuredClone(p);identityOnly.data.snapshot.sequence=2;identityOnly.data.snapshot.observedAt=(N+31)*1000;
  identityOnly.data.snapshot.rich.details[0].value={identity:d.identity,fieldCoverage:"identity-only"};
  assert.equal((await h.post(identityOnly,"identity-v3")).status,201);
  const next=await refreshStatus(h.config,cache,{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>(N+31)*1000});
  assert.equal(next.snapshots[0]!.rich!.details[0]!.value.fieldCoverage,"identity-only");
 }finally{await h.close();}
});

test("sparse v4 nine-thread capture survives authenticated ingest store restricted reader and public cache",async()=>{
 const {MissionModel}=await import("../../src/mission-control/model.ts");
 const {captureSnapshot}=await import("../../src/mission-control/contract.ts");
 const h=await hostedRig();
 try{
  const m=new MissionModel(false,()=>N*1000);
  const threads=Array.from({length:9},(_,i)=>({id:"mcp:synthetic-auth-"+i,title:"Synthetic authenticated task "+i,status:"running",providerInstanceId:"codex",modelSelection:{instanceId:"codex",model:"gpt-6.1-sol",options:[{id:"reasoningEffort",value:"high"}]},latestRunId:"synthetic-run",activeRunId:"synthetic-run",latestRunStartedAt:new Date((N-1)*1000).toISOString(),latestRunCompletedAt:null,lastErrorClass:null,usageLimitResetAt:null,limitRecovery:null,relationshipToParent:null,archived:false,deleted:false}));
  m.shell({kind:"snapshot",sequence:1,threads});m.shell({kind:"synchronized"});
  for(const t of threads){m.detail(t.id,{kind:"synchronized"});m.detail(t.id,{kind:"assistant",text:"Synthetic actual activity "+t.id,at:N*1000});m.detail(t.id,{kind:"recent-item",id:"synthetic-item",ordinal:1,type:"assistant",text:"Synthetic actual activity "+t.id,at:N*1000,status:"completed"});}
  const snapshot=captureSnapshot(m,"agent-a","a".repeat(32),1)!;
  const p:any=payload();p.data.snapshot=snapshot;
  assert.equal(snapshot.rich!.v,4);assert.ok(Buffer.byteLength(JSON.stringify(snapshot))<=8192);
  assert.equal((await h.post(p)).status,201);
  const stored=JSON.parse(String(h.x.store.db.prepare("SELECT envelope FROM events").get()!.envelope));
  assert.deepEqual(stored.data.snapshot,snapshot);
  const cache=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
  assert.deepEqual(cache.snapshots[0],snapshot);writeCache(h.config.cacheFile,cache);
  const dto=new CacheModel(h.config.cacheFile,()=>N*1000).snapshot();
  assert.equal(dto.agents.length,9);assert.equal(dto.agents.filter(a=>a.details.recent?.some(r=>r.preview.text)).length,9);
  assert.ok(Buffer.byteLength(JSON.stringify(dto))<=128*1024);
  assert.ok(dto.agents.every(a=>a.details.effort.source==="configured"&&a.details.usage.output===null));
  for(const mutate of [
   (x:any)=>x.data.snapshot.rich.details[0].value.identity.appThreadId.text="mcp:forged",
   (x:any)=>x.data.snapshot.rich.details[0].value.identity.title.private="forbidden",
   (x:any)=>x.data.snapshot.rich.details[0].value.recent[0].preview.text="Bearer credential"
  ]){const bad=structuredClone(p);mutate(bad);assert.equal((await h.post(bad,"v4-negative-"+Math.random())).status,400);}
  const wrong=structuredClone(p);wrong.data.snapshot.host="agent-b";assert.equal((await h.post(wrong,"wrong-v4-host")).status,403);
  const append=await h.readerToken({grants:[{resource:"mission-control-reader",actions:["append"]}]});
  assert.equal((await h.post(p,"v4-reader-append",append)).status,403);
 }finally{await h.close();}
});

test("v5 actual completion capture crosses authenticated ingest store restricted reader and public cache expiry",async()=>{
 const {MissionModel}=await import("../../src/mission-control/model.ts");
 const {captureSnapshot}=await import("../../src/mission-control/contract.ts");
 const {projectClientSnapshot}=await import("../../src/mission-control/static/client.js" as string);
 const h=await hostedRig(),completedAt=(N-10)*1000;
 try{
  const m=new MissionModel(false,()=>N*1000);
  m.shell({kind:"snapshot",sequence:1,threads:[{id:"mcp:synthetic-completed",title:"Synthetic completed task",status:"completed",providerInstanceId:"codex",modelSelection:{instanceId:"codex",model:"gpt-6.1-sol"},latestRunId:"synthetic-run",activeRunId:null,latestRunStartedAt:new Date(completedAt-1000).toISOString(),latestRunCompletedAt:new Date(completedAt).toISOString(),lastErrorClass:null,usageLimitResetAt:null,limitRecovery:null,relationshipToParent:null,archived:false,deleted:false}]});
  m.shell({kind:"synchronized"});
  const snapshot=captureSnapshot(m,"agent-a","a".repeat(32),1)!,p:any=payload();p.data.snapshot=snapshot;
  assert.equal(snapshot.rich!.v,5);assert.deepEqual(snapshot.rich!.completionTimes,[[snapshot.agents[0]!.id,completedAt]]);
  assert.equal((await h.post(p)).status,201);
  const stored=JSON.parse(String(h.x.store.db.prepare("SELECT envelope FROM events").get()!.envelope));
  assert.deepEqual(stored.data.snapshot,snapshot);
  const cache=await refreshStatus(h.config,emptyCache(),{token:async()=>h.readToken,fetch:h.readerFetch,now:()=>N*1000});
  assert.deepEqual(cache.snapshots[0],snapshot);writeCache(h.config.cacheFile,cache);
  const web=missionServer(new CacheModel(h.config.cacheFile,()=>N*1000));await web.listen(0);
  try{
   const port=(web.server.address()as{port:number}).port;
   const dto:any=await(await fetch("http://127.0.0.1:"+port+"/api/snapshot")).json();
   assert.equal(dto.agents[0].completedAt,completedAt);
   assert.equal(projectClientSnapshot(dto,completedAt+59_999,true).threadAgents.length,1);
   assert.equal(projectClientSnapshot(dto,completedAt+60_000,false).threadAgents.length,0);
   assert.equal(dto.agents.length,1);assert.equal(dto.hostSummary[0].shown,1);
  }finally{await web.close();}
  const invalid=structuredClone(p);invalid.data.snapshot.agents[0].state="working";
  assert.equal((await h.post(invalid,"v5-active-completion")).status,400);
 }finally{await h.close();}
});
