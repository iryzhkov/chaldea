// Existing-thread messaging. Public identities and durable local intent are transport independent.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { parseArgs } from "node:util";
import { TextDecoder } from "node:util";
import * as Schema from "effect/Schema";
import { ThreadId } from "../vendor/t3-contracts/src/index.ts";
import { readJson, onlyKeys } from "./config/files.ts";
import { MessageStore, WINDOW, type Receipt } from "./message-store.ts";

import { exchange, brokerConfig, mapping, distinctMappings, MAPPING_KEYS, type BrokerConfig, type Mapping } from "./message-broker.ts";

export const PROTOCOL="chaldea-message-v1";
export function requireMessage(ok:unknown,code:string):asserts ok { if(!ok)throw new Error(code); }
export function object(v:unknown,keys?:string[]):Record<string,unknown> {
  requireMessage(v && typeof v==="object" && !Array.isArray(v),"message_schema");
  if(keys)onlyKeys(v as Record<string,unknown>,keys); return v as Record<string,unknown>;
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
export interface Route extends Mapping {destinationHost:string;environment:string;threads:string[]}
export interface SenderConfig {callerId:string;sourceHost:string;database:string;broker:BrokerConfig;hosts:Record<string,Route>}
export const senderConfigPath=()=>join(homedir(),".config/chaldea/message.json");
export function senderConfig(file=senderConfigPath()):SenderConfig {
  const c=object(readJson(file,false,undefined,{owners:[0],private:true,maxBytes:65536}),["callerId","sourceHost","database","broker","hosts"]);
  const hosts=object(c.hosts),routes:Record<string,Route>=Object.create(null);
  requireMessage(Object.keys(hosts).length<=8,"message_routes");
  for(const [alias,value] of Object.entries(hosts)){
    name(alias);const h=object(value,["destinationHost","environment","threads",...MAPPING_KEYS]);
    routes[alias]={...mapping(h),destinationHost:name(h.destinationHost),environment:field(h.environment),threads:threads(h.threads)};
  }
  distinctMappings(Object.values(routes));
  return {callerId:name(c.callerId),sourceHost:name(c.sourceHost),database:path(c.database),broker:brokerConfig(c.broker),hosts:routes};
}
export const senderBinding=(c:SenderConfig)=>JSON.stringify(["sender",c.callerId,c.sourceHost]);
export function messageAvailable(file?:string):boolean {
  try{return Object.values(senderConfig(file).hosts).some(h=>h.threads.length>0);}catch{return false;}
}
export function messageTargets(c=senderConfig(),input:unknown={}) {
  object(input,[]);return Object.entries(c.hosts).filter(([,h])=>h.threads.length).map(([host,h])=>({host,threads:h.threads}));
}
export async function message(op:"send"|"status"|"recover",input:unknown,c=senderConfig(),now=Date.now()):Promise<Receipt> {
  const i=object(input,op==="send"?["host","threadId","requestId","text"]:["host","threadId","requestId"]);
  const h=c.hosts[name(i.host)];requireMessage(h && h.threads.includes(thread(i.threadId)),"message_route_unavailable");
  let r=request({v:1,op:op==="recover"?"status":op,host:h.destinationHost,environment:h.environment,threadId:i.threadId,requestId:i.requestId,
    ...(op==="send"?{text:i.text}:{})});
  const ids=identity(c.callerId,c.sourceHost,r);
  // Hold the nonblocking lock only for journal transactions, never across a network wait.
  let s=new MessageStore(c.database,senderBinding(c));
  try {
    const clock=s.maintain(now),row=s.get(ids.commandId);
    if(op==="recover"){
      requireMessage(row,"message_recovery_unavailable");
      if(row.state!=="accepted"&&row.state!=="rejected"){
        requireMessage(row.payload,"message_recovery_unavailable");
        r=decodeRequest(Buffer.from(row.payload));
      }
      requireMessage(identity(c.callerId,c.sourceHost,r).commandId===ids.commandId,"message_identity");
    }
    if(r.op==="send"){
      if(row && row.hash!==requestHash(r))return {...ids,state:"conflict",error:"message_conflict"};
      requireMessage((row?.state==="accepted"||row?.state==="rejected")||(clock&&inWindow(r,now)),"message_expired_or_clock");
      if(!row)s.begin({id:ids.commandId,caller:c.callerId,hash:requestHash(r),stamp:Number(r.requestId.slice(0,13)),payload:JSON.stringify(r)},false,now);
      else if(row.state!=="accepted"&&row.state!=="rejected")s.retry(ids.commandId,c.callerId,now);
    }
  }finally{s.close();}
  let result:Receipt;
  try{result=await exchange(c,h,r);}
  catch{result={...ids,state:"uncertain",error:"message_transport"};}
  try{
    s=new MessageStore(c.database,senderBinding(c));
    try{
      const row=s.get(ids.commandId);
      if(row && row.state!=="accepted"&&row.state!=="rejected")s.finish(ids.commandId,result);
    }finally{s.close();}
  }catch{return {...ids,state:"uncertain",error:"message_state_write"};}
  return result;
}
export async function messageCli(args:readonly string[]):Promise<number>{
  const [op,...rest]=args;
  const {values:v,positionals}=parseArgs({args:rest,options:{host:{type:"string"},thread:{type:"string"},
    "request-id":{type:"string"},text:{type:"string"},config:{type:"string"},help:{type:"boolean",short:"h"}},strict:true,allowPositionals:true});
  requireMessage(positionals.length===0,"message_arguments");
  if(op==="serve"&&v.help){process.stdout.write("chaldea message serve --config PATH\n");return 0;}
  if(op==="serve"){requireMessage(Object.keys(v).every(k=>k==="config"),"message_arguments");await (await import("./message-receiver.ts")).runReceiver(v.config);return 0;}
  if(v.help||op==="--help"||op==="-h"){if(!messageAvailable(v.config)){process.stdout.write("No configured message routes.\n");return 0;}process.stdout.write("chaldea message send|status|recover --host HOST --thread THREAD --request-id ID [--text TEXT]\nchaldea message targets\n");return 0;}
  if(op==="targets"){requireMessage(Object.keys(v).every(k=>k==="config"),"message_arguments");process.stdout.write(JSON.stringify(messageTargets(senderConfig(v.config)))+"\n");return 0;}
  requireMessage(op==="send"||op==="status"||op==="recover","message_operation");
  requireMessage(op==="send"||v.text===undefined,"message_arguments");
  const result=await message(op,{host:v.host,threadId:v.thread,requestId:v["request-id"],...(op==="send"?{text:v.text}:{})},senderConfig(v.config));
  process.stdout.write(JSON.stringify(result)+"\n");return result.state==="accepted"?0:1;
}
