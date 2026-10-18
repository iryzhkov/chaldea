// Supervised, outbound-only existing-thread receiver. No remote T3 credential.
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { readJson, privateFile } from "./config/files.ts";
import { withClient, dispatchChaldeaWake, WakeRejectedError } from "./t3/adapter.ts";
import { MessageStore, WINDOW, type Receipt } from "./message-store.ts";
import { object, name, path, field, threads, requireMessage, decodeRequest, identity, requestHash, inWindow, type Request } from "./message.ts";
import { brokerConfig, mapping, distinctMappings, publicKey, MAPPING_KEYS, mappingBinding, connection, pull, publish, acknowledge, attempt, type BrokerConfig, type Mapping } from "./message-broker.ts";
import { backoff, sleep } from "./retry.ts";
import { boundedLog } from "./config/waits-log.ts";
export interface Caller extends Mapping {sourceHost:string;publisherKey:string;threads:string[]}
export interface ReceiverConfig {host:string;environment:string;loopbackT3Url:string;tokenFile:string;database:string;logFile:string;broker:BrokerConfig;callers:Record<string,Caller>}
export const receiverBinding=(c:ReceiverConfig)=>JSON.stringify(["receiver",c.host,c.environment]);
export function receiverConfig(file="/etc/chaldea/message-receiver.json"):ReceiverConfig {
  const c=object(readJson(file,false,undefined,{owners:[0],private:true,maxBytes:65536}),
    ["host","environment","loopbackT3Url","tokenFile","database","logFile","broker","callers"]);
  const url=new URL(field(c.loopbackT3Url));
  requireMessage(url.protocol==="http:" && ["127.0.0.1","[::1]"].includes(url.hostname) &&
    !url.username&&!url.password&&url.pathname==="/"&&!url.search&&!url.hash,"message_t3_url");
  const callers=object(c.callers),entries:Record<string,Caller>=Object.create(null);
  requireMessage(Object.keys(callers).length<=8,"message_callers");
  for(const [id,value] of Object.entries(callers)){
    name(id);const a=object(value,["sourceHost","publisherKey","threads",...MAPPING_KEYS]);
    entries[id]={...mapping(a),sourceHost:name(a.sourceHost),publisherKey:publicKey(a.publisherKey),threads:threads(a.threads)};
  }
  distinctMappings(Object.values(entries));
  requireMessage(new Set(Object.values(entries).map(a=>a.publisherKey)).size===Object.keys(entries).length,"message_duplicate_publisher");
  return {host:name(c.host),environment:field(c.environment),loopbackT3Url:url.origin,tokenFile:path(c.tokenFile),
    database:path(c.database),logFile:path(c.logFile),broker:brokerConfig(c.broker),callers:entries};
}
export interface Principal {caller:string;sourceHost:string;subject:string}
export function authorize(c:ReceiverConfig,x:Principal,r?:Request):Caller {
  const a=c.callers[name(x.caller)];
  requireMessage(a && a.sourceHost===x.sourceHost && a.commandSubject===x.subject,"message_caller");
  if(r)requireMessage(r.host===c.host&&r.environment===c.environment&&a.threads.includes(r.threadId),"message_acl");
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
export async function receive(r:Request,x:Principal,c:ReceiverConfig,s:MessageStore,
  fresh:()=>ReceiverConfig,connect:(c:ReceiverConfig)=>TargetT3=localT3,now=Date.now()):Promise<Receipt> {
  const a=authorize(c,x,r),ids=identity(x.caller,a.sourceHost,r),hash=requestHash(r);
  const reply=(state:Receipt["state"],error?:string):Receipt=>({...ids,state,...(error?{error}:{})});
  const current=()=>{
    const next=fresh(),caller=authorize(next,x,r);
    requireMessage(receiverBinding(next)===receiverBinding(c) && next.database===c.database &&
      next.tokenFile===c.tokenFile && next.loopbackT3Url===c.loopbackT3Url && caller.sourceHost===a.sourceHost && caller.publisherKey===a.publisherKey &&
      mappingBinding(next.broker,caller)===mappingBinding(c.broker,a),"message_configuration_changed");
  };
  try {
  const clock=s.maintain(now,Object.keys(c.callers)),row=s.get(ids.commandId);
  if(r.op==="send" && row && row.hash!==hash)return reply("conflict","message_conflict");
  if(r.op==="status")return row?.result?JSON.parse(row.result):reply("uncertain",row?"message_uncertain":"message_not_found");
  if(row?.state==="accepted" || row?.state==="rejected")return JSON.parse(row.result!);
  requireMessage(clock,"message_clock_rollback");
  if(!inWindow(r,now))return reply("uncertain","message_expired");
  if(row)requireMessage(row.payload!==null,"message_expired");
  const bytes=row?.payload??payload(r,x.caller,ids);
  // Exact immutable intent is committed before reading T3 credentials or dispatch.
  if(!row)s.begin({id:ids.commandId,caller:x.caller,hash,stamp:Number(r.requestId.slice(0,13)),payload:bytes},true,now);
  else s.retry(ids.commandId,x.caller,now,true);
  let result:Receipt;
  try {
    const t3=connect(c);
    if(!await t3.preflight(r.threadId)) {
      result=reply(row?"uncertain":"rejected","message_target_unavailable");
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
  } catch { return reply("uncertain","message_refused"); }
}
// One authenticated broker delivery. Stored attempt outcomes never automatically redispatch.
export async function deliver(nc:Awaited<ReturnType<typeof connection>>,c:ReceiverConfig,caller:string,s:MessageStore,
  fresh:()=>ReceiverConfig,signal:AbortSignal):Promise<boolean>{
  const a=c.callers[caller]!;
  const m=await pull(nc,c.broker,a,signal);if(!m)return false;
  let r:Request,id:string;
  try{
    requireMessage(m.subject===a.commandSubject,"message_command_subject");
    id=attempt(m.headers?.get("Chaldea-Attempt"));r=decodeRequest(Buffer.from(m.data));
  }catch{acknowledge(nc,c.broker,a,m,false,true);return true;}
  const x={caller,sourceHost:a.sourceHost,subject:m.subject},ids=identity(caller,a.sourceHost,r);
  const binding=JSON.stringify([mappingBinding(c.broker,a),requestHash(r),r.op]),now=Date.now();
  const prior=s.attempt(id);
  if(prior&&(prior.binding!==binding||prior.command_id!==ids.commandId)){
    acknowledge(nc,c.broker,a,m,false,true);return true;
  }
  let result:Receipt;
  try{
    const current=fresh();authorize(current,x,r);
    requireMessage(receiverBinding(current)===receiverBinding(c)&&current.database===c.database&&
      mappingBinding(current.broker,authorize(current,x))===mappingBinding(c.broker,a),"message_configuration_changed");
    if(prior){
      result=prior.result?JSON.parse(prior.result):{...ids,state:"uncertain",error:"message_uncertain"};
    }else{
      s.admit(caller,now); // Includes status; separate from the accepted T3 send bucket.
      // Status cannot dispatch and needs no attempt tombstone.
      if(r.op==="send")s.reserve(id,ids.commandId,binding,now+WINDOW+300000,now,true,caller);
      result=await receive(r,x,current,s,fresh);
    }
  }catch{result={...ids,state:"uncertain",error:"message_refused"};}
  if(s.attempt(id))s.answer(id,result);
  else{
    // No attempt means no dispatch barrier was crossed. Refusal/status can be
    // terminated even if its receipt stream is full: original intent stays uncertain.
    try{await publish(nc,c.broker,a,Buffer.from(JSON.stringify(result)),id,true);}
    finally{acknowledge(nc,c.broker,a,m,false,true);await nc.flush();}
    return true;
  }
  // No ACK on state/publication failure after a possible dispatch.
  await publish(nc,c.broker,a,Buffer.from(JSON.stringify(result)),id,true);
  acknowledge(nc,c.broker,a,m);await nc.flush();return true;
}
export async function runReceiver(file="/etc/chaldea/message-receiver.json",external?:AbortSignal):Promise<void>{
  const control=new AbortController(),stop=()=>control.abort();
  const signal=external?AbortSignal.any([external,control.signal]):control.signal;
  const initial=receiverConfig(file),s=new MessageStore(initial.database,receiverBinding(initial));
  let report:ReturnType<typeof boundedLog>;
  try{report=boundedLog(initial.logFile);}catch(e){s.close();throw e;}
  process.once("SIGTERM",stop);process.once("SIGINT",stop);
  let failures=0;
  const fresh=()=>{
    const c=receiverConfig(file);
    requireMessage(c.database===initial.database&&receiverBinding(c)===receiverBinding(initial),"message_configuration_changed");return c;
  };
  const maintenance=setInterval(()=>{try{s.maintain(Date.now(),Object.keys(fresh().callers));}catch{report("message_maintenance_refused");}},60000);
  try{
    while(!signal.aborted){
      const cycle=new AbortController(),currentSignal=AbortSignal.any([signal,cycle.signal]);
      let nc:Awaited<ReturnType<typeof connection>>|undefined;let workers:Promise<void>[]=[];
      try{
        const c=fresh();nc=await connection(c.broker);
        const active=nc;
        workers=Object.keys(c.callers).map(async caller=>{
          let callerFailures=0;
          while(!currentSignal.aborted&&!active.isClosed()){
            const current=fresh();
            requireMessage(JSON.stringify(current.broker)===JSON.stringify(c.broker)&&
              mappingBinding(c.broker,c.callers[caller]!)===mappingBinding(current.broker,current.callers[caller]!),"message_configuration_changed");
            try{if(await deliver(active,current,caller,s,fresh,currentSignal)){failures=0;callerFailures=0;}}
            catch{if(!currentSignal.aborted){report("message_caller_retry");await sleep(backoff(callerFailures),currentSignal);callerFailures=Math.min(callerFailures+1,7);}}
          }
        });
        if(!workers.length){await sleep(30000,currentSignal);continue;}
        await Promise.all(workers);
      }catch{if(!signal.aborted)report("message_broker_retry");}
      finally{cycle.abort();await nc?.close();await Promise.allSettled(workers);}
      if(!signal.aborted){await sleep(backoff(failures),signal);failures=Math.min(failures+1,7);}
    }
  }finally{clearInterval(maintenance);s.close();process.removeListener("SIGTERM",stop);process.removeListener("SIGINT",stop);}
}
