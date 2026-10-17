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
