import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { rig, project, event, N } from "./helpers.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { MAX_LEGACY, hash } from "../../src/akasha/schema.ts";

test("HTTP compatibility matrix: health, post/list/show, legacy normalization, full body, filters, bounds and browser", async () => {
  const r = await rig("operator");
  const ingress = new Ingress(r.auth, r.store, () => { queueMicrotask(() => project(r.store)); });
  const server = httpServer(ingress); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const read = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] }), append = await r.token();
  const get = (path: string, token = read) => fetch(base + path, { headers: { authorization: "Bearer " + token } });
  const post = (payload: unknown, key?: string, legacy = true, token = append) => fetch(base + (legacy ? "/api/entries" : "/api/v1/events"), {
    method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, body: JSON.stringify(payload),
  });
  try {
    assert.deepEqual(await (await fetch(base + "/healthz")).json(), { ok: true });
    assert.equal((await fetch(base + "/api/entries")).status, 401);
    const body = "x".repeat(250 * 1024);
    const created = await post({ title: "  " + "T".repeat(510) + " ", body, tags: "Hello hello a:b", severity: "WARN" }, "first");
    assert.equal(created.status, 201);
    const row = await created.json() as Record<string, unknown>;
    assert.deepEqual(Object.keys(row).sort(), ["id", "created_at", "host", "source", "severity", "title", "body", "tags", "link"].sort());
    assert.equal(row.body, body); assert.equal((row.title as string).length, 500); assert.equal(row.tags, "hello,a-b");
    assert.equal(row.host, "agent-a"); assert.equal(row.source, r.r.source); assert.equal(row.severity, "warn");
    const repeated = await post({ title: "  " + "T".repeat(510) + " ", body, tags: "Hello hello a:b", severity: "WARN" }, "first");
    assert.deepEqual(await repeated.json(), row);
    assert.equal((await post({ title: "different" }, "first")).status, 409);
    assert.equal((await post({ title: "ok", created_at: "2000-01-01T00:00:00Z" })).status, 400);
    assert.equal((await post({ title: "ok", host: "agent-b" })).status, 403);
    assert.equal((await post({ title: "ok", body: "x".repeat(MAX_LEGACY) })).status, 413);
    assert.equal((await post({ v: 1, kind: "report", title: "ok" }, undefined, false)).status, 400);
    assert.equal((await post({ v: 1, kind: "report", title: "ok", body: "x".repeat(64 * 1024) }, "large", false)).status, 413);
    assert.equal((await post({ v: 1, kind: "report", title: "ok", data: { status: "healthy" } }, "structured", false)).status, 201);
    assert.equal((await get("/api/entries/" + row.id)).status, 200);
    assert.deepEqual(await (await get("/api/entries/" + row.id)).json(), row);
    assert.equal((await get("/api/entries/999")).status, 404);
    for (const query of ["since=7d", "since=12h", "since=30m", "since=" + encodeURIComponent(new Date((N - 60) * 1000).toISOString()),
      "host=agent-a", "source=" + r.r.source, "severity=WARN", "tag=hello", "grep=T%", "limit=1000"]) {
      const response = await get("/api/entries?" + query); assert.equal(response.status, 200, query);
      const rows = await response.json() as unknown[]; assert.ok(rows.length > 0, query);
    }
    assert.deepEqual(await (await get("/api/entries?host=other")).json(), []);
    assert.deepEqual(await (await get("/api/entries?limit=0")).json(), []);
    for (const q of ["limit=-1", "limit=wat", "since=nonsense"]) assert.equal((await get("/api/entries?" + q)).status, 400, q);
    assert.equal((await get("/?token=" + read)).status, 403);
    const page = await get("/"); assert.equal(page.status, 200);
    const html = await page.text(); assert.ok(html.includes("fleet feed") && !html.includes(read));
    assert.equal((await get("/api/entries?token=" + read)).status, 403);
    const events = await get("/api/v1/events?limit=1");
    const data = await events.json() as { events: unknown[]; next_cursor: string };
    assert.equal(data.events.length, 1); assert.ok(data.next_cursor);
    const next = await get("/api/v1/events?limit=1&cursor=" + data.next_cursor); assert.equal(next.status, 200);
    assert.equal((await get("/api/v1/events?from=2000-01-01T00:00:00Z")).status, 400);
    assert.equal((await get("/api/v1/health")).status, 200);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});

