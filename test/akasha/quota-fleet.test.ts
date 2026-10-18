import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { rig, project, N } from "./helpers.ts";
import { Authorization } from "../../src/akasha/auth.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { hash } from "../../src/akasha/schema.ts";
import type { Envelope } from "../../src/akasha/schema.ts";
import { capacitySnapshot, mergeSnapshots } from "../../src/quota/fleet.ts";
import { accountKey } from "../../src/quota/account.ts";
import { newProvider } from "../../src/quota/headroom.ts";

test("authenticated fleet quota reads cross hosts, preserve source/project/profile/kind scope and cannot read foreign receipts", async () => {
  const r = await rig("service");
  const registration = { ...r.r, source: "quota", source_id: "quota-agent-a", quota_fleet_read: true,
    kinds: ["quota_headroom_snapshot" as const, "report" as const] };
  const bundle = structuredClone(r.bundle); bundle.sequence++;
  bundle.keys[0]!.ceilings[0]!.source = "quota";
  bundle.keys[0]!.ceilings[0]!.grants = [{ resource: "quota", actions: ["append", "read"] }];
  await r.install(bundle);
  const auth = new Authorization([registration], r.trust, r.clock);
  const ingress = new Ingress(auth, r.store, () => { queueMicrotask(() => project(r.store)); });
  const server = httpServer(ingress); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const append = await r.token({ source: "quota", grants: [{ resource: "quota", actions: ["append"] }] });
  const read = await r.token({ source: "quota", grants: [{ resource: "quota", actions: ["read"] }] });
  const get = (path: string) => fetch(base + path, { headers: { authorization: "Bearer " + read } });
  try {
    const p = newProvider("codex", "codex"); p.accountKey = accountKey("fixture-account")!;
    p.included = { state: "fresh", error: null, source: "fixture", observedAt: new Date(N * 1000).toISOString(),
      value: [{ id: "weekly", kind: "weekly", remainingPercent: 30, usedPercent: 70, windowDurationMins: 10080, resetsAt: new Date((N + 86400) * 1000).toISOString() }] };
    const snapshot = capacitySnapshot("agent-a", [p], new Set(), N * 1000);
    const response = await fetch(base + "/api/v1/events", { method: "POST",
      headers: { authorization: "Bearer " + append, "idempotency-key": "capacity:agent-a:1", "content-type": "application/json" },
      body: JSON.stringify({ v: 1, kind: "quota_headroom_snapshot", title: "Quota", data: { capacity: snapshot } }) });
    assert.equal(response.status, 201);
    const stored = r.store.db.prepare("SELECT envelope FROM events").get() as { envelope: string };
    const original: Envelope = JSON.parse(stored.envelope);
    const variants = [
      { host: "agent-b", issuer: "chaldea:agent-b", source_id: "quota-agent-b" },
      { host: "laptop", issuer: "chaldea:laptop", source_id: "quota-laptop" },
      { project: "foreign" }, { profile: "foreign" }, { source: "foreign" }, { kind: "report" as const, data: {} },
    ];
    for (let i = 0; i < variants.length; i++) {
      const e = { ...structuredClone(original), ...variants[i], event_id: hash("fleet-" + i),
        provenance: { ...original.provenance, feed_id: 1_000_000_000_001 + i } } as Envelope;
      if (e.kind === "quota_headroom_snapshot") e.data.capacity = { ...snapshot, host: e.host };
      r.store.admit(e, hash("request-" + i), N); project(r.store);
    }
    const result = await (await get("/api/v1/events?source=quota&kind=quota_headroom_snapshot")).json() as { events: Envelope[] };
    assert.equal(result.events.length, 3);
    assert.deepEqual(new Set(result.events.map(e => e.host)), new Set(["agent-a", "agent-b", "laptop"]));
    assert.equal(mergeSnapshots(result.events.map(e => e.data.capacity as typeof snapshot), N * 1000).size, 1);
    for (const query of ["source=foreign", "project=foreign", "kind=report"]) {
      const page = await (await get("/api/v1/events?" + query)).json() as { events: Envelope[] };
      assert.equal(page.events.length, 0);
    }
    assert.equal((await get("/api/v1/health")).status, 403);
    const principal = await auth.authorize(read, "read");
    const foreign = hash("fleet-0");
    assert.equal(r.store.ownedReceipt(foreign, principal.scope), undefined);
    const ordinary = new Authorization([{ ...registration, quota_fleet_read: undefined } as any], r.trust, r.clock);
    const own = await ordinary.authorize(read, "read");
    assert.equal(own.scope.quotaFleet, false);
    assert.throws(() => new Authorization([{ ...registration, source: "foreign" }], r.trust, r.clock), /invalid_quota_fleet_read/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});
