import test from "node:test";
import assert from "node:assert/strict";
import { normalize, validateEnvelope } from "../../src/akasha/schema.ts";
import { Authorization } from "../../src/akasha/auth.ts";
import { scopeSql } from "../../src/akasha/store.ts";
import { rig, N } from "./helpers.ts";
export const sample = (sequence=1, observedAt=N*1000) => ({
  schema:"mission-control.host.v1",host:"agent-a",epoch:"a".repeat(32),sequence,observedAt,connected:true,
  total:1,truncated:false,agents:[{id:"b".repeat(16),model:"gpt-6.1-sol",state:"working",startedAt:observedAt-1000,observedAt,detailObservedAt:observedAt,connected:true,steps:["read"]}],
  tokens:{qualified:false,output:null,rate:null,observedAt:null,coverage:"unknown"}
});
const identity={issuer:"chaldea:agent-a",profile:"mission-control-publisher",project:"chaldea",source:"agent-a.mission-control",host:"agent-a",run_id:"fixture",source_id:"agent-a--mission-control"};
const payload=()=>({v:1,kind:"agent_status",title:"Mission control status",data:{snapshot:sample()}});
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
    const publisher={...identity,mode:"service" as const,kinds:["agent_status" as const]};
    const reader={issuer:"chaldea:omarchy-normandy",profile:"mission-control-reader",project:"chaldea",source:"mission-control-reader",host:"omarchy-normandy",source_id:"omarchy-normandy--mission-control-reader",mode:"service" as const,kinds:["agent_status" as const],mission_control_read_sources:["agent-a--mission-control"]};
    assert.doesNotThrow(()=>new Authorization([publisher,reader] as any,x.trust,x.clock));
    for(const change of [{profile:"other"},{project:"other"},{mode:"operator"},{kinds:["feed_post"]},{mission_control_read_sources:[]},{mission_control_read_sources:["missing"]},{mission_control_read_sources:Array(5).fill("agent-a--mission-control")}])
      assert.throws(()=>new Authorization([publisher,{...reader,...change}] as any,x.trust,x.clock));
    const q=scopeSql({...reader,global:false,missionControlSources:reader.mission_control_read_sources} as any);
    assert.match(q.sql,/source_id/);assert.match(q.sql,/snapshot/);assert.ok(q.params.includes("agent_status"));
  } finally{x.close();}
});
