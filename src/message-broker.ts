// Messaging-only JetStream transport. Provisioning is external; no management APIs.
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { checkServerIdentity, type PeerCertificate } from "node:tls";
import { connect, wsconnect, nkeys, nkeyAuthenticator, headers, createInbox, type NatsConnection, type Msg } from "@nats-io/transport-node";
import { jetstream } from "@nats-io/jetstream";
import { readTrustedFile } from "./config/files.ts";
import { senderJournal, type Receipt } from "./message-store.ts";
import { object, name, path, field, requireMessage, identity, senderBinding, type SenderConfig, type Route, type Request } from "./message.ts";

export interface BrokerConfig {url:string;account:string;seedFile:string;publicKey:string;inboxPrefix:string;commandStream:string;receiptStream:string}
export const MAPPING_KEYS=["commandSubject","receiptSubject","commandConsumer","receiptConsumer"] as const;
export interface Mapping {commandSubject:string;receiptSubject:string;commandConsumer:string;receiptConsumer:string}
function token(v:unknown):string {
  const s=field(v,64);requireMessage(/^[A-Za-z0-9_-]+$/.test(s),"message_broker_name");return s;
}
function subject(v:unknown,prefix:string):string {
  const s=field(v,256);requireMessage(s.startsWith(prefix+".")&&/^[A-Za-z0-9_.-]+$/.test(s)&&!s.includes("..")&&!s.endsWith("."),"message_subject");return s;
}
export function publicKey(v:unknown):string {
  const s=field(v,56);requireMessage(/^U[A-Z2-7]{55}$/.test(s),"message_public_key");return s;
}
export function brokerConfig(v:unknown,inboxNamespace="_INBOX_message"):BrokerConfig {
  const b=object(v,["url","account","seedFile","publicKey","inboxPrefix","commandStream","receiptStream"]);
  const u=new URL(field(b.url,2048)),account=token(b.account);
  requireMessage(!["CHALDEA","SYS"].includes(account)&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==="/","message_broker_account_url");
  requireMessage(["wss:","tls:"].includes(u.protocol)||(u.protocol==="nats:"&&["127.0.0.1","[::1]"].includes(u.hostname)),"message_broker_tls");
  const result={url:u.href,account,seedFile:path(b.seedFile),publicKey:publicKey(b.publicKey),
    inboxPrefix:subject(b.inboxPrefix,inboxNamespace),commandStream:token(b.commandStream),receiptStream:token(b.receiptStream)};
  requireMessage(result.commandStream!==result.receiptStream,"message_stream_binding");return result;
}
export function mapping(v:Record<string,unknown>,commandNamespace="chaldea.message.command",receiptNamespace="chaldea.message.receipt"):Mapping {
  return {commandSubject:subject(v.commandSubject,commandNamespace),receiptSubject:subject(v.receiptSubject,receiptNamespace),
    commandConsumer:token(v.commandConsumer),receiptConsumer:token(v.receiptConsumer)};
}
export function distinctMappings(values:Mapping[]):void {
  for(const key of MAPPING_KEYS)requireMessage(new Set(values.map(v=>v[key])).size===values.length,"message_duplicate_mapping");
}
export const mappingBinding=(b:BrokerConfig,h:Mapping)=>JSON.stringify([b.account,b.url,b.commandStream,b.receiptStream,...MAPPING_KEYS.map(k=>h[k])]);
export const next=(stream:string,consumer:string)=>"$JS.API.CONSUMER.MSG.NEXT."+stream+"."+consumer;
export function attempt(v:unknown):string {
  const s=field(v,36);requireMessage(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(s),"message_attempt");return s;
}
export async function connection(b:BrokerConfig):Promise<NatsConnection> {
  let seed:Buffer|undefined;
  try{
    seed=Buffer.from(readTrustedFile(b.seedFile,{secret:true,maxBytes:1024}).toString("utf8").trim());
    const key=nkeys.fromSeed(Uint8Array.from(seed));
    try{requireMessage(key.getPublicKey()===b.publicKey,"message_broker_identity");}finally{key.clear();}
    const hostname=new URL(b.url).hostname.replace(/^\[|\]$/g,"");
    // NATS upgrades an existing socket. Pin certificate identity to the configured
    // URL even when the library has no DNS tlsName (for example an IP literal).
    const tls={rejectUnauthorized:true,servername:isIP(hostname)?undefined:hostname,
      checkServerIdentity:(_name:string,cert:PeerCertificate)=>checkServerIdentity(hostname,cert)};
    const options={servers:b.url,authenticator:nkeyAuthenticator(seed),inboxPrefix:b.inboxPrefix,reconnect:false,timeout:2000,...(b.url.startsWith("tls:")?{tls}:{})};
    return await(b.url.startsWith("wss:")?wsconnect(options):connect(options));
  }catch{throw new Error("message_broker_unavailable");}
  finally{seed?.fill(0);}
}
export async function publish(nc:NatsConnection,b:BrokerConfig,h:Mapping,data:Uint8Array,id:string,receipt=false):Promise<void> {
  const hdr=headers();hdr.set("Chaldea-Attempt",attempt(id));
  const ack=await jetstream(nc,{timeout:2000}).publish(receipt?h.receiptSubject:h.commandSubject,data,
    {headers:hdr,expect:{streamName:receipt?b.receiptStream:b.commandStream}});
  requireMessage(ack.stream===(receipt?b.receiptStream:b.commandStream),"message_puback");
}
export async function pull(nc:NatsConnection,b:BrokerConfig,h:Mapping,signal:AbortSignal,receipt=false):Promise<Msg|undefined> {
  if(signal.aborted)return;
  const inbox=createInbox(b.inboxPrefix),sub=nc.subscribe(inbox,{max:1,timeout:5000});
  const stop=()=>sub.unsubscribe();signal.addEventListener("abort",stop,{once:true});
  try{
    nc.publish(next(receipt?b.receiptStream:b.commandStream,receipt?h.receiptConsumer:h.commandConsumer),
      JSON.stringify({batch:1,expires:1e9}),{reply:inbox});
    for await(const m of sub){
      if(m.headers?.code && m.headers.code>=300){
        requireMessage([404,408,409].includes(m.headers.code),"message_pull_refused");return;
      }
      return m;
    }
  }catch(e){
    // nats-core subscription timers stop the iterator with TimeoutError.
    if(!(e instanceof Error&&(e.name==="TimeoutError"||e.message==="TIMEOUT")))throw e;
    return;
  }finally{signal.removeEventListener("abort",stop);sub.unsubscribe();}
}
export function acknowledge(nc:NatsConnection,b:BrokerConfig,h:Mapping,m:Msg,receipt=false,poison=false):void {
  const prefix="$JS.ACK."+(receipt?b.receiptStream:b.commandStream)+"."+(receipt?h.receiptConsumer:h.commandConsumer)+".";
  const reply=m.reply;requireMessage(reply && reply.startsWith(prefix),"message_ack_binding");
  nc.publish(reply,poison?"+TERM":"+ACK");
}
export function decodeReceipt(bytes:Uint8Array):Receipt {
  requireMessage(bytes.length<=2048,"message_receipt_size");
  const out=object(JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(bytes)),["state","commandId","messageId","error"]);
  requireMessage(["accepted","rejected","uncertain","conflict"].includes(String(out.state)),"message_receipt_state");
  const result:Receipt={state:out.state as Receipt["state"],commandId:field(out.commandId,128),messageId:field(out.messageId,128)};
  if(out.error!==undefined){result.error=field(out.error,1024);requireMessage(/^[a-z_]+$/.test(result.error),"message_receipt_error");}
  return result;
}
export async function exchange(c:SenderConfig,h:Route,r:Request):Promise<Receipt> {
  const id=randomUUID(),ids=identity(c.callerId,c.sourceHost,r),binding=mappingBinding(c.broker,h);
  const deadline=Date.now()+35000,signal=AbortSignal.timeout(35000);
  const store=<T>(fn:Parameters<typeof senderJournal<T>>[2])=>senderJournal(c.database,senderBinding(c),fn,Math.min(deadline,Date.now()+2000));
  await store(s=>s.reserve(id,ids.commandId,binding,deadline+5000,Date.now()));
  let nc:NatsConnection|undefined;
  try{
    nc=await connection(c.broker);
    await publish(nc,c.broker,h,Buffer.from(JSON.stringify(r)),id);
    while(!signal.aborted){
      const saved=await store(s=>s.attempt(id)?.result);
      if(saved)return decodeReceipt(Buffer.from(saved));
      const m=await pull(nc,c.broker,h,signal,true);if(!m)continue;
      let replyId:string,result:Receipt;
      try{
        requireMessage(m.subject===h.receiptSubject,"message_receipt_subject");
        replyId=attempt(m.headers?.get("Chaldea-Attempt"));result=decodeReceipt(m.data);
      }catch{acknowledge(nc,c.broker,h,m,true,true);continue;}
      const valid=await store(s=>{
          const pending=s.attempt(replyId);
          if(!pending||pending.expires<Date.now())return true;
          if(pending.binding!==binding||pending.command_id!==result.commandId||result.messageId!==result.commandId)return false;
          s.answer(replyId,result);return true; // A concurrent request may be the intended reader.
      });
      acknowledge(nc,c.broker,h,m,true,!valid);await nc.flush();
    }
    throw new Error("message_receipt_timeout");
  }finally{
    await nc?.close();
    try{await store(s=>s.forget(id));}catch{} // Expiry bounds cleanup even if the journal is busy.
  }
}
