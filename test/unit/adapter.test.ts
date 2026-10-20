// Contract tests for the T3 adapter that need no T3: handshake refusals and
// schema drift must fail closed, and stream items map to the domain type.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { WebSocketServer } from "ws";

import {
  AuthenticationError,
  ProtocolIncompatibleError,
  TransientConnectionError,
  connectShell,
  socketUrl,
  respondChaldeaDecision,
} from "../../src/t3/adapter.ts";

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function refusing(status: number, body: unknown): Server {
  return createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
}

test("native response RPC distinguishes ambiguous dispatch errors from replayed durable rejection",async()=>{
  const server=createServer(),wss=new WebSocketServer({server});
  const payload=JSON.stringify({type:"runtime-request.respond",commandId:"native-receipt",threadId:"fixture",requestId:"question",answers:{q:"defer"}});
  const seen:unknown[]=[];let attempts=0;
  wss.on("connection",socket=>socket.on("message",data=>{
    const request=JSON.parse(String(data));
    if(request._tag!=="Request")return;
    seen.push(request.payload);attempts++;
    const error={_tag:"OrchestrationV2DispatchCommandError",commandId:"native-receipt",commandType:"runtime-request.respond",
      message:attempts===1?"Failed to dispatch orchestration V2 command":"Command was previously rejected"};
    socket.send(JSON.stringify({_tag:"Exit",requestId:request.id,exit:attempts===2
      ? {_tag:"Success",value:{sequence:1}}
      : {_tag:"Failure",cause:[{_tag:"Fail",error}]}}));
  }));
  try{
    const serverUrl=await listen(server),options={serverUrl,token:"fixture-token",signal:AbortSignal.timeout(3000)};
    await assert.rejects(respondChaldeaDecision(options,payload),/Failed to dispatch orchestration V2 command/);
    assert.equal(await respondChaldeaDecision(options,payload),true);
    assert.equal(await respondChaldeaDecision(options,payload),false);
    assert.equal(seen.length,3);assert.deepEqual(seen[0],JSON.parse(payload));
    assert.deepEqual(seen[0],seen[1]);assert.deepEqual(seen[1],seen[2]);
  }finally{wss.close();server.close();}
});

test("the socket URL asks for orchestration protocol 2", () => {
  assert.equal(new URL(socketUrl("http://127.0.0.1:7391")).searchParams.get("orchestrationProtocol"), "2");
  assert.equal(new URL(socketUrl("http://127.0.0.1:7391")).protocol, "ws:");
});

test("HTTP 426 fails closed as ProtocolIncompatibleError", async () => {
  const server = refusing(426, { code: "orchestration_protocol_incompatible", orchestrationProtocolVersion: 3 });
  try {
    const url = await listen(server);
    await assert.rejects(connectShell({ serverUrl: url, token: "t" }, { onEvent: () => {} }), ProtocolIncompatibleError);
  } finally {
    server.close();
  }
});

test("HTTP 401 is an AuthenticationError", async () => {
  const server = refusing(401, { code: "auth_invalid" });
  try {
    const url = await listen(server);
    await assert.rejects(connectShell({ serverUrl: url, token: "t" }, { onEvent: () => {} }), AuthenticationError);
  } finally {
    server.close();
  }
});

test("a closed port is transient", async () => {
  const server = createServer();
  const url = await listen(server);
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(connectShell({ serverUrl: url, token: "t" }, { onEvent: () => {} }), TransientConnectionError);
});

test("a frame that is not JSON fails closed", async () => {
  const server = createServer();
  const wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      if (JSON.parse(String(data))._tag === "Request") socket.send("{not json");
    });
  });
  try {
    const url = await listen(server);
    await assert.rejects(connectShell({ serverUrl: url, token: "t" }, { onEvent: () => {} }), ProtocolIncompatibleError);
  } finally {
    wss.close();
    server.close();
  }
});

test("a stream item the pinned contracts reject fails closed", async () => {
  // Speaks just enough of Effect's RPC JSON protocol to answer the shell
  // subscription with an item whose sequence has the wrong type.
  const server = createServer();
  const wss = new WebSocketServer({ server });
  let authorization: string | undefined;
  wss.on("connection", (socket, request) => {
    authorization = request.headers.authorization;
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message._tag === "Request") {
        socket.send(JSON.stringify({
          _tag: "Chunk",
          requestId: message.id,
          values: [{ kind: "thread.removed", sequence: "not-a-number", location: "active", threadId: "t" }],
        }));
      } else if (message._tag === "Ping") {
        socket.send(JSON.stringify({ _tag: "Pong" }));
      }
    });
  });
  try {
    const url = await listen(server);
    const seen: Array<unknown> = [];
    await assert.rejects(
      connectShell({ serverUrl: url, token: "secret-token" }, { onEvent: (event) => void seen.push(event) }),
      ProtocolIncompatibleError,
    );
    assert.deepEqual(seen, []);
    assert.equal(authorization, "Bearer secret-token");
  } finally {
    wss.close();
    server.close();
  }
});

test("a protocol failure inside the shell callback retains its fail-closed classification", async () => {
  const server = createServer(), wss = new WebSocketServer({ server });
  wss.on("connection", (socket) => {
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      if (message._tag === "Request") socket.send(JSON.stringify({
        _tag: "Chunk", requestId: message.id, values: [{ kind: "synchronized" }],
      }));
    });
  });
  const failure = new ProtocolIncompatibleError("nested RPC contract drift");
  try {
    const url = await listen(server);
    await assert.rejects(connectShell({ serverUrl: url, token: "t" }, {
      onEvent: () => { throw failure; },
    }), (error) => error === failure);
  } finally {
    wss.close(); server.close();
  }
});

