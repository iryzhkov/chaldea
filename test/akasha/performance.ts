import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { once } from "node:events";
import { rig, N } from "./helpers.ts";
import { NEW_FEED_ID } from "../../src/akasha/schema.ts";
import { eventPage, feedRows } from "../../src/akasha/compat.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { Authorization } from "../../src/akasha/auth.ts";

const r = await rig("operator");
try {
  // SQL metadata fixture isolates index/reader cost; no 100k publishes on the gaming PC.
  const insertEvent = r.store.db.prepare("INSERT INTO events(event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry,session,tool,client) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  const insertFeed = r.store.db.prepare("INSERT INTO feed_entries VALUES(?,?,?,?,?,?,?,?,?,?)");
  const old = new Date((N - 8 * 86400) * 1000).toISOString(), recent = new Date(N * 1000).toISOString();
  for (let start = 0; start < 100000; start += 1000) r.store.transaction(() => {
    for (let i = start; i < start + 1000; i++) {
      const id = String(i).padStart(64, "0"), source = i === 99999 ? r.r.source : "other", time = i === 99999 ? recent : old;
      insertEvent.run(id, "{}", r.r.issuer, r.r.profile, r.r.project, source, r.r.host, "feed_post", time, time,
        i < 1000 ? N - 1 : N + 180 * 86400, "session-" + i, "tool", "client");
      if (i < 12000 || i === 99999) insertFeed.run(NEW_FEED_ID + i, id, time, r.r.host, source, "info", "title", "body", "", "");
    }
  }, 4 * 1024 ** 2);
  const expiredPlan = r.store.db.prepare("EXPLAIN QUERY PLAN SELECT seq,event_id FROM events WHERE expiry<=? ORDER BY expiry,seq LIMIT 10").all(N);
  const pressurePlan = r.store.db.prepare("EXPLAIN QUERY PLAN SELECT seq,event_id FROM events ORDER BY received_at,seq LIMIT 10").all();
  assert.ok(JSON.stringify(expiredPlan).includes("events_expiry")); assert.ok(!JSON.stringify(expiredPlan).includes("TEMP B-TREE"));
  assert.ok(JSON.stringify(pressurePlan).includes("events_received")); assert.ok(!JSON.stringify(pressurePlan).includes("TEMP B-TREE"));
  const times: number[] = [];
  for (let i = 0; i < 100; i++) { const start = performance.now(); r.store.prune(N, 10); times.push(performance.now() - start); }
  assert.equal(r.store.scalar("SELECT count(*) FROM events WHERE expiry<=?", N), 0);
  const used = (r.store.scalar("PRAGMA page_count") - r.store.scalar("PRAGMA freelist_count")) * 4096;
  r.store.budget.main = Math.ceil(used / 0.86 / 4096) * 4096;
  const pressureStart = performance.now(); r.store.prune(N, 10); const pressureMs = performance.now() - pressureStart;
  assert.ok(pressureMs < 2000, "100k pressure prune batch <=2s");
  assert.ok(Math.max(...times) < 2000, "100k expiry prune batch <=2s");
  const scope = { issuer: r.r.issuer, profile: r.r.profile, project: r.r.project, source: r.r.source, host: r.r.host, global: true };
  assert.equal([...feedRows(r.store, new URLSearchParams("since=7d&limit=50"), scope, N)].length, 1);
  assert.equal([...feedRows(r.store, new URLSearchParams("since=7d&source=missing"), scope, N)].length, 0);
  assert.equal([...feedRows(r.store, new URLSearchParams("since=7d&limit=50"), { ...scope, global: false }, N)].length, 1);
  const { global_read: _, ...registration } = r.r;
  const auth = new Authorization([{ ...registration, mode: "service" }], r.trust, r.clock);
  const server = httpServer(new Ingress(auth, r.store, () => {})); server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
    const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
    for (const path of ["/api/entries?since=7d&limit=50", "/api/entries?since=7d&source=" + r.r.source,
      "/api/entries?since=7d&source=missing", "/api/entries?since=7d&grep=no-match"]) {
      const result = await fetch(base + path, { headers: { authorization: "Bearer " + token } });
      assert.equal(result.status, 200, path); const body = await result.json(); assert.ok(Array.isArray(body));
    }
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  // Exercise the previously quadratic default window on 60,000 matching rows.
  r.store.db.prepare("UPDATE events SET occurred_at=? WHERE seq IN (SELECT seq FROM events ORDER BY seq DESC LIMIT 60000)").run(recent);
  const eventPageTimings: Record<string, number> = {};
  for (const count of [100, 1000]) {
    const started = performance.now(), page = eventPage(r.store, new URLSearchParams("limit=" + count), scope, N);
    assert.equal([...page.rows].length, count); assert.ok(page.next());
    eventPageTimings[String(count)] = performance.now() - started;
    assert.ok(eventPageTimings[String(count)]! < 500, "60k default event page <=500ms at limit " + count);
  }
  const first = eventPage(r.store, new URLSearchParams("limit=100"), scope, N);
  assert.equal([...first.rows].length, 100);
  const cursor = first.next()!;
  const second = eventPage(r.store, new URLSearchParams("limit=100&cursor=" + cursor), scope, N);
  assert.equal([...second.rows].length, 100);
  assert.equal([...eventPage(r.store, new URLSearchParams("limit=0"), scope, N).rows].length, 0);
  const result = { rows: 100000, defaultEventWindowRows: 60000, eventPageTimings, expiryMaxBatchMs: Math.max(...times), pressureBatchMs: pressureMs, expiredPlan, pressurePlan,
    sparseHttp: "pass, >10000 older feed rows and source-scoped reader", walBytes: r.store.walBytes() };
  if (process.env.AKASHA_RESULTS) writeFileSync(process.env.AKASHA_RESULTS.replace("results.json", "performance.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result) + "\n");
} finally { r.close(); }
