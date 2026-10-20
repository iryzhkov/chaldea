import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { WakeStore } from "../wake/store.ts";
import { WaitEngine, type EngineOptions } from "./engine.ts";
import { createWaitT3 } from "../t3/waits.ts";
import { discoverServerUrl } from "../t3/adapter.ts";
import { loadConfig, privateFile, type WaitConfig } from "./config.ts";
import { boundedLog } from "./log.ts";
import { object, text, waitDescription, type WaitInput } from "./types.ts";
import { loadSessionPolicy } from "../session/policy.ts";
import { createSessionT3 } from "../session/t3.ts";
import { CredentialRefusal } from "../session/credential.ts";

export async function body(req: IncomingMessage, limit=8192): Promise<string> {
  const parts:Buffer[]=[];let n=0;
  for await(const part of req){ n+=part.length; if(n>limit)throw new Error("Request exceeds cap");parts.push(part); }
  return Buffer.concat(parts).toString("utf8");
}
const equal=(a:string,b:string) => {
  const x=Buffer.from(a),y=Buffer.from(b);
  return x.length===y.length && timingSafeEqual(x,y);
};
const escape=(s:string) => s.replace(/[&<>"']/g,c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
function send(res:ServerResponse,code:number,value:unknown):void {
  res.writeHead(code,{"Content-Type":"application/json","Cache-Control":"no-store"});res.end(JSON.stringify(value));
}
async function listen(server:Server,options:Parameters<Server["listen"]>[0]):Promise<void>{
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(options,()=>{server.removeListener("error",reject);resolve();});});
}
async function reserve(socket:string,server:Server):Promise<void>{
  mkdirSync(dirname(socket),{recursive:true,mode:0o700});
  try { await listen(server,socket); }
  catch(error) {
    if((error as NodeJS.ErrnoException).code!=="EADDRINUSE")throw error;
    const alive=await new Promise<boolean>((resolve,reject)=>{
      const c=connect(socket);c.once("connect",()=>{c.destroy();resolve(true);});
      c.once("error",e=>{c.destroy();if(["ECONNREFUSED","ENOENT"].includes((e as NodeJS.ErrnoException).code??""))resolve(false);else reject(e);});
    });
    if(alive)throw new Error("Waits service is already running");
    const s=lstatSync(socket);
    if(!s.isSocket()||s.uid!==process.getuid?.())throw new Error("Unsafe stale socket");
    unlinkSync(socket);await listen(server,socket);
  }
  chmodSync(socket,0o600);
}
export async function startWaitService(config:WaitConfig, extras:Partial<EngineOptions>={}):Promise<{engine:WaitEngine;store:WakeStore;port:number;stop():Promise<void>}>{
  let engine:WaitEngine|undefined;
  const ipc=createServer(async(req,res)=>{
    try{
      if(req.method!=="POST"||req.url!=="/rpc"){send(res,404,{error:"Unknown endpoint"});return;}
      if(!engine){send(res,503,{error:"Starting"});return;}
      const v=object(JSON.parse(await body(req)));const input=object(v.input??{});
      if(v.method==="chaldea_session_headers"){
        // Native helper path only; MCP never lists or forwards it. The reply is the header or a fixed refusal code.
        let headers:{Authorization:string};
        try{headers=await engine.sessionHeaders(input);}
        catch(error){send(res,400,{error:error instanceof CredentialRefusal?error.code:"headers_unavailable"});return;}
        send(res,200,headers);return;
      }
      let result:unknown;
      switch(v.method){
        case "chaldea_wait":result=await engine.register("wait",input);break;
        case "chaldea_decision_ask":result=await engine.register("decision",input);break;
        case "chaldea_decision_prepare":result=await engine.registerNative(input);break;
        case "chaldea_decision_track":result=await engine.registerNative(input,true);break;
        case "chaldea_wait_cancel":result=engine.cancel(text(input.id,"id"));break;
        case "chaldea_decision_answer":result=await engine.answerFromThread(text(input.id,"id"),text(input.answer,"answer",256),text(input.answeringThreadId,"answeringThreadId"));break;
        case "chaldea_decision_answer_cli":result=engine.answer(text(input.id,"id"),text(input.answer,"answer",256),"cli");break;
        case "chaldea_wait_status":case "chaldea_decision_status":result=engine.store.get(text(input.id,"id"));break;
        // Session results are plain status objects, never decorated as wait items.
        case "chaldea_session_start":result=await engine.startSession(input);break;
        case "chaldea_session_status":result=engine.sessionStatus(text(input.id,"id"));break;
        default:throw new Error("Unknown method");
      }
      if (result && typeof result === "object" && "kind" in result && "id" in result) {
        const item=result as import("../wake/store.ts").Item;
        result={...item,...(item.kind === "wait" ? {waitId:item.id,description:waitDescription(JSON.parse(item.input) as WaitInput,item.target_run)} : {questionId:item.id}),
          ...(item.kind === "native" ? {native:{runtimeRequestId:engine.store.native(item.id).request_id,preparationExpiresAt:engine.store.native(item.id).bind_until}} : {}),
          delivery:engine.store.deliveries().filter(d=>d.item===item.id).map(d=>({channel:d.channel,state:d.state,disposition:d.disposition,attempts:d.attempts,nextAt:d.next_at}))};
      }
      send(res,200,result);
    }catch(error){send(res,400,{error:error instanceof Error?error.message.slice(0,512):"Request failed"});}
  });
  ipc.requestTimeout=10_000;ipc.headersTimeout=10_000;ipc.maxConnections=64;
  await reserve(config.socket,ipc); // One service instance before opening SQLite.
  let store:WakeStore|undefined;let page:Server|undefined;
  try{
    const report=boundedLog(config.logFile);
    // Check the answer credential before accepting questions; log no exception data.
    try { privateFile(config.answerTokenFile); } catch(error) { report("startup_credential_unavailable"); throw error; }
    store=new WakeStore(config.database,config.environment);
    const connect=()=>{
      const serverUrl=config.serverUrl??discoverServerUrl(config.t3BaseDir);
      if(!serverUrl)throw new Error("T3 is offline");
      return {serverUrl,token:privateFile(config.tokenFile),signal:AbortSignal.timeout(10_000)};
    };
    const t3=createWaitT3(connect,config.environment,id=>engine!.trackedNative(id));
    // Disabled unless the operator names a protected policy; it is re-read for every start and gate check.
    const policyFile=config.sessionPolicy;
    const sessions=policyFile===undefined ? {} : {sessions:{policy:()=>loadSessionPolicy(policyFile,config.environment),
      t3:createSessionT3(connect,config.environment)}};
    engine=new WaitEngine(store,t3,{report,...sessions,...extras});
    const running=engine;
    page=createServer(async(req,res)=>{
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Referrer-Policy","no-referrer");
      res.setHeader("Content-Security-Policy","default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
      res.setHeader("X-Content-Type-Options","nosniff");
      try{
        const secret=privateFile(config.answerTokenFile);
        const auth=req.headers.authorization??"";
        if(!equal(auth,"Bearer "+secret)&&!equal(auth,"Basic "+Buffer.from("chaldea:"+secret).toString("base64"))){
          res.setHeader("WWW-Authenticate",'Basic realm="Chaldea decisions", charset="UTF-8"');send(res,401,{error:"Authentication required"});return;
        }
        const url=new URL(req.url??"/",config.answerBaseUrl);
        const match=/^\/decisions\/([a-f0-9-]+)$/.exec(url.pathname);
        const csrf=(id:string)=>createHmac("sha256",secret).update("answer:"+id).digest("hex");
        if(req.method==="POST"&&match){
          const site=req.headers["sec-fetch-site"];
          if(site==="cross-site" || (site!=="same-origin" && req.headers.origin!==new URL(config.answerBaseUrl).origin)){
            report("answer_origin_refused");send(res,400,{error:"Answer origin refused: use the authenticated page on the same origin"});return;
          }
          const form=new URLSearchParams(await body(req));
          if(!equal(form.get("csrf")??"",csrf(match[1]!))){
            report("answer_form_token_invalid");send(res,400,{error:"Invalid form token: reload the decision page"});return;
          }
          running.answer(match[1]!,text(form.get("answer"),"answer",256),"page");
          res.writeHead(303,{Location:"/decisions/"+match[1]});res.end();return;
        }
        if(req.method!=="GET"){send(res,405,{error:"Method not allowed"});return;}
        let html='<h1>Chaldea decisions</h1>';
        const rows=match?[running.store.get(match[1]!)]:running.store.decisions();
        for(const item of rows){
          if(item.kind!=="decision")throw new Error("Not a decision");
          const q=JSON.parse(item.input);
          html+='<article><h2>'+escape(q.question)+'</h2><p>'+escape(item.state)+' · Deadline '+escape(q.deadline)+'</p>';
          if(item.outcome)html+='<p>'+escape(item.outcome)+'</p>';
          else if(item.state==="parked")html+='<p>Safe default ('+escape(q.defaultAction)+'): '+escape(q.dependentAction ?? q.question)+'</p><form method="post" action="/decisions/'+item.id+'"><input type="hidden" name="csrf" value="'+csrf(item.id)+'">'+q.options.map((o:string)=>'<button name="answer" value="'+escape(o)+'">'+escape(o)+'</button>').join(" ")+'</form>';
          html+='</article>';
        }
        res.writeHead(200,{"Content-Type":"text/html; charset=utf-8"});
        res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Chaldea decisions</title><style>body{font:18px system-ui;max-width:48rem;margin:2rem auto;padding:1rem}article{border-bottom:1px solid #aaa;padding:1rem 0}button{font:inherit;margin:.4rem;padding:.6rem}</style>'+html+'</html>');
      }catch(error){
        // Only allowlisted validation errors reach the page; never log request or secret data.
        report("answer_request_invalid");
        const message=error instanceof Error && ["Unknown item","Not a decision","Answer must be one of the options","Request exceeds cap"].includes(error.message)
          ? error.message : "Invalid decision request: reload the page and choose a listed answer";
        send(res,400,{error:message});
      }
    });
    page.requestTimeout=10_000;page.headersTimeout=10_000;page.maxConnections=32;
    await listen(page,{host:config.listenAddress,port:config.port});
    const port=(page.address() as {port:number}).port;
    running.start();report("watcher_started");
    const db=store,web=page;
    return {engine:running,store:db,port,async stop(){
      await Promise.all([new Promise<void>(r=>ipc.close(()=>r())),new Promise<void>(r=>web.close(()=>r()))]);
      await running.stop();db.close();
    }};
  }catch(error){ipc.close();page?.close();store?.close();throw error;}
}
/** The service answered with a refusal; its message is the service's own error text. */
export class ServiceRefusal extends Error { constructor(message:string){super(message);this.name="ServiceRefusal";} }
export function callService(socket:string,method:string,input:unknown,timeout=15_000):Promise<unknown>{
  return new Promise((resolve,reject)=>{
    // Do not reuse a keep-alive Unix connection across watcher replacement.
    const req=request({socketPath:socket,path:"/rpc",method:"POST",agent:false,headers:{"Content-Type":"application/json"},timeout},res=>{
      let data="";res.setEncoding("utf8");res.on("data",s=>{data+=s;if(Buffer.byteLength(data)>16384)req.destroy(new Error("IPC response exceeds cap"));});
      res.on("end",()=>{try{const value=JSON.parse(data);res.statusCode===200?resolve(value):reject(new ServiceRefusal(typeof value?.error==="string"?value.error:"Service refused"));}catch(e){reject(e);}});
    });
    req.on("timeout",()=>req.destroy(new Error("IPC timed out")));req.on("error",reject);
    req.end(JSON.stringify({method,input}));
  });
}
export async function runWaitService(path?:string):Promise<void>{
  const service=await startWaitService(loadConfig(path));
  await new Promise<void>(resolve=>{process.once("SIGTERM",resolve);process.once("SIGINT",resolve);});
  await service.stop();
}