for(const denied of ["success","typed","die","decode"])test("host resources share the shell connection; denial preserves thread capture, denied="+denied,async()=>{
 const server=createServer(),wss=new WebSocketServer({server}),controller=new AbortController();
 const sample={sampledAt:1000,cpuUtilization:0.2,cpuCount:8,availableMemoryBytes:400,totalMemoryBytes:1000};
 let connections=0,synchronized=false,resources:any=null,shellRequestId:string|null=null;
 const requests:string[]=[];
 const finish=()=>{if(synchronized&&resources)controller.abort();};
 wss.on("connection",socket=>{connections++;socket.on("message",data=>{
  const req=JSON.parse(String(data));if(req._tag==="Ping"){socket.send(JSON.stringify({_tag:"Pong"}));return;}if(req._tag!=="Request")return;
  requests.push(req.tag);
  if(req.tag==="orchestration.subscribeShell")shellRequestId=req.id;
  else if(req.tag==="server.getHostResources"){
   const exit=denied==="typed"?{_tag:"Failure",cause:[{_tag:"Fail",error:{_tag:"EnvironmentAuthorizationError",message:"fixture denied",requiredScope:"orchestration:read"}}]}:denied==="die"?{_tag:"Failure",cause:[{_tag:"Die",defect:{message:"unsupported RPC"}}]}:{_tag:"Success",value:denied==="decode"?{invalid:true}:sample};
   socket.send(JSON.stringify({_tag:"Exit",requestId:req.id,exit}));
   // The shell must still deliver after the failed optional sample.
   setTimeout(()=>{if(shellRequestId)socket.send(JSON.stringify({_tag:"Chunk",requestId:shellRequestId,values:[{kind:"synchronized"}]}));},30);
  }
 });});
 const timer=setTimeout(()=>controller.abort(),4000);
 try{
  const serverUrl=await listen(server);
  await assert.rejects(connectShell({serverUrl,token:"fixture",signal:controller.signal},{
   onEvent:e=>{if(e.kind==="synchronized"){synchronized=true;finish();}},
   onResources:r=>{resources=r;finish();}
  }));
  assert.equal(connections,1);assert.equal(synchronized,true);assert.equal(resources.state,denied==="success"?"reported":"unavailable");
  assert.deepEqual(resources.sample,denied==="success"?sample:null);
  assert.deepEqual(new Set(requests),new Set(["orchestration.subscribeShell","server.getHostResources"]));
 }finally{clearTimeout(timer);for(const socket of wss.clients)socket.terminate();wss.close();server.close();}
});


