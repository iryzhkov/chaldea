import { assistantPreview, appThreadIdPreview, titlePreview, commandPreview, integer, validResources, safeProviderId, type Detail, type Resources } from "./details.ts";
export type WireDetail=Detail|{identity:Detail["identity"];fieldCoverage:"identity-only"};
export interface RichSnapshot {v:2|3;resources:Resources;details:{id:string;value:WireDetail}[];omitted:number}
const check=(v:unknown)=>{if(!v)throw new Error("invalid_host_detail");};
const obj=(v:unknown):Record<string,unknown>=>{check(v&&typeof v==="object"&&!Array.isArray(v));return v as Record<string,unknown>;};
const exact=(v:Record<string,unknown>,keys:string[])=>check(Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k)));
const enums=(v:unknown,values:string[])=>check(typeof v==="string"&&values.includes(v));
const nullableCount=(v:unknown)=>check(v===null||integer(v));
function preview(raw:unknown,limit:number):void {
 const p=obj(raw);exact(p,["text","state"]);enums(p.state,["reported","redacted","truncated","withheld","not-reported"]);
 check(p.text===null?["withheld","not-reported"].includes(String(p.state)):typeof p.text==="string"&&Buffer.byteLength(p.text)<=limit&&assistantPreview(p.text).state!=="withheld"&&!/[\u0000-\u001f\u007f-\u009f]/.test(p.text));
 check(p.text===null||!["withheld","not-reported"].includes(String(p.state)));
}
function idPreview(raw:unknown):void {const p=obj(raw);exact(p,["text","state"]);enums(p.state,["reported","truncated","withheld","not-reported"]);check(p.text===null?["withheld","not-reported"].includes(String(p.state)):typeof p.text==="string"&&Buffer.byteLength(p.text)<=256&&appThreadIdPreview(p.text).state!=="withheld"&&/^[A-Za-z0-9._:%/-]+$/.test(p.text));}
/** Optional producer metadata can fail closed without freezing the base snapshot. */
export function isolateDetail(value:Detail,at:number):WireDetail {
 const identity={identity:value.identity,fieldCoverage:"identity-only" as const};
 for(const candidate of [value.fieldCoverage==="identity-only"?identity:value,identity]){
  try{return validateRich({v:3,resources:{state:"unavailable",sample:null},details:[{id:"row",value:candidate}],omitted:0},new Set(["row"]),at).details[0]!.value;}catch{}
 }
 const withheld={text:null,state:"withheld" as const};
 return {identity:{title:withheld,appThreadId:withheld},fieldCoverage:"identity-only"};
}
export function validateRich(raw:unknown,ids:Set<string>,at:number):RichSnapshot {
 const r=obj(raw);exact(r,["v","resources","details","omitted"]);check((r.v===2||r.v===3)&&integer(r.omitted)&&Array.isArray(r.details)&&r.details.length<=48);
 const resources=obj(r.resources);exact(resources,["state","sample"]);enums(resources.state,["reported","unavailable","byte-budget"]);
 check(resources.state!=="reported"?resources.sample===null:validResources(resources.sample)&&resources.sample.sampledAt<=at);
 const seen=new Set<string>();
 for(const item of r.details as unknown[]){
  const row=obj(item);exact(row,["id","value"]);check(typeof row.id==="string"&&ids.has(row.id)&&!seen.has(row.id));seen.add(String(row.id));
  const d=obj(row.value);exact(d,d.fieldCoverage==="identity-only"?["identity","fieldCoverage"]:["identity","fieldCoverage","activity","assistant","commands","commandsOmitted","effort","usage","context","work",...(r.v===3?["provider","recent"]:[])]);
  enums(d.fieldCoverage,["full","identity-only"]);const identity=obj(d.identity);exact(identity,["title","appThreadId"]);preview(identity.title,160);const title=obj(identity.title);check(title.text===null||titlePreview(title.text).state!=="withheld");idPreview(identity.appThreadId);
  if(d.fieldCoverage==="identity-only")continue;
  if(r.v===3){
   if(d.provider!==null){const p=obj(d.provider);exact(p,["instanceId","driver"]);check(safeProviderId(p.instanceId)&&(p.driver===null||safeProviderId(p.driver)));}
   check(Array.isArray(d.recent)&&d.recent.length<=3);
   for(const raw of d.recent as unknown[]){const item=obj(raw);exact(item,["kind","preview","at","status"]);enums(item.kind,["assistant","command"]);enums(item.status,["running","completed","failed","cancelled","unknown"]);check(item.at===null||integer(item.at)&&item.at>0&&item.at<=at);preview(item.preview,item.kind==="command"?128:384);const p=obj(item.preview);check(p.text===null||(item.kind==="command"?commandPreview(p.text):assistantPreview(p.text)).text===p.text);}
  }
  check(d.activity===null||["thinking","working"].includes(String(d.activity)));
  preview(d.assistant,384);check(Array.isArray(d.commands)&&d.commands.length<=3);for(const c of d.commands as unknown[]){preview(c,128);const p=obj(c);check(p.text===null||commandPreview(p.text).text===p.text);}check(integer(d.commandsOmitted));
  const e=obj(d.effort);exact(e,["value","source"]);enums(e.source,["reported","configured","not-reported"]);
  check(e.source==="not-reported"?e.value===null:typeof e.value==="string"&&["none","minimal","low","medium","high","xhigh","max","ultra"].includes(e.value));
  const u=obj(d.usage);exact(u,["input","output","cacheRead","cacheWrite","reasoning","total","turns","coverage","observedAt","rate","windowSeconds","scope"]);
  for(const k of ["input","output","cacheRead","cacheWrite","reasoning","total"])nullableCount(u[k]);
  check(integer(u.turns)&&u.turns<=8&&u.rate===null&&u.windowSeconds===60&&u.scope==="main-agent observed turns");
  enums(u.coverage,["observed","partial","not-reported"]);check(u.observedAt===null||integer(u.observedAt)&&u.observedAt>0&&u.observedAt<=at);
  check(u.total===null||u.input!==null&&u.output!==null&&u.total===Number(u.input)+Number(u.output));
  check(u.cacheRead===null||u.input===null||Number(u.cacheRead)<=Number(u.input));check(u.cacheWrite===null||u.input===null||Number(u.cacheWrite)<=Number(u.input));
  check(u.reasoning===null||u.output===null||Number(u.reasoning)<=Number(u.output));
  if(u.coverage!=="not-reported")check(Number(u.turns)>0&&u.observedAt!==null);
  if(u.coverage==="observed")check(u.input!==null&&u.output!==null&&u.total!==null);
  if(u.coverage==="not-reported")check(u.turns===0&&u.observedAt===null&&["input","output","cacheRead","cacheWrite","reasoning","total"].every(k=>u[k]===null));
  if(d.context!==null){const c=obj(d.context);exact(c,["used","max"]);check(integer(c.used)&&(c.max===null||integer(c.max)&&c.max>0));}
  const w=obj(d.work);exact(w,["children","delegates","subagents","monitors","background","durableWaits","coverage"]);enums(w.coverage,["observed bounded roster","not-reported"]);
  nullableCount(w.monitors);nullableCount(w.background);check(w.durableWaits===null);
  for(const key of ["children","delegates","subagents"])if(w[key]!==null){const c=obj(w[key]);exact(c,["active","queued","completed"]);for(const v of Object.values(c))check(integer(v)&&v<=2176);}
 }
 check(Number(r.omitted)+(r.details as unknown[]).length===ids.size);
 return structuredClone(r) as unknown as RichSnapshot;
}
