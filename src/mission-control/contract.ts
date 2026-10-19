import { createHash } from "node:crypto";
import type { MissionModel } from "./model.ts";
export const SNAPSHOT_SCHEMA = "mission-control.host.v1", SNAPSHOT_BYTES = 8192;
export const HOSTS = ["agent-a","agent-b","omarchy-pc","omarchy-macbook-air-igor"] as const;
export const MODELS = ["gpt-6.1-sol","gpt-6-sol","gpt-6-astra","gpt-6-luna","gpt-5.6-sol","claude-opus-5-5","claude-haiku-4-5","unknown"] as const;
export const TOOLS = ["read","search","navigate","edit_apply","change_plan","verify_run"] as const;
const STATES = ["working","waiting","waiting-igor","idle","failed"] as const;
export interface HostSnapshot {
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
  const s=object(raw);exact(s,["schema","host","epoch","sequence","observedAt","connected","total","truncated","agents","tokens"]);
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
  const t=object(s.tokens);exact(t,["qualified","output","rate","observedAt","coverage"]);
  check(typeof t.qualified==="boolean"&&["unknown","observed","partial"].includes(t.coverage as string));
  check(t.output===null||count(t.output));check(t.rate===null||typeof t.rate==="number"&&Number.isFinite(t.rate)&&t.rate>=0&&t.rate<=Number.MAX_SAFE_INTEGER);
  check(t.observedAt===null||time(t.observedAt)&&t.observedAt<=s.observedAt);
  check(t.qualified===true&&t.coverage!=="unknown"||t.output===null&&t.rate===null&&t.observedAt===null&&t.coverage==="unknown");
  check(t.output===null||t.observedAt!==null);
  check(Buffer.byteLength(JSON.stringify(s))<=SNAPSHOT_BYTES);
  return structuredClone(s) as unknown as HostSnapshot;
}
/** Export only fixed labels and epoch-local opaque identities, never source titles. */
export function captureSnapshot(model:MissionModel,host:string,epoch:string,sequence:number,qualified=false):HostSnapshot|null {
  const v=model.snapshot();if(v.source.observedAt===null)return null;
  const observedAt=Math.max(v.source.state==="live"?v.now:v.source.observedAt,...v.agents.map(a=>Math.max(a.observedAt,a.detailObservedAt??0)),v.tokens.observedAt??0);
  const snapshot:HostSnapshot={schema:SNAPSHOT_SCHEMA,host,epoch,sequence,observedAt,connected:v.source.state==="live",total:v.total,truncated:v.truncated,
    agents:v.agents.map((a,i)=>({id:createHash("sha256").update(epoch+"\0"+model.ids()[i]).digest("hex").slice(0,16),model:MODELS.includes(a.model as typeof MODELS[number])?a.model:"unknown",state:a.state,
      startedAt:a.startedAt,observedAt:a.observedAt,detailObservedAt:a.detailObservedAt,connected:a.activityFreshness==="live",steps:a.steps.filter(t=>TOOLS.includes(t as typeof TOOLS[number]))})),
    tokens:qualified?{qualified:true,output:v.tokens.output,rate:v.tokens.rate,observedAt:v.tokens.observedAt,coverage:v.tokens.coverage as "observed"|"partial"}:
      {qualified:false,output:null,rate:null,observedAt:null,coverage:"unknown"}};
  while(Buffer.byteLength(JSON.stringify(snapshot))>SNAPSHOT_BYTES&&snapshot.agents.length){snapshot.agents.pop();snapshot.truncated=true;}
  return validateHostSnapshot(snapshot);
}
export function statusIdentity(e:{host:string;source:string;issuer:string;profile:string;project:string;source_id?:string},snapshot:HostSnapshot):boolean {
  return e.host===snapshot.host&&e.source===snapshot.host+".mission-control"&&e.issuer==="chaldea:"+snapshot.host&&e.profile==="mission-control-publisher"&&e.project==="chaldea"&&(e.source_id===undefined||e.source_id===snapshot.host+"--mission-control");
}
