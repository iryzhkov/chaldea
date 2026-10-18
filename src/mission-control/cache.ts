import { lstatSync } from "node:fs";
import { dirname,isAbsolute } from "node:path";
import { readTrustedFile, readJson, onlyKeys } from "../config/files.ts";
import { strictJson } from "../access/token.ts";
import { atomicWrite } from "../fs/atomic.ts";
import { MissionModel } from "./model.ts";
import { validateHostSnapshot, object, exact, type HostSnapshot } from "./contract.ts";
export const CACHE_BYTES=512*1024, CACHE_AGE=86400_000;
export interface StatusCache {schema:"mission-control.cache.v1";gap:boolean;snapshots:HostSnapshot[]}
export const emptyCache=():StatusCache=>({schema:"mission-control.cache.v1",gap:false,snapshots:[]});
export function validateCache(raw:unknown):StatusCache {
  const v=object(raw);exact(v,["schema","gap","snapshots"]);
  if(v.schema!=="mission-control.cache.v1"||typeof v.gap!=="boolean"||!Array.isArray(v.snapshots)||v.snapshots.length>4)throw new Error("invalid_status_cache");
  const snapshots=v.snapshots.map(validateHostSnapshot);
  if(new Set(snapshots.map(s=>s.host)).size!==snapshots.length||Buffer.byteLength(JSON.stringify(v))>CACHE_BYTES)throw new Error("invalid_status_cache");
  return {schema:"mission-control.cache.v1",gap:v.gap,snapshots};
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
      if(!prior.tokens.qualified)s.tokens={qualified:false,output:null,rate:null,observedAt:null,coverage:"unknown"};
      else if(prior.tokens.coverage==="partial"||s.tokens.output!==null&&prior.tokens.output!==null&&s.tokens.output<prior.tokens.output)s.tokens.coverage="partial";
    } else cache.gap=true;
    cache.snapshots[i]=s;
  }else {if(cache.snapshots.length===4)throw new Error("source_limit");cache.snapshots.push(s);}
  return true;
}
export class CacheModel {
  private listeners=new Set<()=>void>();
  private cache:StatusCache=emptyCache();
  constructor(private readonly path:string,private readonly now:()=>number=Date.now){this.reload();}
  subscribe(fn:()=>void):()=>void {this.listeners.add(fn);return()=>{this.listeners.delete(fn);};}
  reload():void {try{this.cache=loadCache(this.path,this.now());}catch{this.cache.gap=true;}for(const fn of this.listeners)fn();}
  snapshot():ReturnType<MissionModel["snapshot"]>{
    const now=this.now(),base=new MissionModel(false,this.now).snapshot();
    const snapshots=this.cache.snapshots.filter(s=>s.observedAt<=now&&now-s.observedAt<=CACHE_AGE);
    const freshness=(connected:boolean,at:number|null,stale=30_000,lost=300_000)=>at===null?"nosource":now-at>lost?"lost":now-at>stale?"stale":connected?"live":"disconnected";
    base.agents=snapshots.flatMap(s=>s.agents.map(a=>({id:s.host+"-"+a.id,title:"Task",model:a.model==="unknown"?"Model unknown":a.model,host:s.host,state:a.state,startedAt:a.startedAt,observedAt:a.observedAt,detailObservedAt:a.detailObservedAt,
      freshness:freshness(s.connected,s.observedAt),activityFreshness:freshness(a.connected,a.detailObservedAt,60_000,600_000),steps:[...a.steps]}))).slice(0,48);
    base.shown=base.agents.length;base.total=snapshots.length&&snapshots.every(s=>s.total!==null)?snapshots.reduce((n,s)=>n+s.total!,0):null;
    base.truncated=this.cache.gap||snapshots.some(s=>s.truncated)||snapshots.reduce((n,s)=>n+s.agents.length,0)>48;
    const observedAt=snapshots.length?Math.min(...snapshots.map(s=>s.observedAt)):null;
    base.source={state:freshness(snapshots.every(s=>s.connected),observedAt),observedAt};
    const known=snapshots.length>0&&snapshots.every(s=>s.tokens.qualified&&s.tokens.output!==null);
    base.tokens={output:known?snapshots.reduce((n,s)=>n+s.tokens.output!,0):null,
      rate:known&&base.source.state==="live"&&snapshots.every(s=>s.tokens.rate!==null)?snapshots.reduce((n,s)=>n+s.tokens.rate!,0):null,
      observedAt:known?Math.min(...snapshots.map(s=>s.tokens.observedAt!)):null,
      coverage:this.cache.gap||snapshots.some(s=>s.tokens.coverage==="partial")?"partial":"observed",
      scope:known?"Latest observed process-epoch totals per enrolled source; replacement samples, no daily reconciliation."+ (this.cache.gap?" Delivery gap; known lower bound.":""):"Unknown: hosted token semantics are not qualified."};
    return base;
  }
}
export interface WebConfig {mode:"cache";siteOrigin:string;listen:"127.0.0.1";port:number;cacheFile:string}
export function webConfig(path:string):WebConfig {
  const c=readJson(path,false,strictJson);onlyKeys(c,["mode","siteOrigin","listen","port","cacheFile"]);
  const origin=new URL(String(c.siteOrigin));
  if(c.mode!=="cache"||c.listen!=="127.0.0.1"||origin.protocol!=="https:"||origin.origin!==c.siteOrigin||!Number.isInteger(c.port)||Number(c.port)<1024||Number(c.port)>65535||!isAbsolute(String(c.cacheFile)))throw new Error("invalid_web_config");
  return c as unknown as WebConfig;
}
