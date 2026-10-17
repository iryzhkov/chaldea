import assert from "node:assert/strict";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { nativeProjection,type NativeRequest,type WaitSnapshot } from "../../src/t3/waits.ts";
const request=(id="r"):NativeRequest=>({id,nodeId:"node:provider:codex:native-item:"+id,kind:"user_input",status:"pending",capability:"message",created:1,questions:[]});
const snapshot=(requests:NativeRequest[]):WaitSnapshot=>({id:"thread",project:"project",archived:false,deleted:false,settled:false,runs:[],pendingRuns:[],children:[],requests});
const questions=[{id:"q",header:"Question",question:"Deploy?",options:[]}];
function fake(item:unknown){
  const calls:unknown[]=[];
  const client={"orchestration.getTurnItem"(input:unknown){calls.push(input);return Effect.succeed({item});}};
  return {client,calls};
}
test("native point lookup verifies item kind and request identity and only reads the wanted question",async()=>{
  const r=request(),p=snapshot([r,...Array.from({length:200},(_,n)=>request("untracked-"+n))]);
  for(const item of [null,{type:"command_execution",id:"wrong"},{type:"user_input_request",id:"wrong",requestId:"other",questions},
    {type:"user_input_request",id:"turn-item:provider:codex:native-item:r",threadId:"other-thread",requestId:"r",questions},
    {type:"user_input_request",id:"different-item",threadId:"thread",requestId:"r",questions}]){
    const f=fake(item),result=await Effect.runPromise(nativeProjection(f.client as never,"thread",p,[],"r"));
    assert.equal(f.calls.length,1);assert.deepEqual(f.calls[0],{threadId:"thread",itemId:"turn-item:provider:codex:native-item:r"});
    assert.deepEqual(result!.requests![0]!.questions,[]);assert.equal(result!.requests![0]!.itemId,undefined);
  }
  const f=fake({type:"user_input_request",id:"turn-item:provider:codex:native-item:r",threadId:"thread",requestId:"r",questions,responseMode:"message"});
  const result=await Effect.runPromise(nativeProjection(f.client as never,"thread",p,[],"r"));
  assert.equal(f.calls.length,1);assert.equal(result!.requests![0]!.itemId,"turn-item:provider:codex:native-item:r");assert.deepEqual(result!.requests![0]!.questions,questions);
  const permission=fake(null);
  await Effect.runPromise(nativeProjection(permission.client as never,"thread",snapshot([{...r,kind:"permission"}]),[],"r"));
  assert.equal(permission.calls.length,0);
});
test("native history recovery reuses saved schema, resolves verified historical answers and finds only the next preparation",async()=>{
  const r=request(),policy={request_id:"r",turn_item:"verified",questions:JSON.stringify(questions)};
  const cached=fake(null),result=await Effect.runPromise(nativeProjection(cached.client as never,"thread",snapshot([r]),[policy]));
  assert.equal(cached.calls.length,0);assert.deepEqual(result!.requests![0]!.questions,questions);
  const answered=fake({type:"user_input_request",id:"verified",threadId:"thread",requestId:"r",questions,status:"completed",
    responseMode:"message",startedAt:DateTime.makeUnsafe(1),updatedAt:DateTime.makeUnsafe(2)});
  const resolved=await Effect.runPromise(nativeProjection(answered.client as never,"thread",snapshot([]),[policy]));
  assert.equal(resolved!.requests![0]!.status,"resolved");assert.equal(resolved!.requests![0]!.id,"r");assert.equal(answered.calls.length,1);
  const wrong=fake({type:"user_input_request",id:"verified",requestId:"different",questions,status:"completed"});
  const refused=await Effect.runPromise(nativeProjection(wrong.client as never,"thread",snapshot([]),[policy]));
  assert.equal(refused!.requests![0]!.status,"pending");assert.equal(refused!.requests![0]!.capability,"not_resumable");
  const next=fake({type:"user_input_request",id:"turn-item:provider:codex:native-item:next",threadId:"thread",requestId:"next",questions});
  await Effect.runPromise(nativeProjection(next.client as never,"thread",snapshot([
    {...request("old"),created:1},{...request("next"),created:5},{...request("later"),created:8},{...request("permission"),kind:"permission",created:4}
  ]),[{request_id:null,turn_item:null,questions:null,created:3,bind_until:10,baseline:"[]"}]));
  assert.equal(next.calls.length,1);assert.deepEqual(next.calls[0],{threadId:"thread",itemId:"turn-item:provider:codex:native-item:next"});
});
