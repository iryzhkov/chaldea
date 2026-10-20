import { lstatSync } from "node:fs";
import { dirname,isAbsolute } from "node:path";
import { readTrustedFile, readJson, onlyKeys } from "../config/files.ts";
import { strictJson } from "../access/token.ts";
import { atomicWrite } from "../fs/atomic.ts";
import { normalizeRich } from "./detail-contract.ts";
import { aggregateDetails,emptyDetail } from "./details.ts";
import { MissionModel,summarizeHost } from "./model.ts";
import { HOSTS,validateHostSnapshot, validateHostQuota,quotaAccounts,emptyOperations,validateOperations,object,exact,type HostSnapshot,type HostQuota,type OperationsDTO } from "./contract.ts";
export const CACHE_BYTES=512*1024, CACHE_AGE=86400_000;
export interface StatusCache {schema:"mission-control.cache.v1";gap:boolean;snapshots:HostSnapshot[];quotas?:{host:string;quota:HostQuota}[];operations?:OperationsDTO}
export const emptyCache=():StatusCache=>({schema:"mission-control.cache.v1",gap:false,snapshots:[]});
export function validateCache(raw:unknown):StatusCache {
  const v=object(raw);exact(v,["schema","gap","snapshots",...(Object.hasOwn(v,"quotas")?["quotas"]:[]),...(Object.hasOwn(v,"operations")?["operations"]:[])]);
  if(v.schema!=="mission-control.cache.v1"||typeof v.gap!=="boolean"||!Array.isArray(v.snapshots)||v.snapshots.length>4)throw new Error("invalid_status_cache");
  const snapshots=v.snapshots.map(validateHostSnapshot);
  if(snapshots.reduce((n,s)=>n+s.agents.length,0)>48||new Set(snapshots.map(s=>s.host)).size!==snapshots.length||Buffer.byteLength(JSON.stringify(v))>CACHE_BYTES)throw new Error("invalid_status_cache");
  if(v.quotas!==undefined){if(!Array.isArray(v.quotas)||v.quotas.length>4)throw new Error("invalid_quotas");const hosts=new Set();for(const raw of v.quotas){const r=object(raw);exact(r,["host","quota"]);if(!HOSTS.includes(r.host as typeof HOSTS[number])||hosts.has(r.host))throw new Error("invalid_quotas");hosts.add(r.host);validateHostQuota(r.quota,Date.now());}}
  return {schema:"mission-control.cache.v1",gap:v.gap,snapshots,...(v.quotas!==undefined?{quotas:structuredClone(v.quotas) as NonNullable<StatusCache["quotas"]>}:{}),...(v.operations!==undefined?{operations:validateOperations(v.operations)}:{})};
}
export function loadCache(path:string,now=Date.now()):StatusCache {
  // The web UID reads a distinct reader-owned file in a root-configured SGID directory.
  const uid=lstatSync(path).uid;
  const c=validateCache(strictJson(readTrustedFile(path,{maxBytes:CACHE_BYTES,private:true,owners:[0,uid]})));
  c.snapshots=c.snapshots.filter(s=>s.observedAt<=now&&now-s.observedAt<=CACHE_AGE);return c;
}
export function writeCache(path:string,cache:StatusCache):void {
  const parent=lstatSync(dirname(path));
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o022)!==0)throw new Error("unsafe_cache_directory");
  atomicWrite(path,JSON.stringify(validateCache(cache)),0o640);
}
export function mergeStatus(cache:StatusCache,raw:HostSnapshot,now=Date.now()):boolean {
  const s=validateHostSnapshot(raw);if(s.observedAt>now||now-s.observedAt>CACHE_AGE)return false;
  const i=cache.snapshots.findIndex(v=>v.host===s.host),prior=cache.snapshots[i];
  if(prior){
    if(s.epoch===prior.epoch?(s.sequence<=prior.sequence||s.observedAt<prior.observedAt):s.observedAt<=prior.observedAt)return false;
    if(s.epoch===prior.epoch){
      if(!prior.tokens.qualified||prior.tokens.coverage==="unknown"||!s.tokens.qualified||s.tokens.coverage==="unknown")s.tokens={qualified:prior.tokens.qualified&&s.tokens.qualified,output:null,rate:null,observedAt:null,coverage:"unknown"};
      else if(prior.tokens.coverage==="partial"||s.tokens.output!==null&&prior.tokens.output!==null&&s.tokens.output<prior.tokens.output)s.tokens.coverage="partial";
    } else cache.gap=true;
    cache.snapshots[i]=s;
  }else {if(cache.snapshots.length===4)throw new Error("source_limit");cache.snapshots.push(s);}
  if(s.quota?.state==="cached"){
    cache.quotas??=[];const q=cache.quotas.findIndex(q=>q.host===s.host),prior=cache.quotas[q];
    if(!prior||(s.quota.observedAt??0)>=(prior.quota.observedAt??0)){
      const row={host:s.host,quota:structuredClone(s.quota)};if(q<0)cache.quotas.push(row);else cache.quotas[q]=row;
    }
  }
  while(cache.snapshots.reduce((n,v)=>n+v.agents.length,0)>48){const largest=cache.snapshots.toSorted((a,b)=>b.agents.length-a.agents.length||a.host.localeCompare(b.host))[0]!;const removed=largest.agents.pop();largest.truncated=true;if(largest.rich){if(largest.rich.completionTimes)largest.rich.completionTimes=largest.rich.completionTimes.filter(([id])=>id!==removed?.id);largest.rich.details=largest.rich.details.filter(d=>d.id!==removed?.id);largest.rich.omitted=largest.agents.length-largest.rich.details.length;}}
  return true;
}
export class CacheModel {
  private listeners=new Set<()=>void>();
  private cache:StatusCache=emptyCache();
  private readonly bootSamples=new Map<string,{epoch:string;sequence:number;observedAt:number}>();
  private readonly warmSources=new Set<string>();
  private readonly path:string;
  private readonly now:()=>number;
  constructor(path:string,now:()=>number=Date.now){this.path=path;this.now=now;this.reload();}
  subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  reload():void {
    try{
      const cache=loadCache(this.path,this.now());
      for(const s of cache.snapshots){
        const boot=this.bootSamples.get(s.host);
        if(!boot)this.bootSamples.set(s.host,{epoch:s.epoch,sequence:s.sequence,observedAt:s.observedAt});
        else if(s.observedAt>boot.observedAt&&(s.epoch!==boot.epoch||s.sequence>boot.sequence))this.warmSources.add(s.host);
      }
      this.cache=cache;
    }catch{this.cache.gap=true;}
    for(const fn of this.listeners)fn();
  }
  snapshot():ReturnType<MissionModel["snapshot"]> & {sampled:true}{
    const now=this.now(),base=new MissionModel(false,this.now).snapshot();
    const snapshots=this.cache.snapshots.filter(s=>s.observedAt<=now&&now-s.observedAt<=CACHE_AGE).map(s=>{const {rich,...base}=s;return {...base,...(rich?{rich:{...normalizeRich(rich,new Set(s.agents.map(a=>a.id)),s.observedAt),v:rich.v}}:{})};});
    const freshness=(connected:boolean,at:number|null,stale=90_000,lost=600_000)=>at===null?"nosource":now-at>lost?"lost":now-at>stale?"stale":connected?"live":"disconnected";
    const publicDetail=(s:(typeof snapshots)[number],id:string)=>{
      const detail={...emptyDetail(),...s.rich?.details.find(d=>d.id===id)?.value};
      if(s.rich?.v===2){delete detail.provider;delete detail.recent;}
      return detail;
    };
    base.agents=snapshots.flatMap(s=>s.agents.map(a=>({id:s.host+"-"+a.id,title:s.rich?.details.find(d=>d.id===a.id)?.value.identity.title.text??"Task",model:a.model==="unknown"?"Model unknown":a.model,host:s.host,state:a.state,startedAt:a.startedAt,completedAt:s.rich?.completionTimes?.find(([id])=>id===a.id)?.[1]??null,observedAt:a.observedAt,detailObservedAt:a.detailObservedAt,
      freshness:freshness(s.connected,s.observedAt)==="live"&&!this.warmSources.has(s.host)?"cached":freshness(s.connected,s.observedAt),activityFreshness:s.connected&&a.connected&&this.warmSources.has(s.host)&&freshness(s.connected,s.observedAt)==="live"?"live":freshness(false,a.detailObservedAt,60_000,600_000),steps:[...a.steps],details:publicDetail(s,a.id),detailCoverage:s.rich?(s.rich.details.some(d=>d.id===a.id)?"reported":"byte-budget"):"legacy"}))).slice(0,48);
    base.hostSummary=HOSTS.map(host=>{
      const s=snapshots.find(s=>s.host===host);
      if(!s)return summarizeHost(host,[],null,false,null,"nosource",null);
      const state=freshness(s.connected,s.observedAt);
      const summary=summarizeHost(host,s.agents,s.total,s.truncated,s.observedAt,state==="live"&&!this.warmSources.has(host)?"cached":state,s.connected);
      summary.models=summary.models.map(m=>({...m,usage:aggregateDetails(s.agents.filter(a=>a.model===m.model).flatMap(a=>s.rich?.details.filter(d=>d.id===a.id).map(d=>({...emptyDetail(),...d.value}))??[]),m.count).usage}));
      return {...summary,resources:s.rich?.resources??{state:"unavailable" as const,sample:null},details:aggregateDetails(s.rich?.details.map(d=>({...emptyDetail(),...d.value}))??[],s.agents.length)};
    });
    base.shown=base.agents.length;base.total=snapshots.length&&snapshots.every(s=>s.total!==null)?snapshots.reduce((n,s)=>n+s.total!,0):null;
    base.truncated=this.cache.gap||snapshots.some(s=>s.truncated)||snapshots.reduce((n,s)=>n+s.agents.length,0)>48;
    const observedAt=snapshots.length?Math.min(...snapshots.map(s=>s.observedAt)):null;
    const sourceState=freshness(snapshots.every(s=>s.connected),observedAt);
    base.source={state:sourceState==="live"&&snapshots.some(s=>!this.warmSources.has(s.host))?"cached":sourceState,observedAt};
    const known=snapshots.length>0&&snapshots.every(s=>s.tokens.qualified&&s.tokens.output!==null);
    base.tokens={output:known?snapshots.reduce((n,s)=>n+s.tokens.output!,0):null,
      rate:known&&base.source.state==="live"&&snapshots.every(s=>s.tokens.rate!==null)?snapshots.reduce((n,s)=>n+s.tokens.rate!,0):null,
      observedAt:known?Math.min(...snapshots.map(s=>s.tokens.observedAt!)):null,
      coverage:!known?"unknown":this.cache.gap||snapshots.some(s=>s.tokens.coverage==="partial")?"partial":"observed",
      scope:known?"Latest observed process-epoch totals per enrolled source; replacement samples, no daily reconciliation."+ (this.cache.gap?" Delivery gap; known lower bound.":""):"Unknown: hosted token semantics are not qualified."};
    base.quota.hosts=HOSTS.map(host=>{
      const s=snapshots.find(s=>s.host===host),retained=this.cache.quotas?.find(q=>q.host===host)?.quota;
      const q=s?.quota?.state==="cached"?s.quota:retained??s?.quota;
      return {host,state:s?.quota?.state??(retained?"byte-budget":"unknown"),observedAt:q?.observedAt??null,omitted:s?.quota?.omitted??q?.omitted??0,accounts:q?quotaAccounts(q,now):[]};
    });
    base.quota.state=base.quota.hosts.some(q=>q.state==="error")?"error":base.quota.hosts.some(q=>q.state==="cached"||q.accounts.length)?"cached":"unknown";
    base.unavailable=base.unavailable.filter(x=>x!=="Events"&&x!=="Ops");
    const operations=this.cache.operations??emptyOperations();
    base.events=structuredClone(operations.events);base.ops=structuredClone(operations.ops);
    base.events.rows=base.events.rows.filter(r=>now-r.occurredAt<=48*3600_000);
    const report=base.ops.dailyHealth.report;if(report&&now-report.occurredAt>48*3600_000)base.ops.dailyHealth.report=null;
    const bytes=()=>Buffer.byteLength(JSON.stringify(base));
    while(bytes()>128*1024&&base.events.rows.length){base.events.rows.pop();base.events.truncated=true;}
    while(bytes()>128*1024&&base.ops.dailyHealth.report?.checks.length){base.ops.dailyHealth.report.checks.pop();base.ops.dailyHealth.report.omitted++;}
    for(const q of [...base.quota.hosts].reverse())while(bytes()>128*1024&&q.accounts.length){q.accounts.pop();q.omitted++;q.state="byte-budget";}
    for(const a of [...base.agents].reverse()){if(bytes()<=128*1024)break;a.details.recent=[];}
    for(const a of [...base.agents].reverse()){if(bytes()<=128*1024)break;a.details={...emptyDetail(),identity:a.details.identity,fieldCoverage:"identity-only"};a.detailCoverage="byte-budget";}
    return Object.assign(base,{sampled:true as const});
  }
}
export interface WebConfig {mode:"cache";siteOrigin:string;listen:"127.0.0.1";port:number;cacheFile:string}
export function webConfig(path:string):WebConfig {
  const c=readJson(path,false,strictJson);onlyKeys(c,["mode","siteOrigin","listen","port","cacheFile"]);
  const origin=new URL(String(c.siteOrigin));
  if(c.mode!=="cache"||c.listen!=="127.0.0.1"||origin.protocol!=="https:"||origin.origin!==c.siteOrigin||!Number.isInteger(c.port)||Number(c.port)<1024||Number(c.port)>65535||!isAbsolute(String(c.cacheFile)))throw new Error("invalid_web_config");
  return c as unknown as WebConfig;
}
