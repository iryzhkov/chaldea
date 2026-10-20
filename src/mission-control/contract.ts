import { createHash } from "node:crypto";
import { validateRich, isolateDetail, compactDetail, normalizeRich, type RichSnapshot } from "./detail-contract.ts";
import { utf8, type Detail, type Preview } from "./details.ts";
import type { MissionModel } from "./model.ts";
export const SNAPSHOT_SCHEMA = "mission-control.host.v1", SNAPSHOT_BYTES = 8192;
export const HOSTS = ["agent-a","agent-b","omarchy-pc","omarchy-macbook-air-igor"] as const;
export const MODELS = ["gpt-6.1-sol","gpt-6-sol","gpt-6-astra","gpt-6-luna","gpt-5.6-sol","claude-opus-5-5","claude-haiku-4-5","unknown"] as const;
export const TOOLS = ["read","search","navigate","edit_apply","change_plan","verify_run","Command running"] as const;
const STATES = ["thinking","working","waiting","waiting-igor","waiting-approval","waiting-children","waiting-monitor","queued","completed","cancelled","idle","failed"] as const;
export interface HostSnapshot {
  rich?:RichSnapshot;
  quota?:HostQuota;
  schema: typeof SNAPSHOT_SCHEMA; host: string; epoch: string; sequence: number; observedAt: number; connected: boolean;
  total: number|null; truncated: boolean;
  agents: {id:string;model:string;state:string;startedAt:number|null;observedAt:number;detailObservedAt:number|null;connected:boolean;steps:string[]}[];
  tokens: {qualified:boolean;output:number|null;rate:number|null;observedAt:number|null;coverage:"unknown"|"observed"|"partial"};
}
function check(ok:unknown):asserts ok {if(!ok) throw new Error("invalid_host_snapshot");}
export function object(v:unknown):Record<string,unknown>{check(v!==null&&typeof v==="object"&&!Array.isArray(v));return v as Record<string,unknown>;}
export function exact(v:Record<string,unknown>,keys:readonly string[]):void {check(Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));}
const count=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0;
const time=(v:unknown):v is number=>count(v)&&v>0&&v<=8_640_000_000_000_000;
export function validateHostSnapshot(raw:unknown):HostSnapshot {
  // Bound traversal before serialization or sparse expansion, including hostile in-memory input.
  let nodes=0;const visit=(v:unknown,depth:number):void=>{check(++nodes<=8192&&depth<=12);check(typeof v!=="string"||v.length<=SNAPSHOT_BYTES);check(!Array.isArray(v)||v.length<=48);if(v&&typeof v==="object")for(const x of Object.values(v))visit(x,depth+1);};
  visit(raw,0);check(Buffer.byteLength(JSON.stringify(raw))<=SNAPSHOT_BYTES);
  const s=object(raw);exact(s,["schema","host","epoch","sequence","observedAt","connected","total","truncated","agents","tokens",...(Object.hasOwn(s,"rich")?["rich"]:[]),...(Object.hasOwn(s,"quota")?["quota"]:[])]);
  check(s.schema===SNAPSHOT_SCHEMA&&HOSTS.includes(s.host as typeof HOSTS[number])&&typeof s.epoch==="string"&&/^[a-f0-9]{32}$/.test(s.epoch));
  check(count(s.sequence)&&s.sequence>0&&time(s.observedAt)&&typeof s.connected==="boolean"&&typeof s.truncated==="boolean");
  check(Array.isArray(s.agents)&&s.agents.length<=48&&(s.total===null||count(s.total)&&s.total>=s.agents.length));
  check(s.total!==null||s.truncated===true);check(s.truncated===true||s.total===s.agents.length);
  const ids=new Set<string>();
  for(const row of s.agents){const a=object(row);exact(a,["id","model","state","startedAt","observedAt","detailObservedAt","connected","steps"]);
    check(typeof a.id==="string"&&/^[a-f0-9]{16}$/.test(a.id)&&!ids.has(a.id));ids.add(a.id);
    check(MODELS.includes(a.model as typeof MODELS[number])&&STATES.includes(a.state as typeof STATES[number])&&typeof a.connected==="boolean");
    check(time(a.observedAt)&&a.observedAt<=s.observedAt&&(a.startedAt===null||time(a.startedAt)&&a.startedAt<=s.observedAt)&&(a.detailObservedAt===null||time(a.detailObservedAt)&&a.detailObservedAt<=s.observedAt));
    check(Array.isArray(a.steps)&&a.steps.length<=6&&a.steps.every(t=>TOOLS.includes(t as typeof TOOLS[number])));
  }
  if(Object.hasOwn(s,"rich")){
    const rich=normalizeRich(s.rich,ids,Number(s.observedAt));
    for(const [id,time] of rich.completionTimes??[]){
      const agent=(s.agents as HostSnapshot["agents"]).find(a=>a.id===id)!;
      check(agent.state==="completed"&&(agent.startedAt===null||time>=agent.startedAt));
    }
    for(const row of rich.details){const app=row.value.identity.appThreadId;
      if(app.state==="reported"&&app.text!==null)check(createHash("sha256").update(String(s.epoch)+"\0"+app.text).digest("hex").slice(0,16)===row.id);
    }
  }
  if(Object.hasOwn(s,"quota"))validateHostQuota(s.quota,Number(s.observedAt));
  const t=object(s.tokens);exact(t,["qualified","output","rate","observedAt","coverage"]);
  check(typeof t.qualified==="boolean"&&["unknown","observed","partial"].includes(t.coverage as string));
  check(t.output===null||count(t.output));check(t.rate===null||typeof t.rate==="number"&&Number.isFinite(t.rate)&&t.rate>=0&&t.rate<=Number.MAX_SAFE_INTEGER);
  check(t.observedAt===null||time(t.observedAt)&&t.observedAt<=s.observedAt);
  check(t.qualified===true&&t.coverage!=="unknown"||t.output===null&&t.rate===null&&t.observedAt===null&&t.coverage==="unknown");
  check(t.output===null||t.observedAt!==null);
  check(Buffer.byteLength(JSON.stringify(s))<=SNAPSHOT_BYTES);
  return structuredClone(s) as unknown as HostSnapshot;
}
/** Base rows keep opaque identities; approved bounded titles/app IDs use the optional detail budget. */
export function captureSnapshot(model:MissionModel,host:string,epoch:string,sequence:number,qualified=false):HostSnapshot|null {
  const v=model.snapshot();if(v.source.observedAt===null)return null;
  const observedAt=Math.max(v.source.state==="live"?v.now:v.source.observedAt,...v.agents.map(a=>Math.max(a.observedAt,a.detailObservedAt??0)),v.tokens.observedAt??0);
  const snapshot:HostSnapshot={schema:SNAPSHOT_SCHEMA,host,epoch,sequence,observedAt,connected:v.source.state==="live",total:v.total,truncated:v.truncated,
    agents:v.agents.map((a,i)=>({id:createHash("sha256").update(epoch+"\0"+model.ids()[i]).digest("hex").slice(0,16),model:MODELS.includes(a.model as typeof MODELS[number])?a.model:"unknown",state:a.state,
      startedAt:a.startedAt,observedAt:a.observedAt,detailObservedAt:a.detailObservedAt,connected:a.activityFreshness==="live",steps:a.steps.filter(t=>TOOLS.includes(t as typeof TOOLS[number]))})),
    tokens:qualified?{qualified:true,output:v.tokens.output,rate:v.tokens.rate,observedAt:v.tokens.observedAt,coverage:v.tokens.coverage as "observed"|"partial"}:
      {qualified:false,output:null,rate:null,observedAt:null,coverage:"unknown"}};
  while(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES&&snapshot.agents.length){snapshot.agents.pop();snapshot.truncated=true;}
  // v5 adds actual completion times through the existing rich schema seam.
  // Older v1/v2/v3/v4 producers remain readable; older readers reject v5.
  const rich:RichSnapshot={v:4,resources:{state:"unavailable",sample:null},details:[],omitted:snapshot.agents.length};
  snapshot.rich=rich;
  if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)delete snapshot.rich;
  else {
    // Completion evidence uses spare bytes only. Missing entries remain explicitly unknown.
    for(const [i,a] of snapshot.agents.entries()){
      const completedAt=v.agents[i]!.completedAt;if(completedAt===null)continue;
      rich.v=5;(rich.completionTimes??=[]).push([a.id,completedAt]);
      if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)rich.completionTimes.pop();
      if(!rich.completionTimes.length){delete rich.completionTimes;rich.v=4;}
    }
    try{rich.resources=validateRich({v:3,resources:v.resources,details:[],omitted:0},new Set(),observedAt).resources;}
    catch{rich.resources={state:"unavailable",sample:null};}
    if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)rich.resources={state:"byte-budget",sample:null};
    for(let i=0;i<snapshot.agents.length;i++){
      const safe=isolateDetail(v.agents[i]!.details,observedAt);
      const row:{id:string;value:import("./detail-contract.ts").WireDetail}={id:snapshot.agents[i]!.id,value:compactDetail({identity:safe.identity,fieldCoverage:"identity-only"})};rich.details.push(row);rich.omitted--;
      if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES){rich.details.pop();rich.omitted++;}
    }
    // Quota yields before admitted identities and resources, and before activity upgrades.
    try{snapshot.quota=quotaProjection(v.quota,observedAt,model.quotaTimes());}catch{snapshot.quota={state:"error",observedAt:null,omitted:0,accounts:[]};}
    if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)snapshot.quota={state:"byte-budget",observedAt:snapshot.quota.observedAt,omitted:snapshot.quota.accounts.length+snapshot.quota.omitted,accounts:[]};
    if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)delete snapshot.quota;
    const candidates=new Map<string,Detail>();
    const preview=(p:Preview):Preview=>p.text!==null&&Buffer.byteLength(p.text)>96?{text:utf8(p.text,96).trimEnd(),state:"truncated"}:p;
    const command=(p:Preview):Preview=>p.text!==null&&Buffer.byteLength(p.text)>96?{text:utf8(p.text,96).split(" ").slice(0,-1).join(" "),state:"truncated"}:p;
    const activity=(d:Detail,tier:number):Detail=>({...d,assistant:preview(d.assistant),commands:d.commands.slice(0,1).map(command),
      commandsOmitted:d.commandsOmitted+Math.max(0,d.commands.length-1),recent:(d.recent??[]).slice(0,tier).map(r=>({...r,preview:r.kind==="command"?command(r.preview):preview(r.preview)})),
      ...((d.recent??[]).length>tier?{recentOmitted:d.recent!.length-tier}:{})});
    for(const row of rich.details){
      const i=snapshot.agents.findIndex(a=>a.id===row.id),detail=isolateDetail(v.agents[i]!.details,observedAt);
      if(detail.fieldCoverage!=="full")continue;
      const full=detail as import("./details.ts").Detail;
      // Keep the source projection newest-first even when timestamps are unknown.
      const recent=[...(full.recent??[])];
      candidates.set(row.id,{...full,recent});
      const identity=row.value;
      // Every thread gets its latest actual observation before older optional observations.
      row.value=compactDetail(activity({...full,recent},1));
      if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)row.value=identity;
    }
    for(let tier=2;tier<=3;tier++)for(const row of rich.details){
      if(row.value.fieldCoverage==="identity-only")continue;
      const full=candidates.get(row.id)!;if((full.recent??[]).length<tier)continue;
      const previous=row.value;
      row.value=compactDetail(activity(full,tier));
      if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)row.value=previous;
    }
    // Restore verbose previews/active commands only after compact activity has been offered to every row.
    for(const row of rich.details){
      if(row.value.fieldCoverage==="identity-only")continue;
      const previous=row.value;row.value=compactDetail(candidates.get(row.id)!);
      if(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES)row.value=previous;
    }
  }
  return validateHostSnapshot(snapshot);
}

