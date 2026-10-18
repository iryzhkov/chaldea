import { MissionModel } from "./model.ts";
import { emptyHeadroom, newProvider } from "../quota/headroom.ts";
import type { ShellThread } from "../t3/adapter.ts";
export function fixtureModel(model: MissionModel, now = Date.now()): void {
  const threads: ShellThread[] = Array.from({length:4},(_,i)=>({
    id:"fixture-"+i, title:["Review read-only canary","Implement bounded stream cleanup","Inspect quota observations","Verify source freshness"][i]!,
    status:i===3?"failed":"running",providerInstanceId:"fixture",modelSelection:{instanceId:"fixture",model:"gpt-6.1-sol"},
    pendingRequest:i===2,latestRunId:"run-"+i,activeRunId:i===3?null:"run-"+i,
    latestRunStartedAt:new Date(now-120000).toISOString(),latestRunCompletedAt:null,lastErrorClass:null,usageLimitResetAt:null,limitRecovery:null,relationshipToParent:null,archived:false,deleted:false,
  }));
  model.shell({kind:"snapshot",sequence:1,threads}); model.shell({kind:"synchronized"});
  for(const t of threads) { model.detail(t.id,{kind:"synchronized"}); model.detail(t.id,{kind:"activity",tool:"read"}); }
  model.detail("fixture-0",{kind:"usage",turnId:"fixture-turn",output:0,at:now-1000,baseline:true});
  model.detail("fixture-0",{kind:"usage",turnId:"fixture-turn",output:60,at:now,baseline:false});
  const state=emptyHeadroom(), p=newProvider("fixture","codex");
  p.accountKey="fixture-account-never-browser";
  p.included={value:[{id:"session",kind:"session",usedPercent:0,remainingPercent:100,windowDurationMins:300,resetsAt:new Date(now+3600000).toISOString()}],state:"fresh",source:"fixture",observedAt:new Date(now).toISOString(),error:null};
  state.providers.push(p,newProvider("fixture-unknown","claudeAgent"));
  model.setQuota(state);
}
