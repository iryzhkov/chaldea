import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import type { WaitSnapshot, WaitT3 } from "../../src/t3/waits.ts";
import { scratchDir } from "../helpers/scratch.ts";

const guard = {version:1 as const,projectId:"project",lastStopCommandId:null,invalidationCommandId:null};
const snapshot = (): WaitSnapshot => ({
  id:"parent",project:"project",archived:false,deleted:false,settled:false,
  runs:[],pendingRuns:[],children:[],...{externalWakeGuard:guard,settlementOrigin:null},
});
function fixture(initial=snapshot()){
  const dir=scratchDir("external-wake"),path=join(dir.path,"db");
  let parent:WaitSnapshot|null=initial,store=new WakeStore(path,"env");
  const payloads:string[]=[];
  let observed=Promise.withResolvers<void>();
  const port:WaitT3={
    async environment(){return "env";},async snapshot(){return parent;},
    async observe(_id,signal,on){await Promise.resolve();if(signal.aborted)return;on(parent,1);observed.resolve();if(!signal.aborted)await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
    async dispatch(payload){payloads.push(payload);},async respond(){return true;},
  };
  let engine=new WaitEngine(store,port);
  return {get store(){return store;},get engine(){return engine;},port,payloads,get observed(){return observed.promise;},
    parent(value:WaitSnapshot|null){parent=value;},
    async reopen(){await engine.stop();store.close();store=new WakeStore(path,"env");engine=new WaitEngine(store,port);observed=Promise.withResolvers<void>();},
    async close(){await engine.stop();store.close();dir.remove();}};
}
const input=(key:string,past=false)=>({threadId:"parent",requestId:Date.now()+":"+key,condition:{kind:"time",at:new Date(Date.now()+(past?-1:86_400_000)).toISOString()}});
test("normal pinned-run completion resolves through actual engine observation and delivers once",async()=>{
  const f=fixture(),done=Promise.withResolvers<void>(),observed=Promise.withResolvers<void>();
  let emit:((snapshot:WaitSnapshot|null,cursor:number)=>void)|undefined;
  const target:WaitSnapshot={...snapshot(),id:"target",runs:[{id:"run",ordinal:1,status:"running",
    started:new Date().toISOString(),workStarted:null,restartOf:null,failure:null,root:"root"}]};
  const read=f.port.snapshot.bind(f.port),observe=f.port.observe.bind(f.port),dispatch=f.port.dispatch.bind(f.port);
  f.port.snapshot=async(id)=>id==="target"?target:read(id);
  f.port.observe=async(id,signal,on)=>{
    if(id!=="target")return observe(id,signal,on);
    await Promise.resolve();if(signal.aborted)return;emit=on;on(target,1);observed.resolve();
    if(!signal.aborted)await new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
  };
  f.port.dispatch=async payload=>{await dispatch(payload);done.resolve();};
  try{
    const row=await f.engine.register("wait",{threadId:"parent",requestId:Date.now()+":completed",
      condition:{kind:"thread",threadId:"target"}});
    await observed.promise;assert.equal(f.store.get(row.id).state,"parked");
    emit!({...target,runs:[{...target.runs[0]!,status:"completed"}]},2);
    await done.promise;await f.engine.stop();
    assert.equal(f.store.get(row.id).target_run,"run");
    assert.equal(JSON.parse(f.store.get(row.id).outcome!).reason,"completed");
    assert.equal(f.payloads.length,1);
  }finally{await f.close();}
});
test("proven automatic settlement retains a registered wait and delivers guarded immutable bytes",async()=>{
  const f=fixture({...snapshot(),settled:true,...{settlementOrigin:"automatic"}});
  try{
    const row=await f.engine.register("wait",input("auto",true));
    await f.engine.stop();
    assert.equal(f.store.get(row.id).state,"resolved");
    assert.equal(f.payloads.length,1);
    assert.deepEqual(JSON.parse(f.payloads[0]!).externalWake,guard);
  }finally{await f.close();}
});
for(const transition of ["manual","unknown","archive","delete","stop"] as const)test("registered wait remains terminal after "+transition,async()=>{
  const f=fixture();
  try{
    const value=input(transition),row=await f.engine.register("wait",value);
    await f.reopen();
    const p=snapshot();
    if(transition==="archive")p.archived=true;
    else if(transition==="delete")p.deleted=true;
    else if(transition==="stop")p.externalWakeGuard={...guard,lastStopCommandId:"stop",invalidationCommandId:"stop"};
    else {p.settled=true;if(transition==="manual")p.settlementOrigin="manual";}
    f.parent(p);f.engine.start();await f.observed;await f.engine.stop();
    assert.equal(f.store.get(row.id).state,"orphaned");assert.equal(f.payloads.length,0);
    await f.reopen();f.parent(snapshot());f.engine.start();await f.engine.stop();
    assert.equal((await f.engine.register("wait",value)).id,row.id);
    assert.equal(f.store.get(row.id).state,"orphaned");assert.equal(f.payloads.length,0);
  }finally{await f.close();}
});
test("explicit wait cancellation and a legacy registration never acquire new wake authority",async()=>{
  const f=fixture();
  try{
    const value=input("cancel"),row=await f.engine.register("wait",value);f.engine.cancel(row.id);
    const legacy=f.store.register(f.store.prepare("wait",input("legacy")),"project",null);
    await f.reopen();f.engine.start();await f.observed;await f.engine.stop();
    assert.equal(f.store.get(row.id).state,"cancelled");
    assert.equal(f.store.get(legacy.id).state,"orphaned");assert.equal(f.payloads.length,0);
  }finally{await f.close();}
});
test("native and fallback decisions do not inherit automatic-settlement authority",async()=>{
  const f=fixture({...snapshot(),settled:true,settlementOrigin:"automatic"});
  try{
    await assert.rejects(f.engine.register("decision",{threadId:"parent",requestId:Date.now()+":decision",
      question:"Run?",options:["Defer","Run"],dependentAction:"work",defaultAction:"defer",
      deadline:new Date(Date.now()+60_000).toISOString()}),/settled/);
    await assert.rejects(f.engine.registerNative({threadId:"parent",requestId:Date.now()+":native",
      dependentAction:"work",defaultAction:"defer",deadline:new Date(Date.now()+60_000).toISOString()}),/settled/);
  }finally{await f.close();}
});
test("different captured lifecycle generations cannot merge into one combined wake",()=>{
  const dir=scratchDir("guard-batch"),store=new WakeStore(join(dir.path,"db"),"env");
  try{
    const rows=[guard,{...guard,invalidationCommandId:"manual"}].map((g,n)=>{
      const row=store.register(store.prepare("wait",input("generation"+n)),"project",null,Date.now(),[],null,null,g);
      store.resolve(row.id,{reason:"time"});return row;
    });
    const d=store.claim(store.dispatchable()[0]!.id)!;
    assert.equal(store.deliveries().filter(row=>row.batch_id===d.id).length,1);
    assert.ok(!JSON.parse(d.payload).text.includes(rows.find(r=>r.id!==d.item)!.id));
  }finally{store.close();dir.remove();}
});
test("new waits fail closed without a qualified server guard or known history",async()=>{
  const {externalWakeGuard:_guard,...old}=snapshot();
  const f=fixture(old);
  try{await assert.rejects(f.engine.register("wait",input("old")),/guard|history|unsupported/i);}
  finally{await f.close();}
});
test("stop then resume while offline orphans the original durable wait after restart",async()=>{
  const f=fixture();
  try{
    const value=input("offline"),row=await f.engine.register("wait",value);
    await f.reopen();
    f.parent({...snapshot(),...{externalWakeGuard:{...guard,lastStopCommandId:"stop",invalidationCommandId:"stop"}}});
    assert.equal((await f.engine.register("wait",value)).id,row.id);
    f.engine.start();
    await f.observed;
    await f.engine.stop();
    assert.equal(f.store.get(row.id).state,"orphaned");
    assert.equal(f.payloads.length,0);
  }finally{await f.close();}
});
