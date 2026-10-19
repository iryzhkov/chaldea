import { randomBytes } from "node:crypto";
import { dirname,isAbsolute,join,parse,resolve } from "node:path";
import { paths } from "../config/paths.ts";
import { validateHeadroom } from "../quota/headroom.ts";
import { lstatSync } from "node:fs";
import { readJson,onlyKeys,privateFile,readTrustedFile } from "../config/files.ts";
import { strictJson } from "../access/token.ts";
import { atomicWrite } from "../fs/atomic.ts";
import { discoverServerUrl } from "../t3/adapter.ts";
import { MissionModel } from "./model.ts";
import { runSource } from "./source.ts";
import { captureSnapshot,HOSTS } from "./contract.ts";
export interface CaptureConfig {host:string;t3BaseDir:string;tokenFile:string;snapshotFile:string;tokenSemanticsQualified:boolean}
export function captureConfig(path:string):CaptureConfig {
  const raw=readJson(path,false,strictJson);onlyKeys(raw,["host","t3BaseDir","tokenFile","snapshotFile","tokenSemanticsQualified"]);
  const c={tokenSemanticsQualified:false,...raw} as unknown as CaptureConfig;
  if(!HOSTS.includes(c.host as typeof HOSTS[number])||![c.t3BaseDir,c.tokenFile,c.snapshotFile].every(p=>typeof p==="string"&&isAbsolute(p))||typeof c.tokenSemanticsQualified!=="boolean")throw new Error("invalid_capture_config");
  return c;
}
/** Read only observer state under the actual capture UID, never T3 credentials. */
export function readCaptureQuota(model:MissionModel,path=join(paths().state,"quota-observer.json")):void {
  try{
    const uid=process.geteuid?.()??-1,dir=dirname(path),parent=lstatSync(dir);
    if(!parent.isDirectory()||parent.isSymbolicLink()||parent.uid!==uid||(parent.mode&0o777)!==0o700)throw new Error("unsafe_quota_directory");
    let p=resolve(dir);while(p!==parse(p).root){if(lstatSync(p).isSymbolicLink())throw new Error("quota_symlink");p=dirname(p);}
    const stat=lstatSync(path);if((stat.mode&0o777)!==0o600)throw new Error("unsafe_quota_file");
    const raw=strictJson(readTrustedFile(path,{secret:true,owners:[uid],maxBytes:8*1024*1024})) as Record<string,unknown>;
    if(![2,3,4,5].includes(Number(raw.version)))throw new Error("invalid_observer_version");
    model.setQuota(raw.headroom===undefined?null:validateHeadroom(raw.headroom));
  }catch{model.setQuota(null,true);}
}
export async function runCapture(c:CaptureConfig,signal:AbortSignal):Promise<void> {
  const model=new MissionModel(),epoch=randomBytes(16).toString("hex");let sequence=0,dirty=true;
  const parent=lstatSync(dirname(c.snapshotFile));
  if(!parent.isDirectory()||parent.isSymbolicLink()||(parent.mode&0o077)!==0)throw new Error("unsafe_capture_directory");
  const unsubscribe=model.subscribe(()=>{dirty=true;});
  const timer=setInterval(()=>{
    if(!dirty&&model.snapshot().source.state!=="live")return;
    try{readCaptureQuota(model);const s=captureSnapshot(model,c.host,epoch,sequence+1,c.tokenSemanticsQualified);if(s){atomicWrite(c.snapshotFile,JSON.stringify(s));sequence++;dirty=false;}}
    catch{/* Keep the last bounded file and retry at the next fixed cadence. */}
  },5000);
  try{await runSource(model,()=>{
    const url=discoverServerUrl(c.t3BaseDir);if(!url)throw new Error("source_unavailable");
    const u=new URL(url);if(u.protocol!=="http:"||u.hostname!=="127.0.0.1"||u.username||u.password)throw new Error("local_source_required");
    return {serverUrl:url,token:privateFile(c.tokenFile)};
  },signal);if(!signal.aborted)throw new Error("capture_source_stopped");}finally{clearInterval(timer);unsubscribe();}
}
