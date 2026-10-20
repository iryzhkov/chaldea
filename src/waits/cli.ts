import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.ts";
import { requestTime } from "./types.ts";
import { saveWaitReceipt, readWaitReceipt } from "./retry.ts";
import { callService, runWaitService, ServiceRefusal } from "./service.ts";
export const WAIT_USAGE=`chaldea waits serve [--config PATH]
chaldea wait time --at RFC3339 --thread ID [--request-id EPOCH:KEY] [--description TEXT] [--deadline RFC3339]
chaldea wait time --after 30s --thread ID [--request-id EPOCH:KEY] [--description TEXT]
chaldea wait thread --target ID [--run ID] --thread ID [--request-id EPOCH:KEY] [--description TEXT]
chaldea wait status|cancel ID [--compact|--verbose]
chaldea wait list --thread ID [--limit 1-8] [--cursor ID] [--compact|--verbose]
chaldea wait closeout --thread ID --wait-id ID [--wait-id ID ...] [--compact|--verbose]
chaldea wait retry RECEIPT [--compact|--verbose]
Wait registration accepts --compact|--verbose and --receipt PATH.
List/closeout select an explicit thread under the same-UID operator boundary.
chaldea decision prepare --thread ID --dependent-action TEXT --default-action skip|defer
  --deadline RFC3339 --request-id EPOCH:KEY
chaldea decision track --thread ID --runtime-request ID --dependent-action TEXT
  --default-action skip|defer --deadline RFC3339 --request-id EPOCH:KEY
chaldea decision ask --thread ID --question TEXT --option TEXT --option TEXT
  --dependent-action TEXT --default-action skip|defer --deadline RFC3339 [--request-id EPOCH:KEY]
chaldea decision answer ID --answer TEXT
chaldea decision status ID
chaldea mcp [--config PATH]
chaldea session headers --preset NAME --audience jocasta|ov|homelab|ha [--config PATH]
All commands accept --config PATH. Registration commits immediately. Retry the same request-id and arguments.
Defaults only skip or defer the dependent action. They never grant approval or permission.
`;
const SESSION_USAGE="chaldea session headers --preset NAME --audience jocasta|ov|homelab|ha [--config PATH]\n";
const BEARER=/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
/**
 * Native credential helper: stdout is exactly {"Authorization":"Bearer ..."} and a
 * newline. Every failure is one fixed refusal code on stderr and exit status 1;
 * no receipts, tracing, service text or token bytes reach stderr.
 */
