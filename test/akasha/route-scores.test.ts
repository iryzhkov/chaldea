import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { rig, project, N } from "./helpers.ts";
import { Authorization } from "../../src/akasha/auth.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { httpServer } from "../../src/akasha/http.ts";
import { hash, normalize } from "../../src/akasha/schema.ts";
import type { Envelope } from "../../src/akasha/schema.ts";
import { collectScores } from "../../src/route/snapshot.ts";
import { join } from "node:path";
import { scores as fixture } from "../fixtures/route/targets.ts";

test("route source grants read homelab scores across hosts without widening other sources or kinds", async () => {
  const r = await rig("service");
  const registration = { ...r.r, source: "route", source_id: "route-agent-a", route_scores_read: true,
    kinds: ["route_pick_changed" as const] };
  const bundle = structuredClone(r.bundle); bundle.sequence++;
  bundle.keys[0]!.ceilings[0]!.source = "route";
  bundle.keys[0]!.ceilings[0]!.grants = [{ resource: "route", actions: ["append", "read"] }];
  await r.install(bundle);
  const auth = new Authorization([registration], r.trust, r.clock);
  const ingress = new Ingress(auth, r.store, () => { queueMicrotask(() => project(r.store)); });
  const server = httpServer(ingress); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const read = await r.token({ source: "route", grants: [{ resource: "route", actions: ["read"] }] });
  try {
    const scores = { ...fixture, version: 2 as const, metric: "aa-intelligence-cost-per-task" as const,
      fetchedAt: new Date(N * 1000).toISOString(), models: fixture.models.map(m => ({ ...m, coding: null,
        benchmarkCostUSDPerTask: .5 })) };
    const identity = { issuer: "chaldea:homelab", host: "homelab", source: "route", profile: r.r.profile,
      project: r.r.project, source_id: "route-homelab", run_id: "scores" };
    const input = normalize({ v: 1, kind: "route_score_snapshot", title: "Scores", data: { scores } }, identity, false);
    const original = { v: 1, ...identity, ...input, event_id: hash("route-score-original"), received_at: new Date(N * 1000).toISOString(),
      occurred_at: new Date(N * 1000).toISOString(), provenance: { type: "verified", request_hash: hash("request"),
        feed_id: 1_000_000_000_100 } } as Envelope;
    r.store.admit(original, hash("request"), N); project(r.store);
    for (const [i, variant] of [
      { host: "agent-b", issuer: "chaldea:agent-b", kind: "report", data: {} }, { project: "foreign" }, { profile: "foreign" },
      { source: "foreign", kind: "report", data: {} }, { kind: "route_pick_changed", data: { model: "foreign" } },
    ].entries()) {
      const event = { ...original, ...variant, event_id: hash("route-foreign-" + i) } as Envelope;
      r.store.admit(event, hash("foreign-request-" + i), N); project(r.store);
    }
    const get = (query: string) => fetch(base + "/api/v1/events" + query, { headers: { authorization: "Bearer " + read } });
    const visible = await (await get("")).json() as { events: Envelope[] };
    assert.equal(visible.events.length, 1); assert.equal(visible.events[0]!.host, "homelab");
    const collected = await collectScores({ enabled: true, url: base, tokenHelper: "/fixture", host: "agent-a" },
      join(process.env.HOME!, ".cache", "scores-" + original.event_id + ".json"), N * 1000,
      fetch, async () => read);
    assert.deepEqual(collected.value, scores);
    assert.equal(collected.value?.models[0]?.coding, null);
    assert.equal(collected.value?.models[0]?.benchmarkCostUSDPerTask, .5);
    for (const q of ["?kind=route_pick_changed", "?host=agent-b", "?source=foreign", "?project=foreign"]) {
      assert.equal(((await (await get(q)).json()) as { events: Envelope[] }).events.length, 0);
    }
    const own = { ...original, host: r.r.host, issuer: r.r.issuer, source_id: registration.source_id,
      kind: "route_pick_changed", data: { model: "own-pick" }, event_id: hash("own-route-pick") } as Envelope;
    r.store.admit(own, hash("own-route-request"), N); project(r.store);
    const principal = await auth.authorize(read, "read");
    assert.equal(r.store.ownedReceipt(own.event_id, principal.scope)?.event_id, own.event_id);
    assert.equal(r.store.ownedReceipt(original.event_id, principal.scope), undefined);
    assert.throws(() => normalize({ v: 1, kind: "route_score_snapshot", title: "Scores", data: { scores } },
      { ...identity, host: "agent-a" }, false), /scores_publisher_mismatch/);
    assert.throws(() => new Authorization([{ ...registration, source: "foreign" }], r.trust, r.clock), /invalid_route_scores_read/);
    assert.throws(() => new Authorization([{ ...registration, mode: "operator" }], r.trust, r.clock), /invalid_route_scores_read/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});