test("HTTP own-source negatives and pending/receipt access: no query-token, read, show, list or forged identity escape", async () => {
  const r = await rig();
  const ingress = new Ingress(r.auth, r.store, () => {}, { waitMs: 0 }), server = httpServer(ingress);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port, token = await r.token();
  const get = (path: string, t = token) => fetch(base + path, { headers: { authorization: "Bearer " + t } });
  const post = (payload: unknown, t = token, key = "daily-report") => fetch(base + "/api/v1/events", {
    method: "POST", headers: { authorization: "Bearer " + t, "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(payload) });
  try {
    for (const path of ["/", "/index.html", "/api/entries", "/api/entries/1", "/api/v1/events", "/api/v1/health"])
      assert.ok((await get(path)).status >= 400, path);
    const payload = { v: 1, kind: "report", title: "ok" };
    for (const k of ["source", "host", "run_id", "project"])
      assert.equal((await post({ ...payload, [k]: "other" }, token, k)).status, 403);
    assert.equal((await post({ ...payload, received_at: new Date().toISOString() })).status, 400);
    assert.equal((await post(payload, await r.token({ aud: "feed" }))).status, 401);
    const pending = await post(payload); assert.equal(pending.status, 503);
    assert.equal((await pending.json() as { pending: boolean }).pending, true);
    const receipt = await get("/api/v1/receipts?kind=report&key=daily-report"); assert.equal(receipt.status, 200);
    assert.equal((await get("/api/v1/receipts?kind=report&key=other")).status, 404);
    assert.equal((await post({ ...payload, title: "conflict" })).status, 409);
    project(r.store);
    assert.equal((await post(payload)).status, 201);
    const refreshed = await r.token({ run_id: "run-2" });
    assert.equal((await get("/api/v1/receipts?kind=report&key=daily-report", refreshed)).status, 404);
    assert.ok((await get("/?token=" + token)).status >= 400);
    const bytes = r.store.db.prepare("SELECT envelope FROM events").get() as { envelope: string };
    assert.ok(!bytes.envelope.includes(token));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});


test("POST retry reloads a tombstone if maintenance prunes during the last authorization wait", async () => {
  const r = await rig("service");
  const ingress = new Ingress(r.auth, r.store, () => {}, { waitMs: 0 });
  const token = await r.token(), principal = await r.auth.authorize(token, "append");
  const input = { title: "retention race" };
  await ingress.append(principal, input, "retention-race", true); project(r.store);
  const authorize = r.auth.authorize.bind(r.auth);
  r.auth.authorize = async (t, a) => {
    const p = await authorize(t, a), original = p.recheck; let checks = 0;
    p.recheck = async () => {
      await original();
      if (++checks === 4) { r.store.db.prepare("UPDATE events SET expiry=?").run(N - 1); r.store.prune(N); }
    };
    return p;
  };
  const server = httpServer(ingress); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const response = await fetch("http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/entries", {
      method: "POST", headers: { authorization: "Bearer " + token, "content-type": "application/json", "idempotency-key": "retention-race" },
      body: JSON.stringify(input),
    });
    assert.equal(response.status, 410); assert.equal((await response.json() as { error: string }).error, "payload_expired");
    assert.equal(r.store.pending(N).length, 0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});

test("source-read SQL filters hide other projects/hosts including direct numeric show", async () => {
  const r = await rig("service");
  const ingress = new Ingress(r.auth, r.store, () => {}), server = httpServer(ingress);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const e = event(1); e.project = "other"; r.store.admit(e, hash("h"), N); project(r.store);
    const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
    const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    for (const path of ["/api/entries", "/api/v1/events?project=other"]) {
      const response = await fetch(base + path, { headers: { authorization: "Bearer " + token } });
      const value = await response.json(); assert.deepEqual(value, path === "/api/entries" ? [] : { events: [], next_cursor: null });
    }
    const response = await fetch(base + "/api/entries/1000000000000", { headers: { authorization: "Bearer " + token } });
    assert.equal(response.status, 404);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});