for(const overflow of [false,true])for(const snapshot of [false,true])test("official detail ownership preserves legacy capture and rolls past 128 owners, items="+overflow+", snapshot="+snapshot,async()=>{
 const {connectMissionThread}=await import("../../src/t3/adapter.ts");
 const server=createServer(),wss=new WebSocketServer({server}),controller=new AbortController();
 const stamp="2026-10-18T00:00:00.000Z",threadId="owner-fixture";
 const node={id:"root-0",threadId,runId:null,parentNodeId:null,rootNodeId:"root-0",kind:"root_turn",status:"running",countsForRun:true,providerThreadId:"provider",providerTurnId:null,nativeItemRef:null,runtimeRequestId:null,checkpointScopeId:null,startedAt:stamp,completedAt:null};
 const roots=Array.from({length:130},(_,i)=>({...node,id:"root-"+i,rootNodeId:"root-"+i}));
 const provider={id:"provider",driver:"codex",providerInstanceId:"custom",providerSessionId:null,appThreadId:threadId,ownerNodeId:"root-0",nativeThreadRef:null,nativeConversationHeadRef:null,status:"active",firstRunOrdinal:1,lastRunOrdinal:130,handoffIds:[],forkedFrom:null,pendingBackgroundTasks:[],contextUsage:{usedTokens:500,maxTokens:1000},nativeMetadata:null,createdAt:stamp,updatedAt:stamp};
 const base={threadId,runId:null,nodeId:null,providerThreadId:"provider",providerTurnId:null,nativeItemRef:null,parentItemId:null,ordinal:1,title:null,startedAt:stamp,completedAt:null,updatedAt:stamp};
 const assistant=(id:string,nodeId:string|null,text=id)=>({...base,id,nodeId,type:"assistant_message",status:"completed",messageId:id,text,streaming:false});
 // The current root differs from the provider's creation root. Historical item
 // nodes must not displace it on reconnect or during one long live turn.
 const itemNodes=overflow?[
  ...Array.from({length:130},(_,i)=>({...node,id:"execution-"+i,rootNodeId:"root-129",parentNodeId:"root-129",kind:i%2?"reasoning":"tool_call"})),
  {...node,id:"latest-assistant-node",rootNodeId:"root-129",parentNodeId:"root-129",kind:"assistant_message"},
  {...node,id:"latest-command-node",rootNodeId:"root-129",parentNodeId:"root-129",kind:"tool_call"},
  {...node,id:"snapshot-child",rootNodeId:"root-129",parentNodeId:"root-129",kind:"subagent"},
  {...node,id:"snapshot-child-item",rootNodeId:"root-129",parentNodeId:"snapshot-child",kind:"assistant_message"},
  {...node,id:"snapshot-foreign",threadId:"foreign",rootNodeId:"root-129",parentNodeId:"root-129",kind:"assistant_message"},
  {...node,id:"snapshot-unknown-parent",rootNodeId:"root-129",parentNodeId:"unknown-parent",kind:"assistant_message"},
  {...node,id:"snapshot-old-root",rootNodeId:"root-0",parentNodeId:"root-0",kind:"assistant_message"},
 ]:[];
 const overflowItems=overflow?[
  assistant("overflow-assistant","latest-assistant-node"),
  {...base,id:"overflow-command",nodeId:"latest-command-node",type:"command_execution",status:"running",input:"npm test",output:"PRIVATE OUTPUT"},
  ...["execution-0","snapshot-child-item","snapshot-foreign","snapshot-unknown-parent","snapshot-old-root","unknown-node"].map(id=>assistant("rejected-"+id,id)),
 ]:[];
 let sequence=1;
 const event=(type:string,payload:unknown,scope=threadId)=>({kind:"event",sequence:++sequence,event:{id:"event-"+sequence,threadId:scope,occurredAt:stamp,type,payload}});
 const values:unknown[]=[];
 if(snapshot){
  const thread={id:threadId,projectId:"project",title:"Ownership fixture",providerInstanceId:"custom",modelSelection:{instanceId:"custom",model:"gpt-6.1-sol"},runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null,activeProviderThreadId:"provider",lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:threadId},forkedFrom:null,createdBy:"user",creationSource:"web",createdAt:stamp,updatedAt:stamp,archivedAt:null,deletedAt:null};
  values.push({kind:"snapshot",snapshotSequence:1,projection:{thread,nodes:[...roots,...itemNodes],providerThreads:[provider],runs:[],attempts:[],subagents:[],providerSessions:[],providerTurns:[],runtimeRequests:[],messages:[],plans:[],turnItems:[assistant("snapshot-main",null),...overflowItems],checkpointScopes:[],checkpoints:[],contextHandoffs:[],contextTransfers:[],visibleTurnItems:[],updatedAt:stamp}});
 }else{
  values.push(event("node.updated",roots[0]),event("provider-thread.updated",provider));
  for(const root of roots.slice(1))values.push(event("node.updated",root));
  for(const itemNode of itemNodes)values.push(event("node.updated",itemNode));
  for(const item of overflowItems)values.push(event("turn-item.updated",item));
 }
 // Updating the long-lived provider after its creation root was evicted is valid.
 values.push(event("provider-thread.updated",provider),event("turn-item.updated",assistant("old-provider",null)));
 values.push(event("node.updated",{...node,id:"root-new",rootNodeId:"root-new"}));
 values.push(event("node.updated",{...node,id:"assistant-node",parentNodeId:"root-new",rootNodeId:"root-new",kind:"assistant_message"}));
 values.push(event("turn-item.updated",assistant("main-assistant","assistant-node")));
 values.push(event("node.updated",{...node,id:"tool-node",parentNodeId:"root-new",rootNodeId:"root-new",kind:"tool_call"}));
 values.push(event("turn-item.updated",{...base,id:"main-command",nodeId:"tool-node",type:"command_execution",status:"running",input:"go test",output:"PRIVATE OUTPUT"}));
 // Missing owner evidence must not break established activity and command paths.
 values.push(event("turn-item.updated",{...base,id:"legacy-command",nodeId:"unseen-node",providerThreadId:null,type:"command_execution",status:"running",input:"npm test"}));
 values.push(event("turn-item.updated",assistant("legacy-assistant","unseen-node")));
 values.push(event("turn-item.updated",{...base,id:"legacy-reasoning",nodeId:"unseen-node",providerThreadId:null,type:"reasoning",status:"running",text:"PRIVATE REASONING",streaming:true}));
 // Actual child/foreign/unknown nodes never become recent observations.
 values.push(event("node.updated",{...node,id:"child-node",kind:"subagent",parentNodeId:"root-new",rootNodeId:"root-new"}));
 values.push(event("node.updated",{...node,id:"child-assistant-node",kind:"assistant_message",parentNodeId:"child-node",rootNodeId:"root-new"}));
 values.push(event("turn-item.updated",assistant("child-item","child-assistant-node")));
 values.push(event("node.updated",{...node,id:"foreign-node",threadId:"foreign",kind:"assistant_message",parentNodeId:"root-new",rootNodeId:"root-new"}));
 values.push(event("turn-item.updated",assistant("foreign-node-item","foreign-node")));
 values.push(event("turn-item.updated",{...assistant("foreign-payload",null),threadId:"foreign"}));
 values.push(event("turn-item.updated",assistant("foreign-envelope",null),"foreign"));
 values.push(event("turn-item.updated",{...assistant("foreign-provider","assistant-node"),providerThreadId:"child-provider"}));
 values.push(event("turn-item.updated",{...assistant("evicted-root","root-0"),providerThreadId:null}));
 values.push({kind:"synchronized"});
 const seen:import("../../src/t3/adapter.ts").MissionDetailEvent[]=[];
 wss.on("connection",socket=>socket.on("message",data=>{
  const req=JSON.parse(String(data));if(req._tag==="Ping")socket.send(JSON.stringify({_tag:"Pong"}));
  if(req._tag==="Request")socket.send(JSON.stringify({_tag:"Chunk",requestId:req.id,values}));
 }));
 const timer=setTimeout(()=>controller.abort(),4000);
 try{
  const serverUrl=await listen(server);
  await assert.rejects(connectMissionThread({serverUrl,token:"fixture",signal:controller.signal},threadId,undefined,e=>{seen.push(e);if(e.kind==="synchronized")controller.abort();}));
  assert.ok(seen.some(e=>e.kind==="synchronized"),"fixture must decode through official contracts");
  assert.deepEqual(seen.filter(e=>e.kind==="recent-item").map(e=>e.id),[...(snapshot?["snapshot-main"]:[]),...(overflow?["overflow-assistant","overflow-command"]:[]),"old-provider","main-assistant","main-command"]);
  assert.ok(seen.some(e=>e.kind==="command"&&e.id==="legacy-command"&&e.running));
  assert.ok(seen.some(e=>e.kind==="assistant"&&e.text==="legacy-assistant"));
  assert.ok(seen.some(e=>e.kind==="activity-state"&&e.id==="legacy-reasoning"&&e.running));
  assert.ok(seen.some(e=>e.kind==="metadata"&&e.context?.used===500));
  assert.ok(!seen.some(e=>e.kind==="assistant"&&["foreign-payload","foreign-envelope"].includes(e.text)));
  assert.ok(!JSON.stringify(seen).includes("PRIVATE OUTPUT"));assert.ok(!JSON.stringify(seen).includes("PRIVATE REASONING"));
 }finally{clearTimeout(timer);for(const socket of wss.clients)socket.terminate();wss.close();server.close();}
});

