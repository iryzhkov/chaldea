import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHost } from "../../src/mission-control/model.ts";
const { projectClientSnapshot } = await import(new URL("../../src/mission-control/static/client.js",import.meta.url).href);
const sample=()=>({now:1_000_000,source:{state:"live",observedAt:0},agents:[{id:"agent-0",activityFreshness:"live",detailObservedAt:0}],quota:{state:"cached"},truncated:false});
test("browser ages last heartbeat, marks error or timeout disconnected, and restores only on a fresh snapshot",()=>{
  const raw=sample();
  let view=projectClientSnapshot(raw,1_010_000,true);
  assert.equal(view.agents[0].detailObservedAt,1_000_000);
  assert.equal(view.agents[0].activityFreshness,"live");
  view=projectClientSnapshot(raw,1_010_000,false);
  assert.equal(view.agents[0].activityFreshness,"disconnected");
  assert.equal(view.source.state,"disconnected");
  assert.equal(view.agents[0].detailObservedAt,1_000_000);
  view=projectClientSnapshot(raw,1_031_000,true);
  assert.equal(view.agents[0].activityFreshness,"disconnected");
  assert.equal(view.source.state,"disconnected");
  assert.equal(projectClientSnapshot(raw,4_600_000,false).agents[0].detailObservedAt,1_000_000);
  assert.equal(raw.agents[0]!.activityFreshness,"live");
  const fresh={...raw,now:4_600_000};
  assert.equal(projectClientSnapshot(fresh,4_601_000,true).agents[0].activityFreshness,"live");
  assert.equal(projectClientSnapshot(fresh,4_601_000,true).agents[0].detailObservedAt,4_600_000);
});
test("sampled host summaries lose browser freshness without changing source evidence",()=>{
  const raw={...sample(),sampled:true,hostSummary:[
    summarizeHost("omarchy-pc",[{state:"working",model:"Model unknown"}],1,false,990_000,"live",true),
    summarizeHost("agent-a",[],0,false,995_000,"live",true),
    ...["nosource","cached","stale","lost","disconnected"].map(freshness=>
      summarizeHost(freshness,[],freshness==="nosource"?null:0,false,freshness==="nosource"?null:900_000,freshness,false)),
  ]};
  const original=structuredClone(raw),expected=["disconnected","disconnected","nosource","cached","stale","lost","disconnected"];
  const states=(view:any)=>view.hostSummary.map((h:any)=>h.freshness);
  assert.deepEqual(states(projectClientSnapshot(raw,1_030_000,true)),raw.hostSummary.map(h=>h.freshness));
  for(const [now,connected] of [[1_010_000,false],[1_030_001,true]] as const){
    const view=projectClientSnapshot(raw,now,connected);
    assert.deepEqual(states(view),expected);
    assert.deepEqual(view.hostSummary,raw.hostSummary.map(h=>({...h,freshness:h.freshness==="live"?"disconnected":h.freshness})));
    assert.equal(view.agents[0].detailObservedAt,0);
    assert.equal(view.source.observedAt,0);
    assert.deepEqual(raw,original);
  }
  assert.deepEqual(states(projectClientSnapshot({...raw,now:NaN},1_010_000,true)),expected);
  const timedOut=projectClientSnapshot(raw,1_031_000,true);
  assert.deepEqual(states(projectClientSnapshot(timedOut,1_032_000,true)),expected);
  const fresh={...raw,now:1_032_000};
  assert.deepEqual(states(projectClientSnapshot(fresh,1_033_000,true)),raw.hostSummary.map(h=>h.freshness));
  assert.deepEqual(raw,original);
  assert.equal(Object.hasOwn(projectClientSnapshot(sample(),1_010_000,false),"hostSummary"),false);
});
test("upstream detail disconnect and its timestamp survive browser reconnection",()=>{
  const raw=sample();raw.agents[0]!.activityFreshness="stale";raw.agents[0]!.detailObservedAt=900_000;
  assert.equal(projectClientSnapshot(raw,1_001_000,true).agents[0].activityFreshness,"stale");
  assert.equal(projectClientSnapshot(raw,1_001_000,true).agents[0].detailObservedAt,900_000);
});

test("completion filtering retains failed, cancelled and unknown times without changing token or host coverage",()=>{
 const at=1_000_000;
 const states=["completed","working","waiting-children","queued","failed","cancelled","idle"];
 const raw={...sample(),agents:states.map((state,i)=>({id:String(i),state,completedAt:at})),tokens:{output:99},hostSummary:[{shown:7,total:7,freshness:"live"}]};
 for(const elapsed of [59_999,60_000,120_000]){
  const v=projectClientSnapshot(raw,at+elapsed,true);
  assert.equal(v.threadAgents.length,elapsed<60_000?7:6);
  assert.equal(v.agents.length,7);assert.deepEqual(v.tokens,raw.tokens);assert.equal(v.hostSummary[0].shown,7);
 }
 for(const completedAt of [undefined,null,0,-1,NaN,Infinity,"1000000",at+60_001]){
  assert.equal(projectClientSnapshot({...raw,agents:[{state:"completed",completedAt}]},at+60_000,true).threadAgents.length,1);
 }
 assert.equal(raw.agents.length,7);
});
