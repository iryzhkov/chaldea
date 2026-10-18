import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { MissionModel } from "./model.ts";
const assets = new Map(["core.css","dir-flight.css","palettes.js","core.js","client.js"].map(name => ["/"+name, {
  body: readFileSync(new URL("./static/"+name, import.meta.url)), type: name.endsWith(".css") ? "text/css" : "text/javascript",
}]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mission control</title><link rel="stylesheet" href="/core.css"><link rel="stylesheet" href="/dir-flight.css"><body data-default-dir="flight" data-default-palette="mocr-1969"><div id="board"><div id="top"><span class="brand"><span class="code">MOCR</span> · PC canary</span><span id="urgent"></span><nav id="tabs"></nav><select id="pick"></select><span id="navstate"></span><span id="clock"></span><span id="globalfresh"></span></div><div id="view"></div></div><script src="/palettes.js"></script><script src="/client.js"></script></body></html>`;
export function missionServer(model: MissionModel, maxClients = 8) {
  if (!Number.isInteger(maxClients) || maxClients < 1 || maxClients > 8) throw new Error("invalid_client_limit");
  const clients = new Set<ServerResponse>();
  const publish = () => {
    const body = JSON.stringify(model.snapshot());
    if (Buffer.byteLength(body) > 128 * 1024) throw new Error("snapshot_too_large");
    for (const res of clients) if (!res.write("event: snapshot\ndata: " + body + "\n\n")) { clients.delete(res); res.destroy(); }
  };
  const unsubscribe = model.subscribe(publish);
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 5000, headersTimeout: 5000 }, (req,res) => {
    res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    res.setHeader("X-Content-Type-Options","nosniff");
    res.setHeader("Referrer-Policy","no-referrer");
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Cross-Origin-Resource-Policy","same-origin");
    const address = server.address();
    const expectedHost = typeof address === "object" && address ? "127.0.0.1:" + address.port : "";
    if (req.headers.host !== expectedHost || req.headers.origin && req.headers.origin !== "http://" + expectedHost ||
        req.headers["sec-fetch-site"] && !["same-origin","none"].includes(String(req.headers["sec-fetch-site"]))) { res.writeHead(403).end(); return; }
    if (req.method !== "GET") { res.setHeader("Allow","GET"); res.writeHead(405).end(); return; }
    if (req.url === "/api/snapshot") { res.setHeader("Content-Type","application/json"); res.end(JSON.stringify(model.snapshot())); return; }
    if (req.url === "/api/events") {
      if (clients.size >= maxClients) { res.writeHead(503).end(); return; }
      res.writeHead(200, { "Content-Type":"text/event-stream", "Connection":"keep-alive", "X-Accel-Buffering":"no" });
      clients.add(res);
      const release = () => clients.delete(res);
      res.once("close",release); res.once("error",release);
      res.write("retry: 2000\n\n"); publish(); return;
    }
    if (req.url === "/" || req.url?.startsWith("/?")) { res.setHeader("Content-Type","text/html"); res.end(html); return; }
    const asset = assets.get(req.url ?? "");
    if (!asset) { res.writeHead(404).end(); return; }
    res.setHeader("Content-Type",asset.type); res.end(asset.body);
  });
  server.maxConnections = 24;
  server.keepAliveTimeout = 5000;
  // Heartbeats only maintain browser transport; they never claim fresh upstream data.
  const heartbeat = setInterval(() => { publish(); for (const r of clients) if (!r.write(": keepalive\n\n")) { clients.delete(r); r.destroy(); } }, 15_000);
  heartbeat.unref();
  server.once("close", () => { clearInterval(heartbeat); unsubscribe(); });
  return {
    server, clientCount: () => clients.size,
    listen: (port = 7392) => new Promise<void>((resolve,reject) => { server.once("error",reject); server.listen(port,"127.0.0.1",resolve); }),
    close: () => new Promise<void>(resolve => { for (const r of clients) r.destroy(); clients.clear(); server.close(() => resolve()); }),
  };
}