for(const denied of [false,true])test("provider catalog shares ONE shell client and copies only safe identity fields, denied="+denied,async()=>{
 const server=createServer(),wss=new WebSocketServer({server}),controller=new AbortController();
 let connections=0,synchronized=false;const catalogs:unknown[][]=[],requests:string[]=[];
 const provider={instanceId:"custom-work",driver:"codex",enabled:true,installed:true,version:null,status:"ready",auth:{status:"authenticated",email:"private@example.test",workspaceId:"PRIVATE_ACCOUNT"},runtimePaths:{homePath:"/private/home",shadowHomePath:null},checkedAt:"2026-10-18T00:00:00.000Z",models:[]};
 const finish=()=>{if(synchronized&&catalogs.length===(denied?1:2))controller.abort();};
 wss.on("connection",socket=>{connections++;socket.on("message",data=>{
  const req=JSON.parse(String(data));if(req._tag==="Ping"){socket.send(JSON.stringify({_tag:"Pong"}));return;}if(req._tag!=="Request")return;
  requests.push(req.tag);
  if(req.tag==="orchestration.subscribeShell")socket.send(JSON.stringify({_tag:"Chunk",requestId:req.id,values:[{kind:"synchronized"}]}));
  else if(req.tag==="subscribeServerConfig"){
   if(denied)socket.send(JSON.stringify({_tag:"Exit",requestId:req.id,exit:{_tag:"Failure",cause:[{_tag:"Fail",error:{_tag:"EnvironmentAuthorizationError",message:"fixture denied",requiredScope:"settings:read"}}]}}));
   else socket.send(JSON.stringify({_tag:"Chunk",requestId:req.id,values:[{version:1,type:"providerStatuses",payload:{providers:[provider]}},{version:1,type:"providerStatuses",payload:{providers:[{...provider,driver:"futureDriver"}]}}]}));
  }
 });});
 const timer=setTimeout(()=>controller.abort(),4000);
 try{
  const serverUrl=await listen(server);
  await assert.rejects(connectShell({serverUrl,token:"fixture",signal:controller.signal},{
   onEvent:e=>{if(e.kind==="synchronized"){synchronized=true;finish();}},
   onProviderCatalog:rows=>{catalogs.push([...rows]);finish();}
  }));
  assert.equal(connections,1);assert.equal(synchronized,true);
  assert.deepEqual(catalogs,denied?[[]]:[[{instanceId:"custom-work",driver:"codex"}],[{instanceId:"custom-work",driver:"futureDriver"}]]);
  assert.deepEqual(new Set(requests),new Set(["orchestration.subscribeShell","subscribeServerConfig"]));
  assert.ok(!JSON.stringify(catalogs).includes("PRIVATE"));assert.ok(!JSON.stringify(catalogs).includes("/private"));
 }finally{clearTimeout(timer);for(const socket of wss.clients)socket.terminate();wss.close();server.close();}
});

