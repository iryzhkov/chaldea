import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WakeStore } from "../../src/wake/store.ts";
import { NativeDecisions,nativeResponse,questionSchema } from "../../src/decisions/native.ts";
import type { NativeDecisionInput } from "../../src/waits/types.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import type { NativeRequest,WaitSnapshot,WaitT3 } from "../../src/t3/waits.ts";
import { scratchDir } from "../helpers/scratch.ts";
const iso=(n:number)=>new Date(n).toISOString();
const input=(threadId="parent",ms=10_000):NativeDecisionInput=>({threadId,requestId:Date.now()+":"+crypto.randomUUID(),
  dependentAction:"deploy",defaultAction:"defer",deadline:iso(Date.now()+ms)});
const snapshot=(requests:NativeRequest[]=[]):WaitSnapshot=>({id:"parent",project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[],requests});
const request=(id="request",created=Date.now()):NativeRequest=>({id,created,kind:"user_input",status:"pending",capability:"live",
  questions:[{id:"Deploy?",header:"Deploy",question:"Deploy?",options:[{label:"Approve",description:"Proceed"},{label:"Hold",description:"Wait"}]}]});
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until(probe:()=>boolean){const end=Date.now()+5000;while(!probe()){if(Date.now()>end)throw new Error("Timed out");await sleep(10);}}
function fixture(){
  const dir=scratchDir("native-unit"),store=new WakeStore(join(dir.path,"db"),"env");
  const lifecycle=new NativeDecisions(store);
  const register=(value=input(),baseline:string[]=[])=>store.register(store.prepare("native",value),"project",null,Date.now(),baseline);
  return {store,lifecycle,register,close(){store.close();dir.remove();}};
}
test("prepare binds only the next new user_input, expires unbound, and does not bind existing requests",()=>{
  const f=fixture();try{
    const row=f.register(),old=request("old",row.created-1),permission={...request("permission",row.created+1),kind:"command_execution"};
    f.lifecycle.reconcile(row,snapshot([old,permission]),row.created+10);
    assert.equal(f.store.native(row.id).request_id,null);assert.equal(f.store.deliveries().length,0);
    assert.throws(()=>f.register(),/preparation is already waiting/);
    const first=request("first",row.created+2),later=request("later",row.created+3);
    f.lifecycle.reconcile(row,snapshot([later,permission,old,first]),row.created+5);
    assert.equal(f.store.native(row.id).request_id,"first");assert.equal(f.store.deliveries().length,0);
    for(let n=0;n<5;n++)f.lifecycle.reconcile(f.store.get(row.id),snapshot([first,later]),row.created+10);
    assert.equal(f.store.deliveries().length,0);
    const second=f.register(input("other"));const window=f.store.native(second.id).bind_until;
    f.lifecycle.reconcile(second,snapshot(),window);
    assert.deepEqual(JSON.parse(f.store.get(second.id).outcome!),{reason:"preparation_expired"});
    assert.equal(f.store.deliveries().filter(d=>d.item===second.id).length,0);
    const third=f.register(input("third"),["baseline"]);
    f.lifecycle.reconcile(third,snapshot([request("baseline",third.created),request("new",third.created+1)]),third.created+2);
    assert.equal(f.store.native(third.id).request_id,"new");
  }finally{f.close();}
});
test("10 minute binding window is durable; observed human answer during downtime adds no wake",()=>{
  const f=fixture();try{
    const row=f.register(input("parent",20*60_000));
    assert.equal(f.store.native(row.id).bind_until,row.created+10*60_000);
    const answered={...request("answered",row.created+100),status:"resolved" as const};
    f.lifecycle.reconcile(row,snapshot([answered,request("unrelated",row.created+200)]),row.created+11*60_000);
    assert.equal(f.store.native(row.id).request_id,"answered");
    assert.deepEqual(JSON.parse(f.store.get(row.id).outcome!),{reason:"native_answered",defaulted:false,source:"t3",runtimeRequestId:"answered"});
    assert.equal(f.store.deliveries().length,0);
    f.lifecycle.reconcile(f.store.get(row.id),snapshot([answered]),row.deadline+1);
    assert.equal(f.store.deliveries().filter(d=>d.channel==="wake"||d.channel==="native").length,0);
  }finally{f.close();}
});
test("safe response never selects approval; free text and fixed skip/defer contract paths are explicit",()=>{
  const f=fixture();try{
    const row=f.register(),q=request();
    const payload=JSON.parse(nativeResponse(row,q)!);
    assert.deepEqual(payload.answers,{"Deploy?":"No answer by the deadline: defer deploy"});
    assert.equal(payload.type,"runtime-request.respond");assert.equal(payload.commandId,"chaldea-native:"+row.id+":default");
    for(const option of [{label:"Approve",description:"Proceed"},{label:"defer deployment and approve",description:"Unsafe"},{label:"Defer",value:"approve",description:"Unsafe wire value"}]){
      const fixed={...q,questions:[{...q.questions[0]!,allowCustomAnswer:false,options:[option]}]};
      assert.equal(nativeResponse(row,fixed),null);
    }
    for(const multiSelect of [false,true]){
      const fixed={...q,questions:[{...q.questions[0]!,multiSelect,allowCustomAnswer:false,options:[{label:"Defer",value:"defer",description:"Wait"}]}]};
      assert.deepEqual(JSON.parse(nativeResponse(row,fixed)!).answers,{"Deploy?":multiSelect?["defer"]:"defer"});
    }
    const fixedMessage={...q,capability:"message" as const,questions:[{...q.questions[0]!,allowCustomAnswer:false,multiSelect:true,options:[{label:"Defer",description:"Wait"}]}]};
    assert.deepEqual(JSON.parse(nativeResponse(row,fixedMessage)!).answers,{"Deploy?":"Defer"});
    assert.equal(nativeResponse(row,{...q,kind:"command_execution"}),null);
    assert.equal(nativeResponse(row,{...q,questions:[]}),null);
  }finally{f.close();}
});
test("unsafe fixed questions and unavailable requests each create exactly one attention wake",()=>{
  for(const mode of ["fixed","not_resumable","expired","missing","permission"]){
    const f=fixture();try{
      const row=f.register({...input(),runtimeRequestId:"request"});
      let q:NativeRequest=request();
      if(mode==="fixed")q={...q,questions:[{...q.questions[0]!,allowCustomAnswer:false}]};
      if(mode==="not_resumable")q={...q,capability:"not_resumable"};
      if(mode==="expired")q={...q,status:"expired"};
      if(mode==="permission")q={...q,kind:"command_execution"};
      const p=snapshot(mode==="missing"?[]:[q]);
      for(let n=0;n<4;n++)f.lifecycle.reconcile(f.store.get(row.id),p,row.deadline+1);
      assert.equal(f.store.get(row.id).state,"needs_attention");
      const wakes=f.store.deliveries().filter(d=>d.channel==="wake");assert.equal(wakes.length,1);
      assert.match(JSON.parse(wakes[0]!.payload).text,/needs attention/);
      assert.match(JSON.parse(wakes[0]!.payload).text,new RegExp("chaldea decision status "+row.id));
      assert.equal(f.store.deliveries().filter(d=>d.channel==="native").length,0);
    }finally{f.close();}
  }
});
test("native deadlines arbitrate both human/default winners through T3; ambiguous ACK reuses exact bytes",async()=>{
  for(const mode of ["human_first","default_first","lost_ack","transient_rpc","lost_then_human","lost_ack_rpc_error"]){
    const f=fixture();let engine:WaitEngine|undefined;try{
      const q=request();let on:((s:WaitSnapshot|null,c:number)=>void)|undefined;
      const receipts=new Map<string,boolean>(),payloads:string[]=[];
      const port:WaitT3={async environment(){return "env";},async snapshot(){return snapshot([q]);},
        async observe(_id,signal,callback){on=callback;callback(snapshot([q]),1);await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
        async dispatch(){throw new Error("Native answers must not wake");},
        async respond(payload){
          payloads.push(payload);const id=JSON.parse(payload).commandId;
          if(mode==="lost_ack_rpc_error" && payloads.length===2)throw new Error("Transient public receipt lookup error after commit");
          if(receipts.has(id))return receipts.get(id)!;
          if(mode==="transient_rpc" && payloads.length===1)throw new Error("Transient public dispatch error");
          if(mode==="lost_then_human" && payloads.length===1){
            q.status="resolved";on?.(snapshot([q]),2);throw new Error("Send dropped; human answered before replay");
          }
          if(mode==="human_first" || mode==="lost_then_human"){q.status="resolved";receipts.set(id,false);on?.(snapshot([q]),2);return false;}
          q.status="resolved";receipts.set(id,true);on?.(snapshot([q]),2);
          if(mode==="lost_ack" || mode==="lost_ack_rpc_error")throw new Error("Lost native receipt after commit");
          return true;
        }};
      engine=new WaitEngine(f.store,port,{});
      engine.start();
      const row=await engine.registerNative({...input("parent",100),runtimeRequestId:q.id},true);
      await until(()=>f.store.get(row.id).outcome!==null);
      const outcome=JSON.parse(f.store.get(row.id).outcome!);
      const humanWon=mode==="human_first"||mode==="lost_then_human",retried=["lost_ack","transient_rpc","lost_then_human","lost_ack_rpc_error"].includes(mode);
      assert.equal(outcome.defaulted,!humanWon);assert.equal(outcome.source,humanWon?"t3":"chaldea");
      assert.equal(receipts.size,1);assert.equal(payloads.length,mode==="lost_ack_rpc_error"?3:retried?2:1);
      for(const payload of payloads)assert.equal(payload,payloads[0]);
      assert.equal(f.store.deliveries().filter(d=>d.channel==="wake").length,0);
      assert.equal(f.store.deliveries().find(d=>d.channel==="native")!.state,humanWon?"suppressed":"sent");
    }finally{await engine?.stop();f.close();}
  }
});
test("minimal native answer schema survives restart and a missing history item; fresh schema changes fail closed",()=>{
  const dir=scratchDir("native-schema"),path=join(dir.path,"db");let store=new WakeStore(path,"env");
  try{
    const reg=store.prepare("native",input()),row=store.register(reg,"project",null);
    const q={...request("persisted",row.created+1),questions:[{id:"q",header:"private header",question:"private question prose",
      options:[{label:"Approve",description:"private option description"}]}]};
    let lifecycle=new NativeDecisions(store);lifecycle.reconcile(row,snapshot([q]),row.created+2);
    const saved=store.native(row.id).questions!;assert.ok(saved);
    assert.ok(!saved.includes("private"));assert.deepEqual(JSON.parse(saved),[{id:"q",allowCustomAnswer:true,multiSelect:false,options:[]}]);
    store.close();store=new WakeStore(path,"env");lifecycle=new NativeDecisions(store);
    const omitted={...q,questions:[]};lifecycle.reconcile(store.get(row.id),snapshot([omitted]),row.deadline+1);
    const delivery=store.deliveries().find(d=>d.channel==="native")!;
    assert.ok(delivery);assert.deepEqual(JSON.parse(delivery.payload).answers,{q:"No answer by the deadline: defer deploy"});
    assert.equal(lifecycle.beforeSend(store.get(row.id),delivery,snapshot([omitted])),true);
    assert.equal(store.deliveries().filter(d=>d.channel==="wake").length,0);
    const changed={...q,questions:[{id:"other",options:[]}]};
    assert.equal(lifecycle.beforeSend(store.get(row.id),delivery,snapshot([changed])),false);
    assert.equal(store.get(row.id).state,"needs_attention");assert.equal(store.deliveries().filter(d=>d.channel==="wake").length,1);
    const large=Array.from({length:8},(_,i)=>({id:String(i)+"x".repeat(1024),options:[]}));
    assert.equal(questionSchema(large),null);
  }finally{store.close();dir.remove();}
});
test("older native tables acquire schema and item columns without losing committed policy",()=>{
  const dir=scratchDir("native-migration"),path=join(dir.path,"db");let store=new WakeStore(path,"env");
  try{
    const row=store.register(store.prepare("native",{...input(),runtimeRequestId:"r"}),"project",null);store.close();
    const old=new DatabaseSync(path);
    try{old.exec("ALTER TABLE native_decisions DROP COLUMN questions; ALTER TABLE native_decisions DROP COLUMN turn_item");}finally{old.close();}
    store=new WakeStore(path,"env");const policy=store.native(row.id);
    assert.equal(policy.request_id,"r");assert.equal(policy.questions,null);assert.equal(policy.turn_item,null);
    assert.equal(store.get(row.id).state,"parked");
  }finally{store.close();dir.remove();}
});
test("native registration validates explicit runtime identity and refuses permissions, mismatched retry and active capacity",async()=>{
  const f=fixture();let engine:WaitEngine|undefined;try{
    const q=request();const port:WaitT3={async environment(){return "env";},async snapshot(){return snapshot([q]);},
      async observe(_id,signal){await new Promise<void>(r=>signal.addEventListener("abort",()=>r(),{once:true}));},
      async dispatch(){},async respond(){return true;}};
    engine=new WaitEngine(f.store,port,{});
    await assert.rejects(engine.registerNative(input(),true),/runtimeRequestId required/);
    await assert.rejects(engine.registerNative({...input(),runtimeRequestId:q.id}),/Use decision track/);
    await assert.rejects(engine.registerNative({...input(),runtimeRequestId:"missing"},true),/does not exist/);
    q.kind="command_execution";
    await assert.rejects(engine.registerNative({...input(),runtimeRequestId:q.id},true),/permissions and approvals/);
    q.kind="user_input";const original=q.questions;q.questions=[];
    await assert.rejects(engine.registerNative({...input(),runtimeRequestId:q.id},true),/schema is unavailable/);q.questions=original;
    const value={...input(),runtimeRequestId:q.id},row=await engine.registerNative(value,true);
    assert.equal((await engine.registerNative(value,true)).id,row.id);
    await assert.rejects(engine.registerNative({...value,defaultAction:"skip"},true),/changed payload/);
    assert.throws(()=>f.register({...input("other"),runtimeRequestId:q.id}),/already tracked/);
    for(let n=1;n<128;n++)f.register(input("thread-"+n));
    assert.throws(()=>f.register(input("overflow")),/limit \(128\)/);
  }finally{await engine?.stop();f.close();}
});
