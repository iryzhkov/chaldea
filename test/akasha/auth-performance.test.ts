import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { rig, event, project, N } from "./helpers.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { hash } from "../../src/akasha/schema.ts";

test("synthetic 1000-event page measures durable authorization cost", { timeout: 120_000 }, async () => {
  const r = await rig("operator"), boot = performance.now();
  try {
    // Six distinct synthetic issuer IDs, five ceilings each; no production data.
    const key = r.bundle.keys[0]!;
    const keys = Array.from({ length: 6 }, (_, i) => ({ ...structuredClone(key),
      issuer: i ? "chaldea:fixture-" + i : key.issuer, kid: "host-" + (i + 1),
      public_key: i ? { ...key.public_key, x: Buffer.alloc(32, i).toString("base64url") } : key.public_key,
      ceilings: Array.from({ length: 5 }, (_, j) => ({ ...structuredClone(key.ceilings[0]!),
        profile: j ? "fixture-profile-" + j : key.ceilings[0]!.profile })) }));
    await r.install({ ...r.bundle, sequence: 2, keys });
    const check = r.clock.check.bind(r.clock), transaction = r.state.transaction.bind(r.state);
    let checks = 0, transactions = 0, clockMs = 0, recheckMs = 0;
    r.state.transaction = fn => { transactions++; return transaction(fn); };
    r.clock.check = () => {
      r.sample = { ...r.sample, unixSeconds: Math.floor(Date.now() / 1000),
        monotonicSeconds: 100 + (performance.now() - boot) / 1000 };
      const start = performance.now(); checks++;
      try { return check(); } finally { clockMs += performance.now() - start; }
    };
    const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
    const p = await r.auth.authorize(token, "read");
    checks = transactions = clockMs = 0;
    const start = performance.now();
    for (let i = 0; i < 30; i++) await p.recheck();
    console.log(JSON.stringify({ fixture: "30-rechecks", ms: performance.now() - start, checks, transactions, clockMs }));
    assert.equal(checks, 30, "one fresh durable clock check per ongoing authorization");
    assert.equal(transactions, 30, "no nested durable transactions per ongoing authorization");
    for (let i = 1; i <= 1000; i++) {
      const e = event(i); e.body = "x".repeat(400); r.store.admit(e, hash("synthetic-" + i), N);
    }
    project(r.store);
    const authorize = r.auth.authorize.bind(r.auth);
    r.auth.authorize = async (token, action) => {
      const p = await authorize(token, action), recheck = p.recheck.bind(p);
      p.recheck = async () => { const start = performance.now(); try { await recheck(); }
        finally { recheckMs += performance.now() - start; } };
      return p;
    };
    const server = httpServer(new Ingress(r.auth, r.store, () => {}));
    let writes = 0, bytes = 0;
    server.on("request", (_req, res) => {
      const write = res.write.bind(res);
      res.write = ((value: string) => {
        assert.ok(Buffer.byteLength(value) <= 65536);
        writes++; bytes += Buffer.byteLength(value); return write(value);
      }) as typeof res.write;
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    checks = transactions = clockMs = 0;
    const pageStart = performance.now();
    try {
      const response = await fetch("http://127.0.0.1:" + (server.address() as { port: number }).port + "/api/v1/events?limit=1000",
        { headers: { authorization: "Bearer " + token } });
      assert.equal(response.status, 200);
      const page = await response.json() as { events: unknown[] };
      assert.equal(page.events.length, 1000);
      console.log(JSON.stringify({ fixture: "1000-event-page", ms: performance.now() - pageStart,
        checks, transactions, clockMs, recheckMs, writes, bytes,
        trustBytes: Buffer.byteLength(r.state.get("trust")!) }));
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  } finally { r.close(); }
});