export async function sessionCli(args:ReadonlyArray<string>):Promise<number>{
  const refuse=(code:string)=>{process.stderr.write(code+"\n");return 1;};
  if(args.length===1&&(args[0]==="--help"||args[0]==="-h")){process.stdout.write(SESSION_USAGE);return 0;}
  let values:{preset?:string|undefined;audience?:string|undefined;config?:string|undefined};
  try{
    const parsed=parseArgs({args:[...args],allowPositionals:true,strict:true,options:{preset:{type:"string"},audience:{type:"string"},config:{type:"string"}}});
    if(parsed.positionals.length!==1||parsed.positionals[0]!=="headers"||parsed.values.preset===undefined||parsed.values.audience===undefined)return refuse("invalid_request");
    values=parsed.values;
  }catch{return refuse("invalid_request");}
  let socket:string;
  try{socket=loadConfig(values.config).socket;}catch{return refuse("config_unavailable");}
  let result:unknown;
  try{result=await callService(socket,"chaldea_session_headers",{preset:values.preset,audience:values.audience},10_000);}
  catch(error){return refuse(error instanceof ServiceRefusal&&/^[a-z_]{1,64}$/.test(error.message)?error.message:"service_unavailable");}
  const header=result&&typeof result==="object"&&!Array.isArray(result)&&Object.keys(result).length===1?(result as Record<string,unknown>).Authorization:undefined;
  if(typeof header!=="string"||!BEARER.test(header))return refuse("invalid_response");
  process.stdout.write(JSON.stringify({Authorization:header})+"\n");return 0;
}
export async function waitsCli(argv:ReadonlyArray<string>, transport:typeof callService=callService):Promise<number>{
  const [group,...args]=argv;
  if(group==="session")return sessionCli(args);
  const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:{
    config:{type:"string"},thread:{type:"string"},"request-id":{type:"string"},deadline:{type:"string"},
    compact:{type:"boolean"},verbose:{type:"boolean"},receipt:{type:"string"},
    "wait-id":{type:"string",multiple:true},limit:{type:"string"},cursor:{type:"string"},
    description:{type:"string"},at:{type:"string"},after:{type:"string"},target:{type:"string"},run:{type:"string"},
    question:{type:"string"},option:{type:"string",multiple:true},"dependent-action":{type:"string"},
    "runtime-request":{type:"string"},"default-action":{type:"string"},answer:{type:"string"},help:{type:"boolean",short:"h"},
  }});
  if(v.help){process.stdout.write(WAIT_USAGE);return 0;}
  if(group==="waits"&&p[0]==="serve"){await runWaitService(v.config);return 0;}
  if(group==="mcp"){const {runMcp}=await import("../mcp.ts");const c=loadConfig(v.config);await runMcp(c.socket,c.sessionPolicy!==undefined);return 0;}
  if(v.compact&&v.verbose)throw new Error("Choose --compact or --verbose");
  const registration=group==="wait"&&["time","thread"].includes(p[0]??"");
  if(v.receipt!==undefined&&!registration)throw new Error("--receipt requires wait registration; use wait retry PATH to replay");
  if((v.compact||v.verbose)&&group!=="wait")throw new Error("Response mode requires wait");
  const config=loadConfig(v.config);let method:string;let input:unknown;
  const requestId=v["request-id"]??(group==="wait"&&p[0]==="retry" ? "" : Date.now()+":"+randomUUID());
  if(group==="wait"&&p[0]==="retry"){
    const allowed=new Set(["config","compact","verbose"]);
    if(p.length!==2||Object.keys(v).some(key=>!allowed.has(key)))throw new Error("Retry accepts only a receipt path, config and response mode");
    const receipt=readWaitReceipt(p[1]!);method=receipt.method;input=receipt.input;
  }else if(group==="wait"&&p[0]==="list"){
    if(!v.thread)throw new Error("--thread required for selected-thread list");
    method="chaldea_wait_list";input={threadId:v.thread,...(v.limit===undefined?{}:{limit:Number(v.limit)}),...(v.cursor===undefined?{}:{cursor:v.cursor})};
  }else if(group==="wait"&&p[0]==="closeout"){
    if(!v.thread)throw new Error("--thread required for selected-thread closeout");
    if(!v["wait-id"]?.length)throw new Error("--wait-id required for selected-thread closeout");
    method="chaldea_wait_closeout";input={threadId:v.thread,waitIds:v["wait-id"]};
  }else if(registration){
    let condition:unknown;
    if(p[0]==="time"){
      if(Boolean(v.at)===Boolean(v.after))throw new Error("Specify exactly one of --at or --after");
      let at=v.at;
      if(v.after){
        const m=/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(v.after);
        if(!m)throw new Error("Duration requires ms, s, m, h or d");
        const units:Record<string,number>={ms:1,s:1000,m:60000,h:3600000,d:86400000};
        // Relative time is pinned to the retry key's creation time.
        at=new Date(requestTime(requestId)+Number(m[1])*units[m[2]!]!).toISOString();
      }
      condition={kind:"time",at};
    }else condition={kind:"thread",threadId:v.target,...(v.run?{runId:v.run}:{})};
    method="chaldea_wait";input={threadId:v.thread,requestId,condition,...(v.description === undefined ? {} : {description:v.description}),...(v.deadline?{deadline:v.deadline}:{})};
  }else if(group==="decision"&&["prepare","track"].includes(p[0]??"")){
    if(!v["request-id"])throw new Error("--request-id required for native decision policy");
    method=p[0]==="prepare"?"chaldea_decision_prepare":"chaldea_decision_track";
    input={threadId:v.thread,requestId,dependentAction:v["dependent-action"],defaultAction:v["default-action"],deadline:v.deadline,
      ...(v["runtime-request"] ? {runtimeRequestId:v["runtime-request"]} : {})};
  }else if(group==="decision"&&p[0]==="ask"){
    method="chaldea_decision_ask";input={threadId:v.thread,requestId,question:v.question,options:v.option,
      dependentAction:v["dependent-action"],defaultAction:v["default-action"],deadline:v.deadline};
  }else if(group==="decision"&&p[0]==="answer"){method="chaldea_decision_answer_cli";input={id:p[1],answer:v.answer};}
  else if(p[0]==="status"&&(group==="wait"||group==="decision")){method=group==="wait"?"chaldea_wait_status":"chaldea_decision_status";input={id:p[1]};}
  else if(group==="wait"&&p[0]==="cancel"){method="chaldea_wait_cancel";input={id:p[1]};}
  else throw new Error(WAIT_USAGE);
  if(v.receipt!==undefined)input=saveWaitReceipt(v.receipt,input).input;
  if(group==="wait"&&(v.compact||v.verbose))input={...input as Record<string,unknown>,responseMode:v.compact?"compact":"verbose"};
  const result=await transport(config.socket,method,input);
  process.stdout.write(JSON.stringify(result)+"\n");return 0;
}
