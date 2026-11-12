// MCP stdio transport for advisory routing.
import { route, routeReviewPair } from "./route/runtime.ts";
import { compactRoute } from "./route/output.ts";
import { RouteError, routeFailure } from "./route/errors.ts";
const schema=(properties:Record<string,unknown>,required:string[])=>({type:"object",properties,required,additionalProperties:false});
export const ROUTE_TOOLS=[
  {name:"chaldea_route",description:"Recommend an exact native target before T3 delegate_task. Opt into compact output to reduce context; verbose preserves legacy diagnostics. quality_source reports AA or fixed_policy. Chaldea never launches the child.",inputSchema:schema({role:{enum:["builder","critical-review","bulk-read","general","executor"]},authorProvider:{enum:["claudeAgent","codex"]},effortOverride:{enum:["low","medium","high","xhigh"]},responseMode:{enum:["compact","verbose"]}},["role"])},
  {name:"chaldea_route_review_pair",description:"Recommend an independent main and peer review pair from one catalog/quota snapshot. Main uses the other underlying provider. An explicitly requested quota exception requires fresh quota evidence; unknown quota never waives separation. Reports partial or unavailable honestly. Never launches tasks.",inputSchema:schema({authorProvider:{enum:["claudeAgent","codex"]},mainRole:{enum:["builder","critical-review","bulk-read","general","executor"]},peerRole:{enum:["builder","critical-review","bulk-read","general","executor"]},mainEffort:{enum:["low","medium","high","xhigh"]},peerEffort:{enum:["low","medium","high","xhigh"]},allowQuotaException:{type:"boolean"}},["authorProvider"])},

];
/** Keep the legacy MCP result by default; presentation is not routing input. */
export async function routeResponse(value:unknown) {
  if(!value||typeof value!=="object"||Array.isArray(value))return route(value);
  const {responseMode,...input}=value as Record<string,unknown>;
  if(responseMode!==undefined&&responseMode!=="compact"&&responseMode!=="verbose")
    throw new RouteError("usage","Invalid responseMode");
  const result=await route(input);
  return responseMode==="compact"?compactRoute(result):result;
}
export async function runMcp():Promise<void>{
  const tools=()=>ROUTE_TOOLS;
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
      if(r.method==="tools/list"){reply(id,{tools:tools()});return;}
      if(r.method==="tools/call"){
        const p=r.params as {name:string;arguments?:unknown};
        if(!tools().some(t=>t.name===p?.name))throw new Error("Unknown tool");
        try{
          const result=p.name==="chaldea_route" ? await routeResponse(p.arguments??{}) :
            await routeReviewPair(p.arguments??{});
          reply(id,{content:[{type:"text",text:JSON.stringify(result)}]});
        }catch(e){
          const failure=p.name==="chaldea_route"||p.name==="chaldea_route_review_pair" ? routeFailure(e) : null;
          reply(id,{isError:true,content:[{type:"text",text:failure?JSON.stringify({error:{code:failure.code,message:failure.message}}):e instanceof Error?e.message:"Request failed"}]});
        }
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
