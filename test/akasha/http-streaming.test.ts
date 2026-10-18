import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { rig, event, project, N } from "./helpers.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { hash } from "../../src/akasha/schema.ts";

test("613-row real-clock HTTP history stays complete, byte-bounded and cursor compatible", { timeout: 120_000 }, async () => {
  const r = await rig("operator"), boot = performance.now();
  const check = r.clock.check.bind(r.clock);
  // Production samples advance even within one wall second. A frozen fixture
  // avoids the DELETE/FULL writes that made the real history route time out.
  let checks = 0;
  r.clock.check = () => {
    r.sample = { ...r.sample, unixSeconds: Math.floor(Date.now() / 1000),
      monotonicSeconds: 100 + (performance.now() - boot) / 1000 };
    checks++; return check();
  };
  for (let i = 1; i <= 613; i++) {
    const e = event(i); e.body = "🌗".repeat(150); e.title = "history " + i;
    r.store.admit(e, hash("history-" + i), N);
  }
  project(r.store);
  const server = httpServer(new Ingress(r.auth, r.store, () => {}));
  const writes: Array<{ bytes: number; checks: number }> = [];
  server.on("request", (_req, res) => {
    const write = res.write.bind(res);
    res.write = ((value: string, ...args: unknown[]) => {
      writes.push({ bytes: Buffer.byteLength(value), checks }); return (write as Function)(value, ...args);
    }) as typeof res.write;
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
  const get = (path: string) => fetch(base + path, { headers: { authorization: "Bearer " + token } });
  try {
    const response = await get("/api/entries?since=180d&limit=1000");
    assert.equal(response.status, 200);
    const rows = await response.json() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 613);
    assert.deepEqual(rows.map(row => row.id), Array.from({ length: 613 }, (_, i) => 613 - i));
    assert.ok(writes.every(w => w.bytes <= 65536), "UTF-8 chunks exceed 64 KiB");
    assert.ok(writes.length < 20, "per-row durable rechecks exhaust the unchanged response deadline");
    assert.ok(writes.every((w, i) => i === 0 || w.checks > writes[i - 1]!.checks),
      "each actual network write must recheck real authorization");
    assert.deepEqual(await (await get("/api/entries/613")).json(), rows[0]);
    const filtered = await (await get("/api/entries?since=180d&limit=1000&host=agent-a&source=" + r.r.source)).json();
    assert.deepEqual(filtered, rows);
    assert.deepEqual(await (await get("/api/entries?since=180d&host=other")).json(), []);
    const native = await (await get("/api/v1/events?limit=500")).json() as { events: Array<{ event_id: string }>; next_cursor: string };
    assert.equal(native.events.length, 500); assert.ok(native.next_cursor);
    const next = await (await get("/api/v1/events?limit=500&cursor=" + native.next_cursor)).json() as typeof native;
    assert.equal(next.events.length, 113); assert.equal(next.next_cursor, null);
    assert.equal(new Set([...native.events, ...next.events].map(e => e.event_id)).size, 613);
    assert.ok(writes.every(w => w.bytes <= 65536));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});

for (const failure of ["expiry", "revocation", "clock", "disconnect"] as const) {
  test("stream stops after backpressure " + failure + " before another network chunk", async () => {
    const r = await rig("operator");
    for (let i = 1; i <= 4; i++) {
      const e = event(i); e.body = "x".repeat(40_000); r.store.admit(e, hash("pressure-" + i), N);
    }
    project(r.store);
    const server = httpServer(new Ingress(r.auth, r.store, () => {}));
    let writes = 0, checks = 0, afterWait = false, rejection: Promise<void> | undefined;
    const authorize = r.auth.authorize.bind(r.auth);
    r.auth.authorize = async (t, action) => {
      const p = await authorize(t, action), recheck = p.recheck;
      p.recheck = async () => { if (afterWait) checks++; await recheck(); };
      return p;
    };
    server.on("request", (_req, res) => {
      const write = res.write.bind(res);
      res.write = ((value: string) => {
        writes++; write(value);
        // Model a full writable buffer, but retain the real verifier and clock.
        setImmediate(() => {
          if (failure === "expiry") r.sample = { ...r.sample, unixSeconds: N + 301, monotonicSeconds: 401 };
          if (failure === "clock") r.sample = { ...r.sample, healthy: false };
          rejection = failure === "revocation" ? r.install({ ...r.bundle, sequence: 2, keys: [] }) : Promise.resolve();
          void rejection.then(() => {
            afterWait = true;
            if (failure === "disconnect") res.destroy(); else res.emit("drain");
          });
        });
        return false;
      }) as typeof res.write;
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    try {
      const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
      await assert.rejects(async () => {
        const response = await fetch("http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/entries?limit=4",
          { headers: { authorization: "Bearer " + token } });
        await response.text();
      });
      assert.equal(writes, 1, "no later data is released after a failed wait");
      if (failure !== "disconnect") assert.ok(checks > 0, "authorization must run again after drain");
      await rejection;
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
  });
}

test("single existing oversized legacy row retains JSON and escaped HTML compatibility", async () => {
  const r = await rig("operator"), e = event(1);
  e.body = "<&".repeat(50_000); r.store.admit(e, hash("large-legacy"), N); project(r.store);
  const server = httpServer(new Ingress(r.auth, r.store, () => {}));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  try {
    const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
    const get = (path: string) => fetch("http://127.0.0.1:" + (server.address() as { port: number }).port + path,
      { headers: { authorization: "Bearer " + token } });
    const rows = await (await get("/api/entries?limit=1")).json() as Array<{ body: string }>;
    assert.equal(rows[0]!.body, e.body);
    const html = await (await get("/?limit=1")).text();
    assert.ok(html.includes("&lt;&amp;".repeat(50_000)) && !html.includes("<&"));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});