// Compact, fixed-order account rows carry no account key, alias or source string.
// [provider, included state/time, used, reset, duration, credits/state, reset state,
// unlimited, manual resets, credits time, manual resets time].
export type QuotaRow=[string,string,number|null,number|null,number|null,number|null,string|null,string,string,boolean|null,number|null,number|null,number|null];
export interface HostQuota {state:"unknown"|"cached"|"error"|"byte-budget";observedAt:number|null;omitted:number;accounts:QuotaRow[]}
const metricStates=["fresh","stale","lost","unknown","unsupported","error"];
export function validateHostQuota(raw:unknown,at:number):HostQuota {
  const q=object(raw);exact(q,["state","observedAt","omitted","accounts"]);
  check(["unknown","cached","error","byte-budget"].includes(String(q.state))&&count(q.omitted)&&Array.isArray(q.accounts)&&q.accounts.length<=4);
  const stamp=(v:unknown)=>v===null||time(v)&&v<=at;
  check(stamp(q.observedAt));
  for(const row of q.accounts){check(Array.isArray(row)&&row.length===13);const r=row as QuotaRow;
    check(["codex","claudeAgent","opencode","Provider"].includes(r[0])&&metricStates.includes(r[1])&&stamp(r[2]));
    check(r[3]===null||typeof r[3]==="number"&&Number.isFinite(r[3])&&r[3]>=0&&r[3]<=100);
    check(r[4]===null||time(r[4]));check(r[5]===null||count(r[5]));
    check(r[6]===null||typeof r[6]==="string"&&/^\d+(?:\.\d+)?$/.test(r[6])&&r[6].length<=24);
    check(metricStates.includes(r[7])&&metricStates.includes(r[8])&&(r[9]===null||typeof r[9]==="boolean")&&(r[10]===null||count(r[10]))&&stamp(r[11])&&stamp(r[12]));
  }
  check(q.state!=="byte-budget"||q.accounts.length===0);
  return structuredClone(q) as unknown as HostQuota;
}
export function quotaProjection(q:ReturnType<MissionModel["snapshot"]>["quota"],at:number,times:[number|null,number|null][]=[]):HostQuota {
  const accounts:QuotaRow[]=q.accounts.slice(0,4).map((a,i)=>[a.label.startsWith("codex " )?"codex":a.label.startsWith("claudeAgent ")?"claudeAgent":a.label.startsWith("opencode ")?"opencode":"Provider",a.state,a.observedAt,a.used,a.resetsAt,a.duration,a.credits,a.creditState,a.resetState,a.unlimited,a.manualResets,times[i]?.[0]??null,times[i]?.[1]??null]);
  return validateHostQuota({state:q.state,observedAt:accounts.some(a=>a[2]!==null||a[11]!==null||a[12]!==null)?Math.max(...accounts.flatMap(a=>[a[2]??0,a[11]??0,a[12]??0])):null,omitted:Math.max(0,q.accounts.length-4),accounts},at);
}
export function quotaAccounts(q:HostQuota,now:number):ReturnType<MissionModel["snapshot"]>["quota"]["accounts"] {
  const state=(s:string,t:number|null)=>t!==null&&now-t>5400_000?"lost":t!==null&&now-t>1800_000?"stale":s;
  return q.accounts.map((r,i)=>({label:r[0]+" account "+(i+1),state:state(r[1],r[2]),observedAt:r[2],ageSeconds:r[2]===null?null:Math.max(0,(now-r[2])/1000),used:r[3],resetsAt:r[4],duration:r[5],credits:r[6],creditState:state(r[7],r[11]),resetState:state(r[8],r[12]),unlimited:r[9],manualResets:r[10]}));
}


