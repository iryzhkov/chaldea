// Finite public detail projection. Source identities and raw text stay inside capture.
export type Preview = {text:string|null;state:"reported"|"redacted"|"truncated"|"withheld"|"not-reported"};
export type Effort = {value:string|null;source:"reported"|"configured"|"not-reported"};
export type ResourceSample = {sampledAt:number;cpuUtilization:number|null;cpuCount:number;availableMemoryBytes:number;totalMemoryBytes:number};
export type Resources = {state:"reported"|"unavailable"|"byte-budget";sample:ResourceSample|null};
export type Usage = {input:number|null;output:number|null;cacheRead:number|null;cacheWrite:number|null;reasoning:number|null;total:number|null;turns:number;coverage:"observed"|"partial"|"not-reported";observedAt:number|null;rate:number|null;windowSeconds:60;scope:"main-agent observed turns"};
export type Work = {active:number;queued:number;completed:number};
export type ProviderIdentity = {instanceId:string;driver:string|null};
export type Recent = {kind:"assistant"|"command";preview:Preview;at:number|null;status:"running"|"completed"|"failed"|"cancelled"|"unknown"};
export const safeProviderId=(v:unknown):v is string=>typeof v==="string"&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v)&&!/(?:bearer|password|secret|credential|api[_-]?key|token|sk-|gh[pousr]_)/i.test(v);
export type Detail = {recentOmitted?:number;provider?:ProviderIdentity|null;recent?:Recent[];identity:{title:Preview;appThreadId:Preview};fieldCoverage:"full"|"identity-only";activity:"thinking"|"working"|null;assistant:Preview;commands:Preview[];commandsOmitted:number;effort:Effort;usage:Usage;context:{used:number;max:number|null}|null;work:{children:Work|null;delegates:Work|null;subagents:Work|null;monitors:number|null;background:number|null;durableWaits:null;coverage:"observed bounded roster"|"not-reported"}};
export const integer=(n:unknown):n is number=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0;
export function utf8(text:string,max:number):string {let result="";for(const c of text){if(Buffer.byteLength(result+c)>max)break;result+=c;}return result;}
const normalize=(text:string)=>text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g," ");
const suspicious=/(?:bearer\s|password|passwd|secret|credential|api[ _-]?key|access[ _-]?token|refresh[ _-]?token|sk-[\w-]+|gh[pousr]_[\w]+|-----BEGIN|[A-Za-z0-9_+\/-]{32,}={0,2}|[\w.+-]+@[\w.-]+|https?:\/\/[^\s]*[@?])/i;
export function assistantPreview(value:unknown):Preview {
  if(typeof value!=="string"||!value.trim())return {text:null,state:"not-reported"};
  // Inspect the entire bounded source input before extracting the paragraph.
  if(Buffer.byteLength(value)>65536)return {text:null,state:"withheld"};
  const normalized=normalize(value);
  if(!normalized.trim())return {text:null,state:"not-reported"};
  if(suspicious.test(normalized.replace(/[\t\n\r]/g," ")))return {text:null,state:"withheld"};
  const paragraph=normalized.trim().split(/\n\s*\n/).filter(s=>s.trim()).at(-1)!.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g," ").trim();
  const text=utf8(paragraph,384).trimEnd();return {text,state:text===paragraph?"reported":"truncated"};
}
const commands=new Set(["git","go","npm","node","python","python3","pytest","rg","make","tsc","chaldea","jocasta","cargo"]);
const safeArgs=new Set(["test","run","build","typecheck","check","status","diff","log","show","exec","get","search","--test","--check","--stat","--short","--porcelain","--no-emit","--noEmit","--help","--version","-race","-v","-q","./..."]);
export function commandPreview(value:unknown):Preview {
  if(typeof value!=="string"||!value.trim())return {text:null,state:"not-reported"};
  // Shell programs/env assignments/heredocs cannot safely be summarized as executable argv.
  if(Buffer.byteLength(value)>8192||/[\n\r\x00`$;|&<>(){}]/.test(value)||suspicious.test(value))return {text:null,state:"withheld"};
  const args=value.trim().split(/\s+/),name=args.shift()!;
  if(!commands.has(name))return {text:null,state:"withheld"};
  const shown=args.map(a=>safeArgs.has(a)?a:"…").filter((a,i,aAll)=>a!=="…"||aAll[i-1]!=="…").slice(0,12);
  let text=name,kept=0;
  for(const arg of shown){if(Buffer.byteLength(text+" "+arg)>128)break;text+=" "+arg;kept++;}
  return {text,state:kept<args.length?"truncated":args.some(a=>!safeArgs.has(a))?"redacted":"reported"};
}
export function titlePreview(value:unknown):Preview {
  if(typeof value!=="string"||!value.trim())return {text:null,state:"not-reported"};
  if(suspicious.test(normalize(value).replace(/[\t\n\r]/g," "))||/(?:\/|\\)[\w.~]/.test(value))return {text:null,state:"withheld"};
  const clean=normalize(value).replace(/[\t\n\r]/g," ").trim(),text=utf8(clean,160);
  return {text,state:text.length<clean.length?"truncated":clean===value?"reported":"redacted"};
}
export function appThreadIdPreview(value:unknown):Preview {
  if(typeof value!=="string"||!value)return {text:null,state:"not-reported"};
  if(!/^[A-Za-z0-9._:%/-]+$/.test(value)||/(?:bearer|password|secret|credential|sk-|gh[pousr]_)/i.test(value))return {text:null,state:"withheld"};
  return {text:utf8(value,256),state:Buffer.byteLength(value)>256?"truncated":"reported"};
}
export function effort(selection:unknown,source:Effort["source"]):Effort {
  const options=(selection as {options?:unknown}|null)?.options;
  const entries=Array.isArray(options)?options:options&&typeof options==="object"?Object.entries(options).map(([id,value])=>({id,value})):[];
  for(const key of ["reasoningEffort","effort"]){const v=entries.find(e=>e?.id===key)?.value;if(typeof v==="string"&&["none","minimal","low","medium","high","xhigh","max","ultra"].includes(v))return {value:v,source};}
  return {value:null,source:"not-reported"};
}
export const emptyUsage=():Usage=>({input:null,output:null,cacheRead:null,cacheWrite:null,reasoning:null,total:null,turns:0,coverage:"not-reported",observedAt:null,rate:null,windowSeconds:60,scope:"main-agent observed turns"});
export const emptyDetail=():Detail=>({provider:null,recent:[],identity:{title:{text:null,state:"not-reported"},appThreadId:{text:null,state:"not-reported"}},fieldCoverage:"full",activity:null,assistant:{text:null,state:"not-reported"},commands:[],commandsOmitted:0,effort:{value:null,source:"not-reported"},usage:emptyUsage(),context:null,work:{children:null,delegates:null,subagents:null,monitors:null,background:null,durableWaits:null,coverage:"not-reported"}});
export type TurnUsage = {usageScope:"main_agent";usageStatus:"complete"|"partial"|"unavailable";inputTokens?:number|undefined;outputTokens?:number|undefined;cachedInputTokens?:number|undefined;cacheCreationTokens?:number|undefined;reasoningTokens?:number|undefined;hasSubagents:boolean};
export type DetailEvent =
 | {kind:"recent-item";id:string;ordinal:number;type:Recent["kind"];text:string;at:number|null;status:Recent["status"]}
 | {kind:"reset"}
 | {kind:"clear-activity"}
 | {kind:"activity-state";id:string;type:"thinking"|"working";running:boolean}
 | {kind:"assistant";text:string;at:number}
 | {kind:"command";id:string;input:string;running:boolean}
 | {kind:"metadata";reported:unknown;context:{used:number;max:number|null}|null;work:Detail["work"]}
 | {kind:"turn-usage";id:string;usage:TurnUsage;at:number;partial?:boolean};
export class ThreadDetails {
  private value=emptyDetail();
  private assistantAt=0;
  private recent=new Map<string,{ordinal:number;value:Recent}>();
  private commands=new Map<string,Preview>();
  private activeItems=new Map<string,"thinking"|"working">();
  private turns=new Map<string,{usage:TurnUsage;at:number}>();
  private partial=false;
  apply(e:DetailEvent):void {
    if(e.kind==="reset"){this.turns.clear();this.partial=false;this.recent.clear();this.commands.clear();this.activeItems.clear();this.value.work=emptyDetail().work;this.value.context=null;this.value.effort=emptyDetail().effort;}
    if(e.kind==="clear-activity"){this.activeItems.clear();this.commands.clear();for(const r of this.recent.values())if(r.value.status==="running")r.value.status="unknown";}
    if(e.kind==="recent-item"&&integer(e.ordinal)){
      this.recent.set(e.id,{ordinal:e.ordinal,value:{kind:e.type,preview:e.type==="assistant"?assistantPreview(e.text):commandPreview(e.text),at:e.at,status:e.status}});
      const keep=[...this.recent].sort((a,b)=>b[1].ordinal-a[1].ordinal||b[0].localeCompare(a[0])).slice(0,3);
      this.recent=new Map(keep);
    }
    if(e.kind==="activity-state"){if(!e.running)this.activeItems.delete(e.id);else if(this.activeItems.has(e.id)||this.activeItems.size<64)this.activeItems.set(e.id,e.type);}
    if(e.kind==="assistant"&&e.at>=this.assistantAt){const preview=assistantPreview(e.text);if(preview.state!=="not-reported"){this.value.assistant=preview;this.assistantAt=e.at;}}
    if(e.kind==="command"){if(!e.running)this.commands.delete(e.id);else if(this.commands.has(e.id)||this.commands.size<32)this.commands.set(e.id,commandPreview(e.input));else this.partial=true;}
    if(e.kind==="metadata"){this.value.effort=effort(e.reported,"reported");this.value.context=e.context;this.value.work=e.work;}
    if(e.kind==="turn-usage"&&integer(e.at)&&e.usage.usageScope==="main_agent"){
      if(e.partial)this.partial=true;
      const old=this.turns.get(e.id);
      if(old&&old.at>e.at)return;
      // Replacement by stable identity, including reconnect and corrections; never sum counters.
      this.turns.set(e.id,{usage:e.usage,at:e.at});
      if(this.turns.size>8){this.turns.delete(this.turns.keys().next().value!);this.partial=true;}
    }
  }
  snapshot(configured:unknown,now:number,connected:boolean):Detail {
    const result=structuredClone(this.value);result.activity=connected?([...this.activeItems.values()].includes("working")?"working":[...this.activeItems.values()].includes("thinking")?"thinking":null):null;
    result.recent=[...this.recent.values()].map(r=>({...structuredClone(r.value),at:integer(r.value.at)&&r.value.at>0&&r.value.at<=now?r.value.at:null,status:!connected&&r.value.status==="running"?"unknown":r.value.status}));
    const values=[...this.turns.values()].filter(v=>v.usage.usageStatus!=="unavailable");
    if(result.effort.source!=="reported")result.effort=effort(configured,"configured");
    result.commands=connected?[...this.commands.values()].slice(0,3):[];
    result.commandsOmitted=connected?Math.max(0,this.commands.size-3):0;
    if(values.length){
      const sum=(key:keyof TurnUsage)=>{if(!values.every(v=>integer(v.usage[key])))return null;const n=values.reduce((n,v)=>n+Number(v.usage[key]),0);return integer(n)?n:null;};
      const u=result.usage;u.input=sum("inputTokens");u.output=sum("outputTokens");u.cacheRead=sum("cachedInputTokens");u.cacheWrite=sum("cacheCreationTokens");u.reasoning=sum("reasoningTokens");
      u.total=u.input!==null&&u.output!==null&&integer(u.input+u.output)?u.input+u.output:null;u.turns=values.length;u.observedAt=Math.max(...values.map(v=>v.at));
      u.coverage=this.partial||values.length<this.turns.size||u.total===null||values.some(v=>v.usage.usageStatus!=="complete")?"partial":"observed";
      // Completed turn totals do not qualify an instantaneous or rolling generation rate.
    }
    return result;
  }
}
export function validResources(value:unknown):value is ResourceSample {
  const r=value as ResourceSample;
  return !!r&&Object.keys(r).length===5&&integer(r.sampledAt)&&integer(r.cpuCount)&&integer(r.availableMemoryBytes)&&integer(r.totalMemoryBytes)&&r.availableMemoryBytes<=r.totalMemoryBytes&&(r.cpuUtilization===null||typeof r.cpuUtilization==="number"&&Number.isFinite(r.cpuUtilization)&&r.cpuUtilization>=0&&r.cpuUtilization<=1);
}
export function aggregateDetails(details:Detail[],total:number):{usage:Usage;work:Detail["work"];coverage:string} {
  const usage=emptyUsage(),known=details.filter(d=>d.usage.coverage!=="not-reported");
  if(known.length){
    for(const key of ["input","output","cacheRead","cacheWrite","reasoning","total"] as const){const n=known.every(d=>d.usage[key]!==null)?known.reduce((n,d)=>n+d.usage[key]!,0):null;usage[key]=integer(n)?n:null;}
    usage.turns=known.reduce((n,d)=>n+d.usage.turns,0);usage.observedAt=Math.min(...known.map(d=>d.usage.observedAt!));
    usage.coverage=known.length<total||known.some(d=>d.usage.coverage==="partial")?"partial":"observed";
  }
  // Parent rosters can contain children also shown as cards; do not sum those rosters.
  return {usage,work:emptyDetail().work,coverage:"Observed main-agent usage; per-thread work rosters are not additive"};
}
