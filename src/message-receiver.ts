// One bounded forced-command process. No listener and no arbitrary T3 operation.
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { readJson, privateFile } from "./config/files.ts";
import { withClient, dispatchChaldeaWake, WakeRejectedError } from "./t3/adapter.ts";
import { MessageStore, type Receipt } from "./message-store.ts";
import { PROTOCOL, object, name, path, field, threads, requireMessage, decodeRequest, identity, requestHash, inWindow, type Request } from "./message.ts";

export interface Caller {sourceHost:string;sourceAddresses:string[];threads:string[]}
export interface ReceiverConfig {host:string;environment:string;loopbackT3Url:string;tokenFile:string;database:string;callers:Record<string,Caller>}
export const receiverBinding=(c:ReceiverConfig)=>JSON.stringify(["receiver",c.host,c.environment]);
export function receiverConfig(file:string):ReceiverConfig {
  const c=object(readJson(file,false,undefined,{owners:[0],maxBytes:65536}),["host","environment","loopbackT3Url","tokenFile","database","callers"]);
  const url=new URL(field(c.loopbackT3Url));
  requireMessage(url.protocol==="http:" && ["127.0.0.1","[::1]"].includes(url.hostname) &&
    !url.username && !url.password && url.pathname==="/" && !url.search && !url.hash,"message_t3_url");
  const callers=object(c.callers);
  requireMessage(Object.keys(callers).length<=8,"message_callers");
  const entries:Record<string,Caller>=Object.create(null);
  for(const [id,value] of Object.entries(callers)){
    name(id);const a=object(value,["sourceHost","sourceAddresses","threads"]);
    requireMessage(Array.isArray(a.sourceAddresses) && a.sourceAddresses.length>0 && a.sourceAddresses.length<=8 &&
      a.sourceAddresses.every(ip=>typeof ip==="string" && isIP(ip)),"message_source_addresses");
    entries[id]={sourceHost:name(a.sourceHost),sourceAddresses:a.sourceAddresses as string[],threads:threads(a.threads)};
  }
  return {host:name(c.host),environment:field(c.environment),loopbackT3Url:url.origin,tokenFile:path(c.tokenFile),database:path(c.database),callers:entries};
}
export interface Context {caller:string;originalCommand:string;connection:string}
export function authorize(c:ReceiverConfig,x:Context,r?:Request):Caller {
  requireMessage(x.originalCommand===PROTOCOL,"message_command");
  const peer=x.connection.split(" ");
  requireMessage(peer.length===4 && isIP(peer[0]!) && isIP(peer[2]!) &&
    peer.filter((_,i)=>i%2===1).every(p=>/^\d{1,5}$/.test(p) && Number(p)>0 && Number(p)<=65535),"message_peer");
  const a=c.callers[name(x.caller)];
  requireMessage(a && a.sourceAddresses.includes(peer[0]!),"message_caller");
  if(r)requireMessage(r.host===c.host && r.environment===c.environment && a.threads.includes(r.threadId),"message_acl");
  return a;
}
export interface TargetT3 {preflight(threadId:string):Promise<boolean>;dispatch(payload:string):Promise<void>}
export function localT3(c:ReceiverConfig):TargetT3 {
  // Called only after command, peer, schema and ACL checks.
  const token=privateFile(c.tokenFile);
  const checked=async()=>{
    const opts={serverUrl:c.loopbackT3Url,token,signal:AbortSignal.timeout(5000)};
    const environment=await withClient(opts,client=>client["server.getConfig"]({}).pipe(
      Effect.map(config=>String(config.environment.environmentId)),Effect.timeout("5 seconds")));
    requireMessage(environment===c.environment,"message_environment");return opts;
  };
  return {
    async preflight(id) {
      // The shell snapshot has thread metadata only; no transcript or full projection.
      return withClient(await checked(),client=>client["orchestration.subscribeShell"]({}).pipe(
        Stream.take(1),Stream.runCollect,Effect.map(items=>{
          const first=items[0];
          return first?.kind==="snapshot" && first.snapshot.threads.some(t=>t.id===id && t.archivedAt===null && t.deletedAt===null);
        }),Effect.timeout("5 seconds")));
    },
    async dispatch(payload) {
      await dispatchChaldeaWake({serverUrl:c.loopbackT3Url,token,signal:AbortSignal.timeout(5000)},payload,c.environment);
    },
  };
}
export function payload(r:Request,caller:string,ids:ReturnType<typeof identity>):string {
  const bytes=JSON.stringify({type:"message.dispatch",...ids,threadId:r.threadId,
    text:"Chaldea message from "+caller+"\n"+r.text,createdBy:"agent",creationSource:"server",
    attachments:[],dispatchMode:{type:"queue_after_active"}});
  requireMessage(Buffer.byteLength(bytes)<=8192,"message_payload_size");return bytes;
}
export async function receive(r:Request,x:Context,c:ReceiverConfig,s:MessageStore,
  fresh:()=>ReceiverConfig,connect:(c:ReceiverConfig)=>TargetT3=localT3,now=Date.now()):Promise<Receipt> {
  const a=authorize(c,x,r),ids=identity(x.caller,a.sourceHost,r),hash=requestHash(r);
  const reply=(state:Receipt["state"],error?:string):Receipt=>({...ids,state,...(error?{error}:{})});
  const current=()=>{
    const next=fresh(),caller=authorize(next,x,r);
    requireMessage(receiverBinding(next)===receiverBinding(c) && next.database===c.database &&
      next.tokenFile===c.tokenFile && next.loopbackT3Url===c.loopbackT3Url && caller.sourceHost===a.sourceHost,"message_configuration_changed");
  };
  const clock=s.maintain(now,Object.keys(c.callers)),row=s.get(ids.commandId);
  if(r.op==="send" && row && row.hash!==hash)return reply("conflict","message_conflict");
  if(r.op==="status")return row?.result?JSON.parse(row.result):reply(row?"uncertain":"rejected",row?"message_uncertain":"message_not_found");
  if(row?.state==="accepted" || row?.state==="rejected")return JSON.parse(row.result!);
  requireMessage(clock,"message_clock_rollback");
  if(!inWindow(r,now))return reply(row?"uncertain":"rejected","message_expired");
  if(row)requireMessage(row.payload!==null,"message_expired");
  const bytes=row?.payload??payload(r,x.caller,ids);
  // Exact immutable intent is committed before reading T3 credentials or dispatch.
  if(!row)s.begin({id:ids.commandId,caller:x.caller,hash,stamp:Number(r.requestId.slice(0,13)),payload:bytes},true,now);
  else s.retry(ids.commandId,x.caller,now,true);
  let result:Receipt;
  try {
    const t3=connect(c);
    if(!await t3.preflight(r.threadId)) {
      result=reply("rejected","message_target_unavailable");
    } else {
      current(); // Re-read root-controlled ACL immediately before dispatch/replay.
      await t3.dispatch(bytes);
      result=reply("accepted");
    }
  } catch(e) {
    result=e instanceof WakeRejectedError?reply("rejected","message_t3_rejected"):reply("uncertain","message_uncertain");
  }
  try{s.finish(ids.commandId,result);}
  catch{return reply("uncertain","message_state_write");}
  return result;
}
export function readBody(input:NodeJS.ReadableStream,timeout=5000):Promise<Buffer> {
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let n=0;
    const end=(error?:Error)=>{
      clearTimeout(timer);input.removeListener("data",data);input.removeListener("end",done);input.removeListener("error",fail);
      if(error){input.pause();reject(error);}else resolve(Buffer.concat(chunks));
    };
    const data=(chunk:Buffer|string)=>{const b=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);n+=b.length;
      if(n>8192)end(new Error("message_request_size"));else chunks.push(b);};
    const done=()=>end(),fail=()=>end(new Error("message_input"));
    const timer=setTimeout(()=>end(new Error("message_eof_timeout")),timeout);
    input.on("data",data);input.once("end",done);input.once("error",fail);
  });
}
export async function receiverMain(args:readonly string[]):Promise<number> {
  // Fixed root-owned launcher argv only; no client-supplied flags or paths.
  requireMessage(args.length===2,"message_arguments");
  const [file,caller]=args as [string,string],c=receiverConfig(file);
  const x={caller,originalCommand:process.env.SSH_ORIGINAL_COMMAND??"",connection:process.env.SSH_CONNECTION??""};
  authorize(c,x);
  const s=new MessageStore(c.database,receiverBinding(c));
  try {
    const r=decodeRequest(await readBody(process.stdin)),a=authorize(c,x,r),ids=identity(caller,a.sourceHost,r);
    let result:Receipt;
    try {result=await receive(r,x,c,s,()=>receiverConfig(file));}
    catch {result={...ids,state:"rejected",error:"message_refused"};}
    process.stdout.write(JSON.stringify(result)+"\n");return 0;
  }finally{s.close();}
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const timer=setTimeout(()=>process.exit(1),20_000);
  try{process.exitCode=await receiverMain(process.argv.slice(2));}catch{process.exitCode=1;}
  finally{clearTimeout(timer);}
}
