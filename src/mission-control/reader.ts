import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readJson,onlyKeys } from "../config/files.ts";
import { strictJson } from "../access/token.ts";
import { helperToken } from "../events/publisher.ts";
import { validateEnvelope } from "../akasha/schema.ts";
import { validateHostSnapshot,statusIdentity,validateOperations,emptyOperations } from "./contract.ts";
import { emptyCache,loadCache,mergeStatus,writeCache,type StatusCache } from "./cache.ts";
export interface ReaderConfig {url:string;tokenHelper:string;source:"mission-control-reader";host:"omarchy-normandy";profile:"mission-control-reader";project:"chaldea";allowedSourceIds:string[];cacheFile:string;refreshMs:5000;operationsEnabled?:boolean}
export function readerConfig(path:string):ReaderConfig {
  const c=readJson(path,false,strictJson);onlyKeys(c,["url","tokenHelper","source","host","profile","project","allowedSourceIds","cacheFile","refreshMs","operationsEnabled"]);
  if(c.operationsEnabled!==undefined&&typeof c.operationsEnabled!=="boolean")throw new Error("invalid_reader_config");
  const u=new URL(String(c.url)),ids=c.allowedSourceIds;
  if(u.protocol!=="https:"||u.username||u.password||u.search||u.hash||u.pathname!=="/"||c.source!=="mission-control-reader"||c.host!=="omarchy-normandy"||c.profile!=="mission-control-reader"||c.project!=="chaldea"||c.refreshMs!==5000||!isAbsolute(String(c.tokenHelper))||!isAbsolute(String(c.cacheFile))||!Array.isArray(ids)||!ids.length||ids.length>4||new Set(ids).size!==ids.length||!ids.every(s=>typeof s==="string"&&/^(agent-a|agent-b|omarchy-pc|omarchy-macbook-air-igor)--mission-control$/.test(s)))throw new Error("invalid_reader_config");
  return c as unknown as ReaderConfig;
}
export interface ReaderDependencies {fetch?:typeof fetch;token?:(kind?:"job_finished"|"report")=>Promise<string>;now?:()=>number}
async function responseJson(response:Response,max=2*1024**2):Promise<unknown>{
  const reader=response.body?.getReader();if(!reader)throw new Error("missing_body");
  const chunks:Uint8Array[]=[];let bytes=0;
  try{while(true){const c=await reader.read();if(c.done)break;bytes+=c.value.length;if(bytes>max)throw new Error("response_limit");chunks.push(c.value);}}finally{void reader.cancel().catch(()=>{});}
  return strictJson(Buffer.concat(chunks));
}
/** One fixed latest-120-second query per refresh. Pagination never changes its cursor binding. */
export async function refreshStatus(c:ReaderConfig,previous:StatusCache,dependencies:ReaderDependencies={}):Promise<StatusCache>{
  const now=(dependencies.now??Date.now)(),next=structuredClone(previous),signal=AbortSignal.timeout(5000);
  next.snapshots=next.snapshots.filter(s=>now>=s.observedAt&&now-s.observedAt<=86400_000&&c.allowedSourceIds.includes(s.host+"--mission-control"));
  try {
    const token=await(dependencies.token?dependencies.token():helperToken(c.tokenHelper,{key:"",source:c.source,host:c.host,payload:{kind:"agent_status"}},"read"));
    const url=new URL("/api/v1/events",c.url);url.searchParams.set("kind","agent_status");url.searchParams.set("project","chaldea");
    url.searchParams.set("from",new Date(now-120_000).toISOString());url.searchParams.set("to",new Date(now).toISOString());url.searchParams.set("limit","128");
    let reset=false;const seen=new Set<string>(),candidate=structuredClone(next);
    // This flag describes the current traversal, not an irreversible outage history.
    candidate.gap=false;
    for(let page=0;page<4;page++){
      const response=await(dependencies.fetch??fetch)(url,{redirect:"error",headers:{authorization:"Bearer "+token},signal});
      if(response.status===410&&!reset){await response.body?.cancel();url.searchParams.delete("cursor");candidate.gap=true;reset=true;continue;}
      if(!response.ok)throw new Error("reader_unavailable");
      const raw=await responseJson(response);
      if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("invalid_page");
      const v=raw as Record<string,unknown>;
      if(Object.keys(v).length!==2||!Array.isArray(v.events)||v.events.length>128)throw new Error("invalid_page");
      for(const item of v.events){
        const e=validateEnvelope(item),s=validateHostSnapshot(e.data.snapshot);
        if(e.kind!=="agent_status"||e.provenance.type!=="verified"||!c.allowedSourceIds.includes(e.source_id)||!statusIdentity(e,s)||Date.parse(e.received_at)>now||now-s.observedAt>3600_000)throw new Error("unauthorized_status");
        mergeStatus(candidate,s,now);
      }
      if(v.next_cursor===null){candidate.gap ||= candidate.snapshots.some(s=>s.truncated);return candidate;}
      if(typeof v.next_cursor!=="string"||v.next_cursor.length>1024||!/^[A-Za-z0-9_-]+$/.test(v.next_cursor)||seen.has(v.next_cursor))throw new Error("invalid_cursor");
      seen.add(v.next_cursor);url.searchParams.set("cursor",v.next_cursor);
    }
  }catch{/* Retain last good observations, never replace their observation time with fetch time. */}
  next.gap=true;return next;
}
/** Independent 60-second read. Failure preserves observation times and last good data. */
export async function refreshOperations(c:ReaderConfig,previous:StatusCache,dependencies:ReaderDependencies={}):Promise<NonNullable<StatusCache["operations"]>>{
  const now=(dependencies.now??Date.now)(),next=structuredClone(previous.operations??emptyOperations());
  await Promise.all((["job_finished","report"] as const).map(async kind=>{
    try{
      const token=await(dependencies.token?dependencies.token(kind):helperToken(c.tokenHelper,{key:"",source:c.source,host:c.host,payload:{kind}},"read"));
      const url=new URL("/api/v1/events",c.url);url.searchParams.set("mission_control_operations",kind);url.searchParams.set("window","48h");url.searchParams.set("limit","16");
      const response=await(dependencies.fetch??fetch)(url,{redirect:"error",headers:{authorization:"Bearer "+token},signal:AbortSignal.timeout(5000)});
      if(!response.ok){await response.body?.cancel();throw new Error("operations_unavailable");}
      const page=validateOperations(await responseJson(response,64*1024),now);
      const selected=kind==="job_finished"?page.events:page.ops.dailyHealth;
      if(selected.state!=="cached"||selected.checkedAt===null||now-selected.checkedAt>60_000)throw new Error("invalid_operation_check");
      if(kind==="job_finished")next.events=page.events;else next.ops.dailyHealth=page.ops.dailyHealth;
    }catch{if(kind==="job_finished"){next.events.state="error";next.events.checkedAt=now;}else{next.ops.dailyHealth.state="error";next.ops.dailyHealth.checkedAt=now;}}
  }));
  return next;
}
export async function runReader(c:ReaderConfig,signal:AbortSignal):Promise<void>{
  let cache=emptyCache();try{cache=loadCache(c.cacheFile);}catch{}
  let operationRead:Promise<void>|undefined,nextOperation=0;
  while(!signal.aborted){
    const refreshed=await refreshStatus(c,cache);if(cache.operations)refreshed.operations=cache.operations;cache=refreshed;
    if(c.operationsEnabled===true&&!operationRead&&Date.now()>=nextOperation){
      nextOperation=Date.now()+60_000;
      operationRead=refreshOperations(c,cache).then(operations=>{cache.operations=operations;}).finally(()=>{operationRead=undefined;});
    }
    writeCache(c.cacheFile,cache);
    if(!signal.aborted)await delay(c.refreshMs,undefined,{signal}).catch(()=>{});
  }
  await operationRead;
}
