import { AccessError } from "../access/token.ts";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { Principal } from "./auth.ts";
import type { Ingress } from "./ingress.ts";
import { article, eventPage, feedRows, limit } from "./compat.ts";
import { ensure, HttpError, MAX_EVENT, MAX_LEGACY, parse } from "./schema.ts";
import type { Receipt } from "./store.ts";

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data) + "\n");
}
async function body(req: IncomingMessage, max: number): Promise<Buffer> {
  ensure(!req.headers["content-encoding"], "compression_forbidden", 415);
  ensure(req.headers["content-type"]?.split(";")[0]?.trim() === "application/json", "json_required", 415);
  const length = req.headers["content-length"];
  if (length) ensure(/^\d+$/.test(length) && Number(length) <= max, "request_too_large", 413);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const collect = async () => {
    const chunks: Buffer[] = []; let size = 0;
    for await (const b of req.iterator({ destroyOnReturn: false })) { size += b.length; ensure(size <= max, "request_too_large", 413); chunks.push(b); }
    return Buffer.concat(chunks);
  };
  try {
    return await Promise.race([collect(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { req.pause(); reject(new HttpError(408, "body_timeout")); }, 5000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function chunk(res: ServerResponse, p: Principal, value: string): Promise<void> {
  await p.recheck();
  ensure(!res.destroyed, "reader_closed", 499);
  if (!res.write(value)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try { await once(res, "drain", { signal: controller.signal }); await p.recheck(); }
    finally { clearTimeout(timer); }
  }
}
// Coalesce small rows so durable authorization work is per bounded network
// chunk, not per SQL row. A single already-bounded legacy row may be larger.
async function fragments(res: ServerResponse, p: Principal, values: Iterable<string>): Promise<void> {
  let pending = "", bytes = 0;
  for (const value of values) {
    const size = Buffer.byteLength(value);
    if (bytes && bytes + size > 64 * 1024) {
      await chunk(res, p, pending); pending = ""; bytes = 0;
    }
    if (size > 64 * 1024) { await chunk(res, p, value); continue; }
    pending += value; bytes += size;
  }
  if (bytes) await chunk(res, p, pending);
}
function receiptView(r: Receipt): Record<string, unknown> {
  return { event_id: r.event_id, state: r.state, feed_id: r.feed_id };
}
export function httpServer(ingress: Ingress) {
  let active = 0;
  const server = createServer({ maxHeaderSize: 20 * 1024, requestTimeout: 5000, headersTimeout: 5000 }, (req, res) => {
    res.setHeader("cache-control", "no-store"); res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const run = async () => {
      const url = new URL(req.url ?? "/", "http://akasha.invalid"), path = url.pathname;
      if (req.method === "GET" && path === "/healthz") { json(res, 200, { ok: true }); return; }
      ensure(active < 8, "concurrency_limit", 503);
      active++;
      try {
        const authorization = req.headers.authorization;
        ensure(!url.searchParams.has("token"), "query_token_forbidden", 403);
        ensure(!authorization || /^Bearer [\x21-\x7e]+$/.test(authorization), "bad_token", 401);
        const token = authorization?.slice(7);
        ensure(token, "missing_token", 401);
        const receiptLookup = req.method === "GET" && path === "/api/v1/receipts";
        const action = req.method === "POST" || receiptLookup ? "append" : "read";
        let p: Principal;
        try { p = await ingress.auth.authorize(token, action); }
        catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(401, "authorization_denied"); }
        await p.recheck();
        if (p.scope.missionControlSources) ensure(req.method === "GET" && path === "/api/v1/events", "mission_control_events_only", 403);
        const deadline = setTimeout(() => res.destroy(), Math.max(1, Math.min(10_000, (p.access.validUntil - ingress.now()) * 1000)));
        res.once("close", () => clearTimeout(deadline)); res.once("finish", () => clearTimeout(deadline));
        if (req.method === "POST") {
          ensure(path === "/api/entries" || path === "/api/v1/events", "no_such_path", 404);
          const legacy = path === "/api/entries";
          const payload = parse(await body(req, legacy ? MAX_LEGACY : MAX_EVENT));
          const key = req.headers["idempotency-key"];
          ensure(key === undefined || typeof key === "string", "invalid_idempotency_key");
          let r = await ingress.append(p, payload, key, legacy);
          await p.recheck();
          const current = ingress.store.ownedReceipt(r.event_id, p.scope);
          ensure(current, "payload_expired", 410); r = current;
          if (r.state === "pending") { json(res, 503, { ...receiptView(r), pending: true, error: "pending" }); return; }
          if (r.state === "quarantined") { json(res, 422, { ...receiptView(r), error: "quarantined" }); return; }
          if (r.state === "tombstone") { json(res, 410, { ...receiptView(r), error: "payload_expired" }); return; }
          json(res, 201, legacy ? ingress.store.feed(r.feed_id!, p.scope) : receiptView(r)); return;
        }
        ensure(req.method === "GET", "method_not_allowed", 405);
        if (receiptLookup) {
          const r = await ingress.lookup(p, url.searchParams.get("kind") ?? "", url.searchParams.get("key") ?? "");
          await p.recheck();
          const current = ingress.store.ownedReceipt(r.event_id, p.scope); ensure(current, "no_such_receipt", 404);
          json(res, 200, receiptView(current)); return;
        }
        if (path === "/api/v1/health") {
          ensure(p.scope.global, "operator_required", 403);
          json(res, 200, ingress.store.health()); return;
        }
        const numeric = /^\/api\/entries\/(\d+)$/.exec(path);
        if (numeric) {
          const id = Number(numeric[1]); ensure(Number.isSafeInteger(id), "invalid_id");
          const row = ingress.store.feed(id, p.scope); ensure(row, "no_such_entry", 404);
          await p.recheck(); json(res, 200, row); return;
        }
        if (path === "/api/entries" || path === "/" || path === "/index.html") {
          const page = path !== "/api/entries"; limit(url.searchParams);
          if (page && !url.searchParams.has("since")) url.searchParams.set("since", "14d");
          const rows = feedRows(ingress.store, url.searchParams, p.scope, ingress.now());
          // Preflight only IDs (<=1000), so a LIKE budget failure returns complete error JSON.
          const ids: number[] = []; for (const row of rows) ids.push(row.id);
          await p.recheck();
          res.writeHead(200, { "content-type": page ? "text/html; charset=utf-8" : "application/json" });
          function* values(): Generator<string> {
            yield page ? "<!doctype html><meta charset=utf-8><title>fleet feed</title><style>body{font:15px system-ui;max-width:60rem;margin:auto;padding:1rem}article{border-bottom:1px solid #8885}pre{white-space:pre-wrap}</style><h1>fleet feed</h1>" : "[";
            let first = true;
            for (const id of ids) {
              const row = ingress.store.feed(id, p.scope); if (!row) continue;
              yield page ? article(row) : (first ? "" : ",") + JSON.stringify(row); first = false;
            }
            yield page ? "" : "]\n";
          }
          await fragments(res, p, values()); res.end(); return;
        }
        if (path === "/api/v1/events") {
          const page = eventPage(ingress.store, url.searchParams, p.scope, ingress.now());
          res.writeHead(200, { "content-type": "application/json" });
          function* values(): Generator<string> {
            yield '{"events":['; let first = true;
            for (const row of page.rows) { yield (first ? "" : ",") + JSON.stringify(row); first = false; }
            yield '],"next_cursor":' + JSON.stringify(page.next()) + "}\n";
          }
          await fragments(res, p, values()); res.end(); return;
        }
        throw new HttpError(404, "no_such_path");
      } finally { active--; }
    };
    void run().catch(e => {
      // Neither JOSE/SQLite errors nor URLs/headers/payloads are logged or reflected.
      if (res.headersSent) { res.destroy(); return; }
      res.setHeader("connection", "close");
      json(res, e instanceof HttpError ? e.status : e instanceof AccessError ? 401 : 503,
        { error: e instanceof HttpError ? e.message : e instanceof AccessError ? "authorization_denied" : "service_unavailable" });
    });
  });
  server.maxConnections = 32; server.keepAliveTimeout = 5000;
  return server;
}