for(const scenario of ["qualified-crowding","same-provider-root-pointer","same-provider-attempt-pointer","nullable-forward","conflicting-forward","long-stream","long-stream-pinned-owner","poison-overflow","runtime-shape","multiple-turns","historical-owner","historical-provider","child-crowding","owner-foreign","owner-nonself","foreign-reverse","snapshot-truncation","poison-reintroduction","stream-overflow","completed-time","stream-child-crowding","root-conflict-reintroduction","null-owner","owned","foreign-app","foreign-root","subagent","dangling-node","missing-run","wrong-run-root","wrong-node-turn","wrong-node-provider","foreign-run","wrong-run-provider","wrong-root-parent","wrong-root-self","ambiguous-node","ambiguous-turn","ambiguous-run","duplicate-provider","duplicate-turn","duplicate-node","duplicate-run","owner-contradiction","attempt","wrong-attempt","reorder","replay","correction","withdraw","snapshot-removal","eviction"])test("official usage tuple fixture "+scenario,async()=>{
 const {connectMissionThread}=await import("../../src/t3/adapter.ts");
 const {MissionModel}=await import("../../src/mission-control/model.ts");
 const server=createServer(),wss=new WebSocketServer({server}),controller=new AbortController();
 const stamp="2026-10-18T00:00:00.000Z",threadId="null-owner-fixture",now=Date.parse(stamp);
 const thread={id:threadId,projectId:"project",title:"Ownership fixture",providerInstanceId:"custom",modelSelection:{instanceId:"custom",model:"gpt-6.1-sol"},runtimeMode:"full-access",interactionMode:"default",branch:null,worktreePath:null,activeProviderThreadId:"provider",lineage:{parentThreadId:null,relationshipToParent:null,rootThreadId:threadId},forkedFrom:null,createdBy:"user",creationSource:"web",createdAt:stamp,updatedAt:stamp,archivedAt:null,deletedAt:null};
 const provider={id:"provider",driver:"codex",providerInstanceId:"custom",providerSessionId:null,appThreadId:threadId,ownerNodeId:null,nativeThreadRef:null,nativeConversationHeadRef:null,status:"active",firstRunOrdinal:1,lastRunOrdinal:7,handoffIds:[],forkedFrom:null,pendingBackgroundTasks:[{taskId:"private-task",kind:"monitor"}],contextUsage:{usedTokens:500,maxTokens:1000},nativeMetadata:null,createdAt:stamp,updatedAt:stamp};
 const nodes=Array.from({length:7},(_,i)=>({id:"root-"+i,threadId,runId:"run-"+i,parentNodeId:null,rootNodeId:"root-"+i,kind:"root_turn",status:i===6?"running":"completed",countsForRun:true,providerThreadId:"provider",providerTurnId:"turn-"+i,nativeItemRef:null,runtimeRequestId:null,checkpointScopeId:null,startedAt:stamp,completedAt:i===6?null:stamp}));
 const runs=nodes.map((n,i)=>({id:n.runId,threadId,ordinal:i+1,providerInstanceId:"custom",modelSelection:thread.modelSelection,providerThreadId:"provider",userMessageId:"message-"+i,rootNodeId:n.id,activeAttemptId:null,status:n.status,requestedAt:stamp,startedAt:stamp,completedAt:n.completedAt,checkpointId:null,contextHandoffId:null}));
 const turns=nodes.map((n,i)=>({id:n.providerTurnId,providerThreadId:"provider",nodeId:n.id,runAttemptId:null,nativeTurnRef:null,ordinal:i+1,status:n.status,startedAt:stamp,completedAt:n.completedAt,...(i===6?{}:{turnTokenUsage:{usageScope:"main_agent",usageStatus:"complete",inputTokens:100,outputTokens:20,cachedInputTokens:30,cacheCreationTokens:0,reasoningTokens:5,hasSubagents:false}})}));
 const projection:any={thread,nodes,providerThreads:[provider],runs,attempts:[],subagents:[],providerSessions:[],providerTurns:turns,runtimeRequests:[],messages:[],plans:[],turnItems:[],checkpointScopes:[],checkpoints:[],contextHandoffs:[],contextTransfers:[],visibleTurnItems:[],updatedAt:stamp};

 let expected=6*120,expectedTurns=6;
 if(scenario==="owned")provider.ownerNodeId="root-0" as never;
 if(scenario==="foreign-app")provider.appThreadId="foreign";
 if(scenario==="foreign-root")for(const n of nodes)n.threadId="foreign";
 if(scenario==="subagent")for(const n of nodes)n.kind="subagent";
 if(scenario==="dangling-node")for(const t of turns)t.nodeId="missing";
 if(scenario==="missing-run")projection.runs=[];
 if(scenario==="wrong-run-root")for(const r of runs)r.rootNodeId="wrong";
 if(scenario==="wrong-node-turn")for(const n of nodes)n.providerTurnId="wrong";
 if(scenario==="wrong-node-provider")for(const n of nodes)n.providerThreadId="wrong";
 if(scenario==="foreign-run")for(const r of runs)r.threadId="foreign";
 if(scenario==="wrong-run-provider")for(const r of runs)r.providerThreadId="foreign";
 if(scenario==="wrong-root-parent")for(const n of nodes)n.parentNodeId="parent" as never;
 if(scenario==="wrong-root-self")for(const n of nodes)n.rootNodeId="other";
 if(scenario==="ambiguous-node")for(const n of [...nodes])projection.nodes.push({...n,id:"other-"+n.id});
 if(scenario==="ambiguous-turn")for(const t of [...turns])projection.providerTurns.push({...t,id:"other-"+t.id});
 if(scenario==="ambiguous-run")for(const r of [...runs])projection.runs.push({...r,id:"other-"+r.id});
 if(scenario==="duplicate-provider")projection.providerThreads.push({...provider});
 if(scenario==="duplicate-turn")projection.providerTurns.push({...turns[0]});
 if(scenario==="duplicate-node")projection.nodes.push({...nodes[0]});
 if(scenario==="duplicate-run")projection.runs.push({...runs[0]});
 if(scenario==="owner-contradiction"){provider.ownerNodeId="contradiction" as never;projection.nodes.push({...nodes[0],id:"contradiction",kind:"subagent"});}
 if(scenario==="attempt"||scenario==="wrong-attempt"){
  for(const t of projection.providerTurns){t.runAttemptId="attempt-"+t.id;projection.attempts.push({id:t.runAttemptId,runId:"run-"+(t.ordinal-1),attemptOrdinal:1,rootNodeId:t.nodeId,providerInstanceId:"custom",providerThreadId:"provider",providerTurnId:scenario==="attempt"?t.id:"wrong",reason:"initial",status:t.status,startedAt:stamp,completedAt:t.completedAt});}
 }
 if(["foreign-app","foreign-root","subagent","dangling-node","wrong-run-root","wrong-node-provider","foreign-run","wrong-run-provider","wrong-root-parent","wrong-root-self","ambiguous-node","duplicate-provider","owner-contradiction","owner-foreign","owner-nonself","foreign-reverse"].includes(scenario)){expected=0;expectedTurns=0;}
 if(["duplicate-turn","duplicate-node","duplicate-run","poison-reintroduction"].includes(scenario)){expected=5*120;expectedTurns=5;}
 if(scenario==="runtime-shape"){
  projection.nodes=nodes.slice(0,4).map(n=>({...n,providerTurnId:null}));
  projection.providerTurns=turns.slice(0,4).map((t,i)=>({...t,runAttemptId:"attempt-"+i,...(i===3?{turnTokenUsage:undefined}: {})}));
  projection.runs=[runs[3]];
  projection.attempts=[{id:"attempt-3",runId:runs[3]!.id,attemptOrdinal:1,rootNodeId:nodes[3]!.id,providerInstanceId:"custom",providerThreadId:"provider",providerTurnId:null,reason:"initial",status:"running",startedAt:stamp,completedAt:null}];
  expected=360;expectedTurns=3;
 }
 if(scenario==="multiple-turns"){
  projection.nodes=[{...nodes[0],providerTurnId:turns.at(-1)!.id}];projection.runs=[runs[0]];
  projection.providerTurns=turns.map(t=>({...t,nodeId:nodes[0]!.id,runAttemptId:"shared"}));
  projection.attempts=[{id:"shared",runId:runs[0]!.id,attemptOrdinal:1,rootNodeId:nodes[0]!.id,providerInstanceId:"custom",providerThreadId:"provider",providerTurnId:turns.at(-1)!.id,reason:"initial",status:"running",startedAt:stamp,completedAt:null}];
 }
 if(scenario==="historical-owner"){
  provider.ownerNodeId="root-0" as never;
  for(let i=0;i<80;i++)projection.nodes.push({...nodes[0],id:"old-"+i,rootNodeId:"old-"+i,providerTurnId:null});
 }
 if(scenario==="historical-provider")for(let i=0;i<20;i++)projection.providerThreads.push({...provider,id:"other-"+i});
 if(scenario==="child-crowding")for(let i=0;i<12;i++){
  projection.nodes.push({...nodes[0],id:"child-"+i,kind:"subagent",providerTurnId:"child-turn-"+i});
  projection.providerTurns.push({...turns[6],id:"child-turn-"+i,nodeId:"child-"+i});
 }
 if(scenario==="owner-foreign"||scenario==="owner-nonself"){
  provider.ownerNodeId="bad-owner" as never;
  projection.nodes.push({...nodes[0],id:"bad-owner",threadId:scenario==="owner-foreign"?"foreign":threadId,rootNodeId:"not-self"});
 }
 if(scenario==="foreign-reverse"){
  projection.providerTurns.push({...turns[0],id:"foreign-pointer",providerThreadId:"foreign",nodeId:"foreign"});
  for(const n of nodes)n.providerTurnId="foreign-pointer";
 }
 if(scenario==="snapshot-truncation"){
  for(const t of turns)t.turnTokenUsage={...turns[0]!.turnTokenUsage!};
  for(let i=7;i<11;i++){
   const n={...nodes[0],id:"root-"+i,rootNodeId:"root-"+i,runId:"run-"+i,providerTurnId:"turn-"+i};
   projection.nodes.push(n);projection.runs.push({...runs[0],id:n.runId,rootNodeId:n.id,ordinal:i+1});
   projection.providerTurns.push({...turns[0],id:n.providerTurnId,nodeId:n.id,ordinal:i+1});
  }expected=960;expectedTurns=8;
 }
 if(scenario==="stream-child-crowding"){
  for(const t of turns)t.turnTokenUsage={...turns[0]!.turnTokenUsage!};
  const n={...nodes[0],id:"eighth",rootNodeId:"eighth",runId:"eighth-run",providerTurnId:"eighth-turn"};
  projection.nodes.push(n);projection.runs.push({...runs[0],id:n.runId,rootNodeId:n.id,ordinal:8});
  projection.providerTurns.push({...turns[0],id:n.providerTurnId,nodeId:n.id,ordinal:8});expected=960;expectedTurns=8;
 }
 if(scenario==="poison-reintroduction")projection.nodes.push({...nodes[0]});
 if(scenario==="qualified-crowding"){
  projection.nodes=[nodes[0]];projection.runs=[runs[0]];projection.providerTurns=[turns[0]];
  for(let i=0;i<8;i++){
   const n={...nodes[0],id:"bad-root-"+i,rootNodeId:"bad-root-"+i,providerThreadId:"bad-provider-"+i,providerTurnId:"bad-turn-"+i};
   projection.nodes.push(n);projection.providerThreads.push({...provider,id:n.providerThreadId,ownerNodeId:"bad-owner-"+i});
   projection.nodes.push({...n,id:"bad-owner-"+i,kind:"subagent"});
   projection.providerTurns.push({...turns[0],id:n.providerTurnId,nodeId:n.id,providerThreadId:n.providerThreadId});
  }expected=120;expectedTurns=1;
 }
 if(scenario==="same-provider-root-pointer"){nodes[0]!.providerTurnId=turns[1]!.id;expected=480;expectedTurns=4;}
 if(scenario==="same-provider-attempt-pointer"){
  projection.attempts=[{id:"attempt-a",runId:runs[0]!.id,attemptOrdinal:1,rootNodeId:nodes[0]!.id,providerInstanceId:"custom",providerThreadId:"provider",providerTurnId:"other-attempt-turn",reason:"initial",status:"completed",startedAt:stamp,completedAt:stamp}];
  turns[0]!.runAttemptId="attempt-a" as never;
  projection.providerTurns.push({...turns[0],id:"other-attempt-turn",runAttemptId:"attempt-b",turnTokenUsage:undefined});
  expected=600;expectedTurns=5;
 }
 if(scenario==="nullable-forward")projection.nodes=nodes.map(n=>({...n,providerThreadId:null}));
 if(scenario==="long-stream-pinned-owner")provider.ownerNodeId="root-0" as never;
 let sequence=1;
 const event=(type:string,payload:unknown)=>({kind:"event",sequence:++sequence,event:{id:"event-"+sequence,threadId,occurredAt:stamp,type,payload}});
 const snapshot=()=>({kind:"snapshot",snapshotSequence:++sequence,projection:structuredClone(projection)});
 let values:unknown[]=[snapshot()];
 if(scenario==="reorder")values=[...turns.map(t=>event("provider-turn.updated",t)),...runs.map(r=>event("run.updated",r)),event("provider-thread.updated",provider),...nodes.map(n=>event("node.updated",n))];
 if(scenario==="same-provider-root-pointer"||scenario==="same-provider-attempt-pointer")values.push(event("provider-turn.updated",turns[0]),event("node.updated",nodes[0]));
 if(scenario==="replay")values.push(snapshot(),event("provider-turn.updated",turns[0]),event("provider-turn.updated",turns[0]));
 if(scenario==="correction"){values.push(event("provider-turn.updated",{...turns[0],turnTokenUsage:{...turns[0]!.turnTokenUsage,inputTokens:0,outputTokens:0,cachedInputTokens:0,cacheCreationTokens:0,reasoningTokens:0}}));expected=5*120;}
 if(scenario==="withdraw"){values.push(event("run.updated",{...runs[0],threadId:"foreign"}));expected=5*120;expectedTurns=5;}
 if(scenario==="snapshot-removal"){projection.providerTurns=[];values.push(snapshot());expected=0;expectedTurns=0;}
 if(scenario==="eviction"){
  for(let i=7;i<11;i++){
   const n={...nodes[0],id:"root-"+i,rootNodeId:"root-"+i,runId:"run-"+i,providerTurnId:"turn-"+i};
   values.push(event("provider-turn.updated",{...turns[0],id:n.providerTurnId,nodeId:n.id,ordinal:i+1}),event("run.updated",{...runs[0],id:n.runId,rootNodeId:n.id,ordinal:i+1}),event("node.updated",n));
  }expected=7*120;expectedTurns=7;
 }
 if(scenario==="completed-time")values.push({...event("provider-turn.updated",turns[0]),event:{id:"late",threadId,occurredAt:"2026-10-18T00:00:10.000Z",type:"provider-turn.updated",payload:turns[0]}});
 if(scenario==="stream-child-crowding")for(let i=0;i<12;i++){
  values.push(event("node.updated",{...nodes[0],id:"stream-child-"+i,kind:"subagent",providerTurnId:"stream-child-turn-"+i}),
   event("provider-turn.updated",{...turns[6],id:"stream-child-turn-"+i,nodeId:"stream-child-"+i}));
 }
 if(scenario==="root-conflict-reintroduction"){
  values.push(event("node.updated",{...nodes[0],threadId:"foreign"}),event("node.updated",nodes[0]),event("provider-turn.updated",turns[0]));expected=600;expectedTurns=5;
 }
 if(scenario==="snapshot-truncation")values.push(snapshot());
 if(scenario==="poison-reintroduction"){
  for(let i=0;i<100;i++)values.push(event("node.updated",{...nodes[0],id:"rotated-"+i,rootNodeId:"rotated-"+i,providerTurnId:null}));
  values.push(event("node.updated",nodes[0]),event("provider-turn.updated",turns[0]));
 }
 if(scenario==="stream-overflow"){
  for(let i=0;i<70;i++)values.push(event("node.updated",{...nodes[0],id:"overflow-"+i,rootNodeId:"overflow-"+i,providerTurnId:null}));
  values.push(event("node.updated",nodes[0]),event("provider-turn.updated",turns[0]));
 }
 if(scenario==="nullable-forward"){
  values.push(event("provider-thread.updated",provider));
  for(const n of nodes)values.push(event("node.updated",{...n,providerThreadId:null}),event("node.updated",n),event("provider-turn.updated",turns[nodes.indexOf(n)]));
 }
 if(scenario==="conflicting-forward"){
  values.push(event("node.updated",{...nodes[0],providerThreadId:"other"}),event("node.updated",nodes[0]),event("provider-turn.updated",turns[0]));expected=600;expectedTurns=5;
 }
 if(scenario==="poison-overflow"){
  for(let i=0;i<70;i++){
   const n={...nodes[0],id:"poison-"+i,rootNodeId:"poison-"+i,providerTurnId:null};
   values.push(event("node.updated",n),event("node.updated",{...n,threadId:"foreign"}));
  }
  values.push(event("node.updated",nodes[0]),event("provider-turn.updated",turns[0]));expected=0;expectedTurns=0;
 }
 if(scenario==="long-stream"||scenario==="long-stream-pinned-owner"){
  const latest:any[]=[];
  for(let i=0;i<100;i++){
   const providerId=scenario==="long-stream"?"stream-provider-"+i:"provider";
   const n={...nodes[0],id:"stream-root-"+i,rootNodeId:"stream-root-"+i,runId:"stream-run-"+i,providerThreadId:providerId,providerTurnId:"stream-turn-"+i};
   const r={...runs[0],id:n.runId,rootNodeId:n.id,providerThreadId:providerId};
   const a={id:"stream-attempt-"+i,runId:r.id,attemptOrdinal:1,rootNodeId:n.id,providerInstanceId:"custom",providerThreadId:providerId,providerTurnId:n.providerTurnId,reason:"initial",status:"completed",startedAt:stamp,completedAt:stamp};
   const t={...turns[0],id:n.providerTurnId,nodeId:n.id,providerThreadId:providerId,runAttemptId:a.id};
   if(scenario==="long-stream")values.push(event("provider-thread.updated",{...provider,id:providerId,ownerNodeId:n.id}));
   values.push(event("node.updated",n),event("run.updated",r),event("run-attempt.updated",a),event("provider-turn.updated",t));
   for(let j=0;j<3;j++){
    const id="noise-"+i+"-"+j;
    values.push(event("node.updated",{...n,id,kind:"subagent",parentNodeId:n.id,providerTurnId:id}),
     event("run.updated",{...r,id}),event("run-attempt.updated",{...a,id}),
     event("provider-turn.updated",{...t,id,nodeId:id}));
   }
   latest.push(t);if(latest.length>8)latest.shift();
  }
  for(const t of latest)values.push(event("provider-turn.updated",t));
  expected=960;expectedTurns=8;
 }
 values.push({kind:"synchronized"});
 const seen:import("../../src/t3/adapter.ts").MissionDetailEvent[]=[];
 const model=new MissionModel(false,()=>now);
 model.shell({kind:"snapshot",sequence:1,threads:[{id:threadId,title:thread.title,status:"running",providerInstanceId:"custom",modelSelection:thread.modelSelection,latestRunId:"run-6",activeRunId:"run-6",latestRunStartedAt:stamp,latestRunCompletedAt:null,lastErrorClass:null,usageLimitResetAt:null,limitRecovery:null,relationshipToParent:null,archived:false,deleted:false}]});
 model.shell({kind:"synchronized"});
 wss.on("connection",socket=>socket.on("message",data=>{
  const req=JSON.parse(String(data));if(req._tag==="Ping")socket.send(JSON.stringify({_tag:"Pong"}));
  if(req._tag==="Request")socket.send(JSON.stringify({_tag:"Chunk",requestId:req.id,values}));
 }));
 const timer=setTimeout(()=>controller.abort(),4000);
 try{
  await assert.rejects(connectMissionThread({serverUrl:await listen(server),token:"fixture",signal:controller.signal},threadId,undefined,e=>{seen.push(e);if(e.kind!=="cursor")model.detail(threadId,e);if(e.kind==="synchronized")controller.abort();}));
  assert.ok(seen.some(e=>e.kind==="synchronized"),"official nullable schema must decode");

  const usage=model.snapshot().agents[0]!.details.usage;
  assert.equal(usage.total,expected||null,scenario);assert.equal(usage.turns,expectedTurns,scenario);
  if(scenario==="completed-time")assert.equal(usage.observedAt,now);
  if(scenario.startsWith("long-stream")){
   const retained=seen.filter(e=>e.kind==="turn-usage"&&e.usage.usageStatus==="complete").slice(-8);
   assert.deepEqual(retained.map(e=>e.kind==="turn-usage"?e.id:""),Array.from({length:8},(_,i)=>"stream-turn-"+(92+i)),"latest eight dependencies survive rotation");
  }
  if(expectedTurns){assert.equal(usage.cacheWrite,0);assert.equal(usage.coverage,scenario==="stream-child-crowding"?"observed":"partial",scenario);assert.equal(usage.rate,null);}

  assert.equal(model.snapshot().agents.length,1,"base row survives missing ownership details");
  assert.deepEqual(model.snapshot().agents[0]!.details.context,["owned","historical-owner","owner-nonself","long-stream-pinned-owner"].includes(scenario)?{used:500,max:1000}:null);
  if(!["owned","historical-owner","owner-nonself","long-stream-pinned-owner"].includes(scenario))assert.ok(!seen.some(e=>e.kind==="metadata"&&e.work.monitors===1),"usage path does not admit provider roster");
 }finally{clearTimeout(timer);for(const socket of wss.clients)socket.terminate();wss.close();server.close();}
});
