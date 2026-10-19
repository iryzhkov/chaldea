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

for(const denied of [false,true])test("host resources share the shell connection; denial preserves thread capture, denied="+denied,async()=>{
 const server=createServer(),wss=new WebSocketServer({server}),controller=new AbortController();
 const sample={sampledAt:1000,cpuUtilization:0.2,cpuCount:8,availableMemoryBytes:400,totalMemoryBytes:1000};
 let connections=0,synchronized=false,resources:any=null;
 const requests:string[]=[];
 const finish=()=>{if(synchronized&&resources)controller.abort();};
 wss.on("connection",socket=>{connections++;socket.on("message",data=>{
  const req=JSON.parse(String(data));if(req._tag==="Ping"){socket.send(JSON.stringify({_tag:"Pong"}));return;}if(req._tag!=="Request")return;
  requests.push(req.tag);
  if(req.tag==="orchestration.subscribeShell")socket.send(JSON.stringify({_tag:"Chunk",requestId:req.id,values:[{kind:"synchronized"}]}));
  else if(req.tag==="server.getHostResources")socket.send(JSON.stringify({_tag:"Exit",requestId:req.id,exit:denied?{_tag:"Failure",cause:[{_tag:"Fail",error:{_tag:"EnvironmentAuthorizationError",message:"fixture denied",requiredScope:"orchestration:read"}}]}:{_tag:"Success",value:sample}}));
 });});
 const timer=setTimeout(()=>controller.abort(),4000);
 try{
  const serverUrl=await listen(server);
  await assert.rejects(connectShell({serverUrl,token:"fixture",signal:controller.signal},{
   onEvent:e=>{if(e.kind==="synchronized"){synchronized=true;finish();}},
   onResources:r=>{resources=r;finish();}
  }));
  assert.equal(connections,1);assert.equal(synchronized,true);assert.equal(resources.state,denied?"unavailable":"reported");
  assert.deepEqual(resources.sample,denied?null:sample);
  assert.deepEqual(new Set(requests),new Set(["orchestration.subscribeShell","server.getHostResources"]));
 }finally{clearTimeout(timer);for(const socket of wss.clients)socket.terminate();wss.close();server.close();}
});