export interface FleetEvent {host:string;job:"chaldea-fleet-pull"|"chaldea-retention";status:"changed"|"failed";occurredAt:number;receivedAt:number;severity:"info"|"fail"}
export interface HealthReport {status:string;occurredAt:number;receivedAt:number;checks:{name:string;status:string}[];omitted:number}
export interface OperationsDTO {
  events:{state:"unknown"|"cached"|"error";checkedAt:number|null;windowHours:48;rows:FleetEvent[];truncated:boolean};
  ops:{dailyHealth:{state:"unknown"|"cached"|"error";checkedAt:number|null;report:HealthReport|null}};
}
export const emptyOperations=():OperationsDTO=>({events:{state:"unknown",checkedAt:null,windowHours:48,rows:[],truncated:false},ops:{dailyHealth:{state:"unknown",checkedAt:null,report:null}}});
export const operationText=(v:unknown,max:number):v is string=>typeof v==="string"&&v.length>0&&v.length<=max&&/^[a-zA-Z0-9][a-zA-Z0-9 ._-]*$/.test(v)&&!/(?:bearer|token|secret|password|api.?key|[A-Za-z0-9_-]{32,})/i.test(v);
export function validateOperations(raw:unknown,now=Date.now()):OperationsDTO {
  const v=object(raw);exact(v,["events","ops"]);const e=object(v.events),o=object(v.ops);exact(o,["dailyHealth"]);const d=object(o.dailyHealth);
  exact(e,["state","checkedAt","windowHours","rows","truncated"]);exact(d,["state","checkedAt","report"]);
  const stamp=(v:unknown):v is number=>time(v)&&v<=now;
  for(const x of [e,d])check(["unknown","cached","error"].includes(String(x.state))&&(x.checkedAt===null||stamp(x.checkedAt))&&(x.state!=="cached"||x.checkedAt!==null));
  check(e.windowHours===48&&typeof e.truncated==="boolean"&&Array.isArray(e.rows)&&e.rows.length<=64);
  const counts=new Map<string,number>();for(const raw of e.rows){const r=object(raw);exact(r,["host","job","status","occurredAt","receivedAt","severity"]);
    check(HOSTS.includes(r.host as typeof HOSTS[number])&&["chaldea-fleet-pull","chaldea-retention"].includes(String(r.job))&&["changed","failed"].includes(String(r.status))&&r.severity===(r.status==="failed"?"fail":"info")&&stamp(r.occurredAt)&&stamp(r.receivedAt)&&e.checkedAt!==null&&Number(r.receivedAt)<=Number(e.checkedAt)&&Number(r.occurredAt)<=Number(e.checkedAt));
    counts.set(String(r.host),(counts.get(String(r.host))??0)+1);check(counts.get(String(r.host))!<=16);
  }
  if(d.report!==null){const r=object(d.report);exact(r,["status","occurredAt","receivedAt","checks","omitted"]);
    check(operationText(r.status,32)&&stamp(r.occurredAt)&&stamp(r.receivedAt)&&d.checkedAt!==null&&Number(r.receivedAt)<=Number(d.checkedAt)&&Number(r.occurredAt)<=Number(d.checkedAt)&&count(r.omitted)&&r.omitted<=100&&Array.isArray(r.checks)&&r.checks.length<=16&&r.checks.length+Number(r.omitted)<=100);
    for(const raw of r.checks){const c=object(raw);exact(c,["name","status"]);check(operationText(c.name,128)&&operationText(c.status,32));}
  }
  return structuredClone(v) as unknown as OperationsDTO;
}

export function statusIdentity(e:{host:string;source:string;issuer:string;profile:string;project:string;source_id?:string},snapshot:HostSnapshot):boolean {
  return e.host===snapshot.host&&e.source===snapshot.host+".mission-control"&&e.issuer==="chaldea:"+snapshot.host&&e.profile==="mission-control-publisher"&&e.project==="chaldea"&&(e.source_id===undefined||e.source_id===snapshot.host+"--mission-control");
}
