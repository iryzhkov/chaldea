// Disabled until an operator supplies protected configuration and enrollment.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { readTrustedFile } from "../config/files.ts";
import { boundedLog } from "../config/waits-log.ts";
import { body, callService } from "../waits/service.ts";
import { loadSessionPolicy, presetHash } from "../session/policy.ts";
import { connection, publish, pull, acknowledge } from "../message-broker.ts";
import { requireMessage as check } from "../message.ts";
import type { SessionStatus } from "../session/lifecycle.ts";
import { load, same, type Config } from "./config.ts";
import { authenticate } from "./protocol.ts";
import { Coordinator, WorkerJournal } from "./store.ts";
import { Worker } from "./worker.ts";

export function localWorker(c: Config,store: WorkerJournal,fresh:()=>Config): Worker {
  const rpc=(method:string,input:unknown)=>callService(c.socket!,method,input);
  return new Worker(store,c.caller!,{
    lookup:async input=>await rpc("chaldea_session_lookup",input) as SessionStatus | null,
    start:async input=>await rpc("chaldea_session_start",input) as SessionStatus,
    status:async id=>await rpc("chaldea_session_status",{id}) as SessionStatus,
  },()=>{
    same(c,fresh());
    const p=loadSessionPolicy(c.policy!,c.definition.environment).presets[c.definition.preset];
    check(p && presetHash(p)===c.definition.presetHash,"davinci_preset_changed");
  });
}
export async function ingress(c: Config,store: Coordinator,fresh:()=>Config) {
  const server=createServer(async(req,res)=>{
    const send=(code:number,value:unknown)=>{res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(value));};
    try {
      const headers=req.headers;
      const key=String(headers["davinci-key"]??""), delivery=String(headers["davinci-delivery"]??""),
        timestamp=String(headers["davinci-time"]??""), signed=String(headers["davinci-signature"]??"");
      const bytes=await body(req,4096);
      const current=fresh();same(c,current);
      check(Object.hasOwn(current.keys!,key),"davinci_webhook_refused");
      const keyBytes=readTrustedFile(current.keys![key]!,{secret:true,maxBytes:128});
      let secret:Buffer|undefined;
      try {
        const hex=keyBytes.toString("utf8").trim();check(/^[a-f0-9]{64}$/.test(hex),"davinci_key");
        secret=Buffer.from(hex,"hex");
        authenticate(secret,key,delivery,timestamp,(req.method??"")+" "+(req.url??"")+"\n"+bytes,signed,Date.now());
      } finally {keyBytes.fill(0);secret?.fill(0);}
      if(req.method==="POST" && req.url==="/webhook") {
        const a=store.webhook(delivery,bytes,Date.now(),current.definition.enabled);send(202,{id:a.id});return;
      }
      if(req.method==="GET" && bytes==="") {
        if(req.url==="/schedule") {send(200,store.scheduleStatus());return;}
        const match=/^\/jobs\/([a-f0-9]{64})$/.exec(req.url??"");
        if(match) {send(200,store.status(match[1]!));return;}
      }
      send(404,{error:"davinci_unknown_endpoint"});
    } catch(error) {
      const conflict=error instanceof Error && error.message==="davinci_delivery_conflict";
      send(conflict?409:403,{error:conflict?"davinci_delivery_conflict":"davinci_request_refused"});
    }
  });
  server.requestTimeout=10_000;server.headersTimeout=10_000;server.maxConnections=16;
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(c.port,"127.0.0.1",resolve);});
  return {port:(server.address() as {port:number}).port,async stop(){
    server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }};
}
export async function run(file: string,signal?: AbortSignal): Promise<void> {
  const c=load(file),report=boundedLog(c.logFile),stop=new AbortController();
  const halt=()=>stop.abort();process.once("SIGINT",halt);process.once("SIGTERM",halt);
  signal?.addEventListener("abort",halt,{once:true});if(signal?.aborted)halt();
  const fresh=()=>{const next=load(file);same(c,next);return next;};
  const store=c.role==="coordinator"?new Coordinator(c.database,c.definition):new WorkerJournal(c.database,c.definition);
  let http:Awaited<ReturnType<typeof ingress>>|undefined;
  try {
    if(store instanceof Coordinator)http=await ingress(c,store,fresh);
    const worker=store instanceof WorkerJournal?localWorker(c,store,fresh):undefined;
    report("davinci_started");
    while(!stop.signal.aborted) {
      let nc:Awaited<ReturnType<typeof connection>>|undefined;
      try {
        const current=fresh(),now=Date.now();
        store.maintain(now);
        if(store instanceof Coordinator)store.tick(now,current.definition.enabled);
        // Local T3 observation/recovery does not wait for a broker connection.
        if(worker)for(const row of store.active())await worker.recover(row.id,Date.now());
        nc=await connection(c.broker);
        if(store instanceof Coordinator) {
          for(const row of store.active().filter(r=>!r.result).slice(0,8))
            await publish(nc,c.broker,c.mapping,Buffer.from(row.assignment),randomUUID());
        } else {
          for(const row of store.rows().filter(r=>r.result && now-r.sent_at>=30_000)
            .sort((a,b)=>a.sent_at-b.sent_at).slice(0,8)) {
            await publish(nc,c.broker,c.mapping,Buffer.from(row.result!),randomUUID(),true);
            store.db.prepare("UPDATE work SET sent_at=? WHERE id=? AND seq=?").run(now,row.id,row.seq);
          }
        }
        const receipt=store instanceof Coordinator;
        const m=await pull(nc,c.broker,c.mapping,stop.signal,receipt);
        if(m) {
          let committed=false;
          try {
            check(m.subject===(receipt?c.mapping.receiptSubject:c.mapping.commandSubject),"davinci_subject");
            const bytes=new TextDecoder("utf-8",{fatal:true}).decode(m.data);
            if(store instanceof Coordinator)store.result(bytes);
            else {
              fresh(); // revoked/rebound configuration cannot authorize intake
              const row=(store as WorkerJournal).accept(bytes,Date.now());
              await worker!.recover(row.id,Date.now());
            }
            committed=true;
          } catch {report("davinci_delivery_retained");}
          // ACK only after durable local ownership/result. Failed deliveries expire
          // in the bounded broker; their originating journals retain recovery state.
          if(committed) {acknowledge(nc,c.broker,c.mapping,m,receipt);await nc.flush();}
        }
      } catch {report("davinci_cycle_deferred");}
      finally {await nc?.close();}
      if(!stop.signal.aborted)await sleep(5000,undefined,{signal:stop.signal}).catch(()=>{});
    }
  } finally {
    process.removeListener("SIGINT",halt);process.removeListener("SIGTERM",halt);signal?.removeEventListener("abort",halt);
    await http?.stop();store.close();report("davinci_stopped");
  }
}
export async function davinciCli(args: readonly string[]): Promise<number> {
  const {values,positionals}=parseArgs({args:[...args],allowPositionals:true,strict:true,
    options:{config:{type:"string"},help:{type:"boolean",short:"h"}}});
  if(values.help) {process.stdout.write("chaldea davinci serve --config /etc/chaldea/davinci-ROLE.json\n");return 0;}
  check(positionals.length===1 && positionals[0]==="serve" && values.config,"davinci_explicit_config_required");
  await run(values.config);return 0;
}
