// Existing-thread messaging. SSH and local journals are hidden behind send/status.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isIP } from "node:net";
import { parseArgs } from "node:util";
import { TextDecoder } from "node:util";
import * as Schema from "effect/Schema";
import { ThreadId } from "../vendor/t3-contracts/src/index.ts";
import { readJson, onlyKeys, readTrustedFile } from "./config/files.ts";
import { MessageStore, WINDOW, type Receipt } from "./message-store.ts";

export const PROTOCOL="chaldea-message-v1";
export function requireMessage(ok:unknown,code:string):asserts ok { if(!ok)throw new Error(code); }
export function object(v:unknown,keys:string[]):Record<string,unknown> {
  requireMessage(v && typeof v==="object" && !Array.isArray(v),"message_schema");
  onlyKeys(v as Record<string,unknown>,keys); return v as Record<string,unknown>;
}
export function field(v:unknown,max=512):string {
  requireMessage(typeof v==="string" && v.length>0 && Buffer.byteLength(v)<=max && !v.includes("\0") && v.isWellFormed(),"message_string");return v;
}
export function name(v:unknown):string {
  const s=field(v,128);requireMessage(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s),"message_name");return s;
}
export function path(v:unknown):string {
  const s=field(v,4096);requireMessage(isAbsolute(s) && !/\s/.test(s),"message_path");return s;
}
export function thread(v:unknown):string {
  const s=field(v);requireMessage(s===s.trim(),"message_thread");Schema.decodeUnknownSync(ThreadId)(s);return s;
}
export function threads(v:unknown):string[] {
  requireMessage(Array.isArray(v) && v.length<=32,"message_threads");return [...new Set(v.map(thread))];
}
export interface Request {v:1;op:"send"|"status";host:string;environment:string;threadId:string;requestId:string;text?:string}
export function request(input:unknown):Request {
  const r=object(input,["v","op","host","environment","threadId","requestId","text"]);
  requireMessage(r.v===1 && (r.op==="send" || r.op==="status"),"message_operation");
  const requestId=field(r.requestId,142);
  requireMessage(/^\d{13}:[A-Za-z0-9._-]{1,128}$/.test(requestId),"message_request_id");
  const result:Request={v:1,op:r.op,host:name(r.host),environment:field(r.environment),threadId:thread(r.threadId),requestId};
  if(r.op==="send")result.text=field(r.text,4096);
  else requireMessage(!Object.hasOwn(r,"text"),"message_status_text");
  requireMessage(Buffer.byteLength(JSON.stringify(result))<=8192,"message_request_size");return result;
}
export function decodeRequest(bytes:Buffer):Request {
  requireMessage(bytes.length<=8192,"message_request_size");
  try{return request(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)));}
  catch{throw new Error("message_request_invalid");}
}
function hash(parts:string[]):string {
  const h=createHash("sha256");
  for(const s of parts){const b=Buffer.from(s);const n=Buffer.alloc(4);n.writeUInt32BE(b.length);h.update(n).update(b);}
  return h.digest("hex");
}
export function identity(caller:string,source:string,r:Request) {
  const id=hash([PROTOCOL,caller,source,r.host,r.environment,r.threadId,r.requestId]);
  return {commandId:"chaldea-message:"+id,messageId:"chaldea-message:"+id};
}
export const requestHash=(r:Request)=>hash([r.host,r.environment,r.threadId,r.requestId,r.text??""]);
export const inWindow=(r:Request,now:number)=>Number(r.requestId.slice(0,13))>=now-WINDOW && Number(r.requestId.slice(0,13))<=now+300_000;
export interface Route {destinationHost:string;environment:string;address:string;port:number;keyFile:string;knownHostsFile:string;threads:string[]}
export interface SenderConfig {callerId:string;sourceHost:string;database:string;hosts:Record<string,Route>}
export const senderConfigPath=()=>join(homedir(),".config/chaldea/message.json");
export function senderConfig(file=senderConfigPath()):SenderConfig {
  const c=object(readJson(file,false,undefined,{owners:[0],maxBytes:65536}),["callerId","sourceHost","database","hosts"]);
  const hosts=object(c.hosts,Object.keys(object(c.hosts,Object.keys(c.hosts as object??{}))));
  requireMessage(Object.keys(hosts).length<=8,"message_routes");
  const routes:Record<string,Route>=Object.create(null);
  for(const [alias,value] of Object.entries(hosts)){
    name(alias); const h=object(value,["destinationHost","environment","address","port","keyFile","knownHostsFile","threads"]);
    const address=field(h.address,64);requireMessage(isIP(address)!==0,"message_address");
    requireMessage(Number.isInteger(h.port) && Number(h.port)>0 && Number(h.port)<=65535,"message_port");
    routes[alias]={destinationHost:name(h.destinationHost),environment:field(h.environment),address,port:Number(h.port),
      keyFile:path(h.keyFile),knownHostsFile:path(h.knownHostsFile),threads:threads(h.threads)};
  }
  return {callerId:name(c.callerId),sourceHost:name(c.sourceHost),database:path(c.database),hosts:routes};
}
export const senderBinding=(c:SenderConfig)=>JSON.stringify(["sender",c.callerId,c.sourceHost]);
export function messageAvailable():boolean {
  try{return Object.values(senderConfig().hosts).some(h=>h.threads.length>0);}catch{return false;}
}
export function sshArgs(h:Route):string[] {
  return ["-F","/dev/null","-T","-S","none","-p",String(h.port),"-i",h.keyFile,
    "-o","BatchMode=yes","-o","IdentitiesOnly=yes","-o","IdentityAgent=none",
    "-o","ClearAllForwardings=yes","-o","RequestTTY=no","-o","StrictHostKeyChecking=yes",
    "-o","UserKnownHostsFile="+h.knownHostsFile,"-o","GlobalKnownHostsFile=/dev/null",
    "-o","ControlMaster=no","-o","ControlPersist=no","-o","ConnectTimeout=10",
    "-o","ProxyCommand=none","-o","ProxyJump=none","-o","PermitLocalCommand=no",
    "chaldea-message@"+h.address,PROTOCOL];
}
export async function sshRequest(h:Route,r:Request):Promise<Receipt> {
  // Validate custody without returning credential bytes or inheriting agent/runtime env.
  readTrustedFile(h.keyFile,{secret:true,maxBytes:16384});
  readTrustedFile(h.knownHostsFile,{maxBytes:65536});
  return new Promise((resolve,reject)=>{
    const child=spawn("/usr/bin/ssh",sshArgs(h),{env:{PATH:"/usr/bin:/bin"},stdio:["pipe","pipe","ignore"]});
    let bytes=Buffer.alloc(0),overflow=false;
    const timer=setTimeout(()=>child.kill("SIGKILL"),35_000);
    child.stdin.on("error",()=>{});
    child.stdout.on("data",(b:Buffer)=>{if(bytes.length+b.length>32768){overflow=true;child.kill("SIGKILL");}else bytes=Buffer.concat([bytes,b]);});
    child.once("error",()=>{clearTimeout(timer);reject(new Error("message_transport"));});
    child.once("close",code=>{
      clearTimeout(timer);
      try{
        requireMessage(code===0 && !overflow,"message_transport");
        const out=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),["state","commandId","messageId","error"]);
        requireMessage(["accepted","rejected","uncertain","conflict"].includes(String(out.state)),"message_response");
        const receipt:Receipt={state:out.state as Receipt["state"],commandId:field(out.commandId,128),messageId:field(out.messageId,128)};
        if(out.error!==undefined) {const e=field(out.error,1024);requireMessage(/^[a-z_]+$/.test(e),"message_response");receipt.error=e;}
        resolve(receipt);
      }catch{reject(new Error("message_transport"));}
    });
    child.stdin.end(JSON.stringify(r));
  });
}
export async function message(op:"send"|"status",input:unknown,c=senderConfig(),
  transport=sshRequest,now=Date.now()):Promise<Receipt> {
  const i=object(input,op==="send"?["host","threadId","requestId","text"]:["host","threadId","requestId"]);
  const h=c.hosts[name(i.host)];requireMessage(h && h.threads.includes(thread(i.threadId)),"message_route_unavailable");
  const r=request({v:1,op,host:h.destinationHost,environment:h.environment,threadId:i.threadId,requestId:i.requestId,
    ...(op==="send"?{text:i.text}:{})});
  const ids=identity(c.callerId,c.sourceHost,r);
  const s=new MessageStore(c.database,senderBinding(c));
  try {
    const clock=s.maintain(now),row=s.get(ids.commandId),hash=requestHash(r);
    if(op==="send") {
      if(row && row.hash!==hash)return {...ids,state:"conflict",error:"message_conflict"};
      // Re-check remote ACL even for terminal local replay.
      requireMessage((row?.state==="accepted" || row?.state==="rejected") || (clock && inWindow(r,now)),"message_expired_or_clock");
      if(!row)s.begin({id:ids.commandId,caller:c.callerId,hash,stamp:Number(r.requestId.slice(0,13)),payload:JSON.stringify(r)},false,now);
      else if(row.state!=="accepted" && row.state!=="rejected")s.retry(ids.commandId,c.callerId,now);
    }
    let receipt:Receipt;
    try {
      receipt=await transport(h,r);
      requireMessage(receipt.commandId===ids.commandId && receipt.messageId===ids.messageId,"message_identity");
    } catch {receipt={...ids,state:"uncertain",error:"message_transport"};}
    if(op==="send" || row) {
      // Terminal results cannot be destroyed by a later network failure or ACL denial.
      if(row?.state!=="accepted" && row?.state!=="rejected")s.finish(ids.commandId,receipt);
    }
    return receipt;
  } finally {s.close();}
}
export async function messageCli(args:readonly string[]):Promise<number> {
  const [op,...rest]=args;requireMessage(op==="send"||op==="status","message_operation");
  const {values,positionals}=parseArgs({args:rest,options:{host:{type:"string"},thread:{type:"string"},
    "request-id":{type:"string"},text:{type:"string"},config:{type:"string"}},strict:true,allowPositionals:true});
  requireMessage(positionals.length===0 && (op==="send" || values.text===undefined),"message_arguments");
  const result=await message(op,{host:values.host,threadId:values.thread,requestId:values["request-id"],
    ...(op==="send"?{text:values.text}:{})},senderConfig(values.config));
  process.stdout.write(JSON.stringify(result)+"\n");return result.state==="accepted"?0:1;
}
