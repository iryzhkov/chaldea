// MCP stdio transport. The private IPC service owns all durable state and T3 access.
import { callService } from "./waits/service.ts";
const str={type:"string"};
const identity={threadId:{...str,description:"Your own orchestrator_capabilities.parentThreadId on this host"},
  requestId:{...str,description:"Stable retry key: <13-digit epoch milliseconds>:<unique key>; reuse with identical arguments"}};
const schema=(properties:Record<string,unknown>,required:string[])=>({type:"object",properties,required,additionalProperties:false});
export const WAIT_TOOLS=[
  {name:"chaldea_wait",description:"Register one durable time or same-host thread/run wait and return immediately. End your turn when ready; one marked queued wake follows resolution. Use native PR watching/delegation for those cases.",
    inputSchema:schema({...identity,condition:{oneOf:[
      schema({kind:{const:"time"},at:{...str,description:"RFC3339 with offset"}},["kind","at"]),
      schema({kind:{const:"thread"},threadId:str,runId:str},["kind","threadId"])]},deadline:str},["threadId","requestId","condition"])},
  {name:"chaldea_wait_cancel",description:"Cancel an unresolved wait without a wake. Reports in-flight/accepted delivery honestly.",inputSchema:schema({id:str},["id"])},
  {name:"chaldea_wait_status",description:"Read wait state and its immutable outcome.",inputSchema:schema({id:str},["id"])},
  {name:"chaldea_decision_ask",description:"Park a question for Igor and keep working. No answer by the deadline only skips/defers dependent work; it never selects an option or grants approval or permission.",
    inputSchema:schema({...identity,question:str,options:{type:"array",items:str,minItems:2,maxItems:8},dependentAction:{...str,description:"The dependent action to skip or defer if Igor does not answer"},
      defaultAction:{enum:["skip","defer"]},deadline:str},
      ["threadId","requestId","question","options","dependentAction","defaultAction","deadline"])},
  {name:"chaldea_decision_answer",description:"Answer from another local thread, recorded as an agent answer (mcp:<thread>), never as human consent. Your own asking thread cannot answer. Igor uses the page or CLI.",inputSchema:schema({id:str,answer:str,answeringThreadId:identity.threadId},["id","answer","answeringThreadId"])},
  {name:"chaldea_decision_status",description:"Read a question's answer/default, state and deadline.",inputSchema:schema({id:str},["id"])},
];
export async function runMcp(socket:string):Promise<void>{
  let buffer="";let chain=Promise.resolve();
  const reply=(id:unknown,result:unknown,error?:unknown)=>process.stdout.write(JSON.stringify(error?
    {jsonrpc:"2.0",id,error}:{jsonrpc:"2.0",id,result})+"\n");
  const handle=async(line:string)=>{
    let r:Record<string,unknown>;
    try{r=JSON.parse(line);}catch{reply(null,null,{code:-32700,message:"Invalid JSON"});return;}
    if(r.id===undefined)return;
    const id=r.id;
    try{
      if(r.method==="initialize"){reply(id,{protocolVersion:"2024-11-05",capabilities:{tools:{}},serverInfo:{name:"chaldea",version:"0.1.0"}});return;}
      if(r.method==="ping"){reply(id,{});return;}
      if(r.method==="tools/list"){reply(id,{tools:WAIT_TOOLS});return;}
      if(r.method==="tools/call"){
        const p=r.params as {name:string;arguments?:unknown};
        if(!WAIT_TOOLS.some(t=>t.name===p?.name))throw new Error("Unknown tool");
        try{
          const result=await callService(socket,p.name,p.arguments??{});
          reply(id,{content:[{type:"text",text:JSON.stringify(result)}]});
        }catch(e){reply(id,{isError:true,content:[{type:"text",text:e instanceof Error?e.message:"Request failed"}]});}
        return;
      }
      reply(id,null,{code:-32601,message:"Unknown method"});
    }catch{reply(id,null,{code:-32602,message:"Invalid request"});}
  };
  await new Promise<void>((resolve,reject)=>{
    process.stdin.setEncoding("utf8");
    process.stdin.on("data",(chunk:string)=>{
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>64*1024){process.stdin.destroy();reject(new Error("MCP frame exceeds 64 KiB"));return;}
      for(;;){const i=buffer.indexOf("\n");if(i<0)break;const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())chain=chain.then(()=>handle(line));}
    });
    process.stdin.once("end",()=>{void chain.then(()=>resolve(),reject);});
    process.stdin.once("error",reject);
  });
}
