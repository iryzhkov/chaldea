import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.ts";
import { requestTime } from "./types.ts";
import { callService, runWaitService } from "./service.ts";
export const WAIT_USAGE=`chaldea waits serve [--config PATH]
chaldea wait time --at RFC3339 --thread ID [--request-id EPOCH:KEY] [--description TEXT] [--deadline RFC3339]
chaldea wait time --after 30s --thread ID [--request-id EPOCH:KEY] [--description TEXT]
chaldea wait thread --target ID [--run ID] --thread ID [--request-id EPOCH:KEY] [--description TEXT]
chaldea wait status|cancel ID
chaldea decision prepare --thread ID --dependent-action TEXT --default-action skip|defer
  --deadline RFC3339 --request-id EPOCH:KEY
chaldea decision track --thread ID --runtime-request ID --dependent-action TEXT
  --default-action skip|defer --deadline RFC3339 --request-id EPOCH:KEY
chaldea decision ask --thread ID --question TEXT --option TEXT --option TEXT
  --dependent-action TEXT --default-action skip|defer --deadline RFC3339 [--request-id EPOCH:KEY]
chaldea decision answer ID --answer TEXT
chaldea decision status ID
chaldea mcp [--config PATH]
All commands accept --config PATH. Registration commits immediately. Retry the same request-id and arguments.
Defaults only skip or defer the dependent action. They never grant approval or permission.
`;
export async function waitsCli(argv:ReadonlyArray<string>):Promise<number>{
  const [group,...args]=argv;
  const {values:v,positionals:p}=parseArgs({args,allowPositionals:true,options:{
    config:{type:"string"},thread:{type:"string"},"request-id":{type:"string"},deadline:{type:"string"},
    description:{type:"string"},at:{type:"string"},after:{type:"string"},target:{type:"string"},run:{type:"string"},
    question:{type:"string"},option:{type:"string",multiple:true},"dependent-action":{type:"string"},
    "runtime-request":{type:"string"},"default-action":{type:"string"},answer:{type:"string"},help:{type:"boolean",short:"h"},
  }});
  if(v.help){process.stdout.write(WAIT_USAGE);return 0;}
  if(group==="waits"&&p[0]==="serve"){await runWaitService(v.config);return 0;}
  if(group==="mcp"){const {runMcp}=await import("../mcp.ts");const c=loadConfig(v.config);await runMcp(c.socket,c.sessionPolicy!==undefined);return 0;}
  const config=loadConfig(v.config);let method:string;let input:unknown;
  const requestId=v["request-id"]??Date.now()+":"+randomUUID();
  if(group==="wait"&&["time","thread"].includes(p[0]??"")){
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
  const result=await callService(config.socket,method,input);
  process.stdout.write(JSON.stringify(result)+"\n");return 0;
}
