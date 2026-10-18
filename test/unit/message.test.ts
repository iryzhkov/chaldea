import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { receiver,broker,transport } from "../helpers/message-config.ts";
import { MessageStore, WINDOW, RETENTION } from "../../src/message-store.ts";
import { request, decodeRequest, identity, requestHash, message, senderBinding, type SenderConfig } from "../../src/message.ts";
import { receive, authorize, payload, receiverBinding, type ReceiverConfig, type Principal } from "../../src/message-receiver.ts";

const now=1_792_300_000_000;
function fixture(){
  assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
  const base=join(homedir(),"message-tests");mkdirSync(base,{recursive:true,mode:0o700});
  const dir=mkdtempSync(join(base,"t-"));
  const c=receiver(dir);
  const x:Principal={caller:"pc",sourceHost:"source",subject:transport.commandSubject};
  const r=request({v:1,op:"send",host:"target",environment:"fixture",threadId:"thread",requestId:now+":test",text:"hello"});
  const s=new MessageStore(c.database,receiverBinding(c),true);
  return {dir,c,x,r,s,close(){s.close();rmSync(dir,{recursive:true,force:true});}};
}
test("strict bounded wire schema and UTF-8",()=>{
  const good={v:1,op:"send",host:"target",environment:"fixture",threadId:"thread",requestId:now+":key",text:"$(touch marker); ' \" \n"};
  assert.equal(decodeRequest(Buffer.from(JSON.stringify(good))).text,good.text);
  for(const value of [null,[],{}, {...good,op:"recover"},{...good,extra:1},{...good,v:"1"},{...good,text:"x".repeat(4097)},
    {...good,threadId:" padded "},{...good,requestId:"bad"},{...good,op:"status"},{...good,host:"-flag"},{...good,text:"\ud800"}])
    assert.throws(()=>request(value),Error,JSON.stringify(value));
  for(const b of [Buffer.from("{"),Buffer.from(JSON.stringify(good)+"{}"),Buffer.alloc(8193),Buffer.from([255])])assert.throws(()=>decodeRequest(b));
  // Reviewed reduction permits duplicate JSON keys; fields hash after validation.
  assert.equal(decodeRequest(Buffer.from(JSON.stringify(good).replace('"text":','"text":"old","text":'))).text,good.text);
});
test("identities bind authenticated caller, source and each target field; text conflicts without changing ID",()=>{
  const f=fixture();try{
    const id=identity("pc","source",f.r);
    for(const other of [identity("other","source",f.r),identity("pc","other",f.r),
      ...["host","environment","threadId","requestId"].map(key=>identity("pc","source",{...f.r,[key]:"other"}))])assert.notEqual(other.commandId,id.commandId);
    assert.deepEqual(identity("pc","source",{...f.r,text:"changed"}),id);
    assert.notEqual(requestHash(f.r),requestHash({...f.r,text:"changed"}));
    const p=JSON.parse(payload(f.r,"pc",id));
    assert.deepEqual(Object.keys(p).sort(),["type","commandId","messageId","threadId","text","createdBy","creationSource","attachments","dispatchMode"].sort());
    assert.deepEqual(p.dispatchMode,{type:"queue_after_active"});assert.equal(p.text,"Chaldea message from pc\nhello");
  }finally{f.close();}
});
test("broker subject, caller/source, destination and exact thread ACL refuse before connecting",async()=>{
  const f=fixture();try{
    let calls=0;const connect=()=>{calls++;throw new Error("must not connect");};
    assert.throws(()=>authorize(f.c,{...f.x,subject:"chaldea.message.command.other"}));
    assert.throws(()=>authorize(f.c,{...f.x,sourceHost:"other"}));
    assert.throws(()=>authorize(f.c,{...f.x,caller:"other"}));
    for(const r of [{...f.r,host:"other"},{...f.r,environment:"other"},{...f.r,threadId:"unlisted"}])
      await assert.rejects(receive(r,f.x,f.c,f.s,()=>f.c,connect,now));
    assert.equal(calls,0);
  }finally{f.close();}
});
test("immutable intent precedes T3, terminal replay is stored, changed payload conflicts",async()=>{
  const f=fixture();try{
    let dispatches=0;
    const connect=()=>({async preflight(){assert.equal(f.s.get(identity("pc","source",f.r).commandId)?.state,"dispatching");return true;},
      async dispatch(bytes:string){dispatches++;assert.equal(f.s.get(identity("pc","source",f.r).commandId)?.payload,bytes);}});
    const first=await receive(f.r,f.x,f.c,f.s,()=>f.c,connect,now);assert.equal(first.state,"accepted");
    assert.deepEqual(await receive(f.r,f.x,f.c,f.s,()=>f.c,connect,now),first);
    assert.equal((await receive({...f.r,text:"changed"},f.x,f.c,f.s,()=>f.c,connect,now)).state,"conflict");
    assert.equal(f.s.get(first.commandId)?.payload,null);assert.equal(dispatches,1);
    assert.deepEqual(await receive({...f.r,op:"status",text:undefined} as never,f.x,f.c,f.s,()=>f.c,connect,now),first);
  }finally{f.close();}
});
test("uncertain T3 outcome replays only stored bytes; revoked ACL prevents replay and dispatch",async()=>{
  const f=fixture();try{
    let firstBytes="",calls=0;
    const lost=()=>({async preflight(){return true;},async dispatch(bytes:string){firstBytes=bytes;calls++;throw new Error("secret raw error body");}});
    const first=await receive(f.r,f.x,f.c,f.s,()=>f.c,lost,now);assert.equal(first.state,"uncertain");
    assert.ok(!JSON.stringify(first).includes("secret"));
    const revoked={...f.c,callers:{}};
    await assert.rejects(receive(f.r,f.x,revoked,f.s,()=>revoked,lost,now+6000));
    const ok=()=>({async preflight(){return true;},async dispatch(bytes:string){calls++;assert.equal(bytes,firstBytes);}});
    assert.equal((await receive(f.r,f.x,f.c,f.s,()=>revoked,ok,now+6000)).state,"uncertain");assert.equal(calls,1);
    assert.equal((await receive(f.r,f.x,f.c,f.s,()=>f.c,ok,now+12000)).state,"accepted");assert.equal(calls,2);
  }finally{f.close();}
});
test("archived/missing target rejects durably, unavailable T3 remains uncertain",async()=>{
  for(const live of [false,true]){
    const f=fixture();try{
      let dispatched=false;
      const t3=()=>({async preflight(){if(live)throw new Error("unavailable");return false;},async dispatch(){dispatched=true;}});
      const result=await receive(f.r,f.x,f.c,f.s,()=>f.c,t3,now);
      assert.equal(result.state,live?"uncertain":"rejected");assert.equal(dispatched,false);
      if(!live)assert.deepEqual(await receive(f.r,f.x,f.c,f.s,()=>f.c,()=>{throw new Error("no connect");},now),result);
    }finally{f.close();}
  }
});
test("out-of-order distinct requests within window work; real clock rollback refuses",async()=>{
  const f=fixture();try{
    const t3=()=>({async preflight(){return true;},async dispatch(){}});
    assert.equal((await receive(f.r,f.x,f.c,f.s,()=>f.c,t3,now)).state,"accepted");
    const earlier={...f.r,requestId:(now-60_000)+":earlier"};
    assert.equal((await receive(earlier,f.x,f.c,f.s,()=>f.c,t3,now)).state,"accepted");
    assert.equal((await receive({...f.r,requestId:(now-600_000)+":rollback"},f.x,f.c,f.s,()=>f.c,t3,now-600_000)).state,"uncertain");
    const future={...f.r,requestId:(now+300_001)+":future"};
    assert.equal((await receive(future,f.x,f.c,f.s,()=>f.c,t3,now)).error,"message_expired");
  }finally{f.close();}
});
test("expired uncertain retains uncertainty, purges payload, and never dispatches",async()=>{
  const f=fixture();try{
    const t3=()=>({async preflight(){return true;},async dispatch(){throw new Error("lost");}});
    const first=await receive(f.r,f.x,f.c,f.s,()=>f.c,t3,now);
    assert.equal((await receive(f.r,f.x,f.c,f.s,()=>f.c,()=>{throw new Error("no call");},now+WINDOW+1)).state,"uncertain");
    assert.equal(f.s.get(first.commandId)?.payload,null);
    f.s.maintain(now+RETENTION+1);assert.equal(f.s.get(first.commandId),undefined);
    assert.equal(f.s.maintain(now),false,"retention cannot reopen old IDs after rollback");
  }finally{f.close();}
});
test("nonblocking lock and missing receipt state fail closed",()=>{
  const f=fixture();try{
    assert.throws(()=>new MessageStore(f.c.database,receiverBinding(f.c)),/busy/);
    assert.throws(()=>new MessageStore(join(f.dir,"missing.db"),receiverBinding(f.c)));
    assert.throws(()=>new MessageStore(f.c.database,"other"),/binding/);
    writeFileSync(join(f.dir,"empty.db"),"",{mode:0o600});
    assert.throws(()=>new MessageStore(join(f.dir,"empty.db"),receiverBinding(f.c)),/missing/);
    const mode=statSync(f.c.database).mode&0o777;assert.equal(mode,0o600);
  }finally{f.close();}
});
test("durable rate bucket, unresolved/row/payload capacity and fail-closed write error",async()=>{
  const f=fixture();try{
    const t3=()=>({async preflight(){return true;},async dispatch(){}});
    for(let n=0;n<2;n++)assert.equal((await receive({...f.r,requestId:now+":rate"+n},f.x,f.c,f.s,()=>f.c,t3,now)).state,"accepted");
    assert.equal((await receive({...f.r,requestId:now+":rate3"},f.x,f.c,f.s,()=>f.c,t3,now)).state,"uncertain");
    assert.equal((await receive({...f.r,requestId:now+":rate3"},f.x,f.c,f.s,()=>f.c,t3,now+6000)).state,"accepted");
    f.s.db.exec("PRAGMA query_only=ON");
    let called=false;
    assert.equal((await receive({...f.r,requestId:now+":write"},f.x,f.c,f.s,()=>f.c,()=>{called=true;return t3();},now+12000)).state,"uncertain");
    assert.equal(called,false);
    f.s.db.exec("PRAGMA query_only=OFF");
    assert.throws(()=>f.s.begin({id:"large",caller:"pc",hash:"h",stamp:now,payload:"x".repeat(8193)}),/payload_size/);
    for(let n=0;n<16;n++)f.s.begin({id:"unresolved"+n,caller:"pc",hash:"h",stamp:now,payload:"{}"});
    assert.throws(()=>f.s.begin({id:"overflow",caller:"pc",hash:"h",stamp:now,payload:"{}"}),/caller_capacity/);
    f.s.db.exec("UPDATE receipts SET state='accepted',payload=NULL; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10000) INSERT OR IGNORE INTO receipts SELECT 'cap'||x,'pc','h',0,NULL,'accepted','{}' FROM n;");
    assert.throws(()=>f.s.begin({id:"overrows",caller:"pc",hash:"h",stamp:now,payload:"{}"}),/message_capacity/);
  }finally{f.close();}
});
test("crash after intent and after dispatch preserves exact payload; failed receipt commit is uncertain",async()=>{
  const f=fixture();try{
    const id=identity("pc","source",f.r).commandId,bytes=payload(f.r,"pc",identity("pc","source",f.r));
    f.s.begin({id,caller:"pc",hash:requestHash(f.r),stamp:now,payload:bytes});
    const reopened=new MessageStore(join(f.dir,"second.db"),"fixture",true);reopened.close();
    const connect=()=>({async preflight(){return true;},async dispatch(p:string){assert.equal(p,bytes);f.s.db.exec("PRAGMA query_only=ON");}});
    const receipt=await receive(f.r,f.x,f.c,f.s,()=>f.c,connect,now);
    assert.equal(receipt.state,"uncertain");assert.equal(f.s.get(id)?.state,"dispatching");
    f.s.db.exec("PRAGMA query_only=OFF");
    assert.equal((await receive({...f.r,op:"status"} as never,f.x,f.c,f.s,()=>f.c,connect,now)).state,"uncertain");
  }finally{f.close();}
});
test("sender intent survives unavailable broker, changed content conflicts and unknown route refuses",async()=>{
 const f=fixture();try{
  const c:SenderConfig={callerId:"pc",sourceHost:"source",database:join(f.dir,"sender.db"),broker,
   hosts:{target:{...transport,destinationHost:"target",environment:"fixture",threads:["thread"]}}};
  new MessageStore(c.database,senderBinding(c),true).close();
  const i={host:"target",threadId:"thread",requestId:f.r.requestId,text:f.r.text};
  assert.equal((await message("send",i,c,now)).state,"uncertain");
  const s=new MessageStore(c.database,senderBinding(c));assert.ok(s.get(identity("pc","source",f.r).commandId)?.payload);s.close();
  assert.equal((await message("send",{...i,text:"changed"},c,now)).state,"conflict");
  await assert.rejects(message("send",{...i,host:"unconfigured"},c,now));
 }finally{f.close();}
});
