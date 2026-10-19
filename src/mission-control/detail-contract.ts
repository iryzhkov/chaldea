import { assistantPreview, appThreadIdPreview, titlePreview, commandPreview, integer, validResources, safeProviderId, emptyDetail, type Preview, type Detail, type Resources } from "./details.ts";
export type SparsePreview={text?:string|null;state?:Preview["state"]};
export type SparseDetail=Partial<Pick<Detail,"fieldCoverage">> & {identity:{title:SparsePreview;appThreadId:SparsePreview}} & Partial<Omit<Detail,"identity"|"fieldCoverage"|"usage"|"work"|"assistant"|"commands"|"recent"|"provider">> & {assistant?:SparsePreview;commands?:SparsePreview[];recent?:{kind:"assistant"|"command";preview:SparsePreview;at?:number|null;status?:string}[];provider?:{instanceId:string;driver?:string|null}|null;usage?:Partial<Detail["usage"]>;work?:Partial<Detail["work"]>;assistantFromRecent?:number;recentOmitted?:number};
export type FullWireDetail=Detail|{identity:Detail["identity"];fieldCoverage:"identity-only"};
export type WireDetail=FullWireDetail|SparseDetail;
export interface RichSnapshot<D=WireDetail> {v:2|3|4;resources:Resources;details:{id:string;value:D}[];omitted:number}
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
export function isolateDetail(value:Detail,at:number):FullWireDetail {
 const identity={identity:value.identity,fieldCoverage:"identity-only" as const};
 for(const candidate of [value.fieldCoverage==="identity-only"?identity:value,identity]){
  try{return validateRich({v:3,resources:{state:"unavailable",sample:null},details:[{id:"row",value:candidate}],omitted:0},new Set(["row"]),at).details[0]!.value as FullWireDetail;}catch{}
 }
 const withheld={text:null,state:"withheld" as const};
 return {identity:{title:withheld,appThreadId:withheld},fieldCoverage:"identity-only"};
}
export function validateRich(raw:unknown,ids:Set<string>,at:number):RichSnapshot {
 const r=obj(raw);if(r.v===4){normalizeRich(raw,ids,at);return structuredClone(raw) as RichSnapshot;}
 exact(r,["v","resources","details","omitted"]);check((r.v===2||r.v===3)&&integer(r.omitted)&&Array.isArray(r.details)&&r.details.length<=48);
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

/** Only fixed detail objects have defaults. Arrays, previews and nullable objects stay exact. */
function sparseObject(raw:unknown,defaults:Record<string,unknown>):Record<string,unknown> {
 const value=obj(raw);check(Object.keys(value).every(k=>Object.hasOwn(defaults,k)));
 return {...defaults,...value};
}
function omitDefaults(value:Record<string,unknown>,defaults:Record<string,unknown>):Record<string,unknown> {
 return Object.fromEntries(Object.entries(value).filter(([k,v])=>JSON.stringify(v)!==JSON.stringify(defaults[k])));
}
function expandPreview(raw:unknown):Record<string,unknown> {
 const p=obj(raw);return sparseObject(p,{text:null,state:typeof p.text==="string"?"reported":"not-reported"});
}
function compactPreview(p:Preview):SparsePreview {
 return {...(p.text!==null?{text:p.text}:{}),...(p.state===(p.text===null?"not-reported":"reported")?{}:{state:p.state})};
}
/** Validate before expanding, and retain the sparse representation in every durable caller. */
export function normalizeRich(raw:unknown,ids:Set<string>,at:number):RichSnapshot<FullWireDetail> {
 const r=obj(raw);if(r.v!==4)return validateRich(raw,ids,at) as RichSnapshot<FullWireDetail>;
 exact(r,["v","resources","details","omitted"]);check(Array.isArray(r.details)&&r.details.length<=48);
 const details=(r.details as unknown[]).map(item=>{
  const row=obj(item);exact(row,["id","value"]);const d=obj(row.value);
  const identity=obj(d.identity);exact(identity,["title","appThreadId"]);const fullIdentity={title:expandPreview(identity.title),appThreadId:expandPreview(identity.appThreadId)};
  if(d.fieldCoverage==="identity-only"){exact(d,["identity","fieldCoverage"]);return {id:row.id,value:{...d,identity:fullIdentity}};}
  const defaults=emptyDetail();const allowed={...defaults,assistantFromRecent:null,recentOmitted:0};
  const expanded=sparseObject(d,allowed);check(Object.hasOwn(d,"identity")&&(d.fieldCoverage===undefined||d.fieldCoverage==="full"));
  delete expanded.assistantFromRecent;delete expanded.recentOmitted;expanded.identity=fullIdentity;
  if(Object.hasOwn(d,"assistant"))expanded.assistant=expandPreview(d.assistant);
  if(Object.hasOwn(d,"commands")){check(Array.isArray(d.commands)&&d.commands.length<=3);expanded.commands=(d.commands as unknown[]).map(expandPreview);}
  if(d.provider!==undefined&&d.provider!==null)expanded.provider=sparseObject(d.provider,{instanceId:null,driver:null});
  if(Object.hasOwn(d,"recent")){check(Array.isArray(d.recent)&&d.recent.length<=3);expanded.recent=(d.recent as unknown[]).map(raw=>{const item=obj(raw);check(Object.hasOwn(item,"kind")&&Object.hasOwn(item,"preview"));return {...sparseObject(item,{kind:null,preview:null,at:null,status:"unknown"}),preview:expandPreview(item.preview)};});}
  if(Object.hasOwn(d,"usage"))expanded.usage=sparseObject(d.usage,defaults.usage);
  if(Object.hasOwn(d,"work")){const work=sparseObject(d.work,defaults.work);for(const key of ["children","delegates","subagents"])if(work[key]!==null)work[key]=sparseObject(work[key],{active:0,queued:0,completed:0});expanded.work=work;}
  if(Object.hasOwn(d,"assistantFromRecent")){
   check(!Object.hasOwn(d,"assistant")&&integer(d.assistantFromRecent)&&Number(d.assistantFromRecent)<3);
   check(Array.isArray(expanded.recent));const recent=(expanded.recent as unknown[])[Number(d.assistantFromRecent)];
   const entry=obj(recent);check(entry.kind==="assistant");expanded.assistant=entry.preview;
  }
  if(Object.hasOwn(d,"recentOmitted"))check(integer(d.recentOmitted)&&Array.isArray(expanded.recent)&&Number(d.recentOmitted)+expanded.recent.length<=3);
  return {id:row.id,value:expanded};
 });
 const expanded=validateRich({v:3,resources:r.resources,details,omitted:r.omitted},ids,at) as RichSnapshot<FullWireDetail>;
 check(Buffer.byteLength(JSON.stringify(expanded))<=128*1024);
 // Coverage metadata describes dropped observations, never an actually unreported metric.
 expanded.details.forEach((row,i)=>{const omitted=obj((r.details as unknown[])[i]).value as SparseDetail;if(omitted.recentOmitted) (row.value as Detail).recentOmitted=omitted.recentOmitted;});
 return expanded;
}
export function compactDetail(value:FullWireDetail):WireDetail {
 if(value.fieldCoverage==="identity-only")return {fieldCoverage:"identity-only",identity:{title:compactPreview(value.identity.title as Preview),appThreadId:compactPreview(value.identity.appThreadId as Preview)}};
 const d=value as Detail,defaults=emptyDetail();
 const out=omitDefaults(d as unknown as Record<string,unknown>,defaults as unknown as Record<string,unknown>);
 out.identity={title:compactPreview(d.identity.title),appThreadId:compactPreview(d.identity.appThreadId)};delete out.fieldCoverage;
 if(out.assistant)out.assistant=compactPreview(d.assistant);
 if(out.commands)out.commands=d.commands.map(compactPreview);
 if(out.provider&&d.provider)out.provider=omitDefaults(d.provider,{instanceId:null,driver:null});
 if(out.recent)out.recent=(d.recent??[]).map(r=>({...omitDefaults(r,{kind:null,preview:null,at:null,status:"unknown"}),preview:compactPreview(r.preview)}));
 const usage=omitDefaults(d.usage,defaults.usage),work=omitDefaults(d.work,defaults.work);
 if(Object.keys(usage).length)out.usage=usage;else delete out.usage;
 for(const key of ["children","delegates","subagents"])if(work[key])work[key]=omitDefaults(work[key] as Record<string,unknown>,{active:0,queued:0,completed:0});
 if(Object.keys(work).length)out.work=work;else delete out.work;
 const index=(d.recent??[]).findIndex(r=>r.kind==="assistant"&&JSON.stringify(r.preview)===JSON.stringify(d.assistant));
 if(index>=0){delete out.assistant;out.assistantFromRecent=index;}
 return out as SparseDetail;
}
