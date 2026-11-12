import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { once } from "node:events";
import { CompactSign, SignJWT } from "jose";
import { AuthentikVerifier } from "../../src/akasha/authentik.ts";
import { Authorization, ownedKind } from "../../src/akasha/auth.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { httpServer } from "../../src/akasha/http.ts";
import type { Kind } from "../../src/akasha/schema.ts";
import { scores as scoreFixture } from "../fixtures/route/targets.ts";
import { rig, N, project } from "./helpers.ts";

const config = { issuer: "https://auth.example/application/o/akasha/", audience: "https://akasha.ryzhkov.dev",
  jwksUrl: "https://auth.example/application/o/akasha/jwks/", jwksTtlSeconds: 60 };
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });
const next = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = (pair = key, kid = "one") => ({ ...pair.publicKey.export({ format: "jwk" }), kid, use: "sig", alg: "RS256" });
const claims = { iss: config.issuer, aud: config.audience, sub: "user-123", preferred_username: "chaldea-agent-a",
  host: "agent-a", run_id: "run-1", iat: N, nbf: N, exp: N + 300 };
const token = (overrides: Record<string, unknown> = {}, pair = key, kid = "one") =>
  new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: "RS256", typ: "JWT", kid }).sign(pair.privateKey);

function fixture() {
  let keys = [jwk()], calls = 0, fail = false, now = N, elapsed = 0;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(url, config.jwksUrl); assert.equal(options?.redirect, "error");
    calls++; if (fail) throw new Error("offline");
    return new Response(JSON.stringify({ keys }), { status: 200 });
  };
  const verifier = new AuthentikVerifier(config, fetcher, () => now, () => elapsed);
  return { verifier, get calls() { return calls; }, set keys(v: ReturnType<typeof jwk>[]) { keys = v; },
    set fail(v: boolean) { fail = v; }, set now(v: number) { now = v; }, set elapsed(v: number) { elapsed = v; } };
}

test("JWT pins issuer, single audience, signature, algorithm, host and bounded times", async () => {
  const f = fixture();
  await f.verifier.verify(await token());
  for (const overrides of [
    { exp: N - 61, iat: N - 361, nbf: N - 361 },
    { iat: N + 61, nbf: N + 61, exp: N + 300 },
    { nbf: N + 61 }, { iss: "https://other.example/" },
    ...["https://jocasta.ryzhkov.dev", "https://ov.ryzhkov.dev", "https://holonet.ryzhkov.dev"].map(aud => ({ aud })),
    { aud: [config.audience, "https://ov.ryzhkov.dev"] }, { exp: N + 301 },
    { iat: undefined }, { nbf: null }, { exp: undefined }, { iat: N + .5 },
    { host: "agent-b" }, { preferred_username: "chaldea-unknown" },
    { sub: "chaldea-agent-b" }, { run_id: undefined },
  ]) await assert.rejects(f.verifier.verify(await token(overrides)), JSON.stringify(overrides));
  await assert.rejects(f.verifier.verify(await token({}, next)));
  for (const alg of ["none", "HS256"]) {
    const t = [Buffer.from(JSON.stringify({ alg, kid: "one" })).toString("base64url"),
      Buffer.from(JSON.stringify(claims)).toString("base64url"), "AAAA"].join(".");
    await assert.rejects(f.verifier.verify(t), /invalid_jwt_header/);
  }
  await f.verifier.verify(await token({ preferred_username: undefined, sub: "chaldea-agent-a" }));
  await f.verifier.verify(await token({ aud: [config.audience] }));
  await f.verifier.verify(await token({ iat: N + 60, nbf: N + 60 }));
  const proof = await f.verifier.verify(await token({ iat: N - 359, nbf: N - 359, exp: N - 59 }));
  proof.checkCurrent(); f.now = N + 1; assert.throws(proof.checkCurrent, /token_time/);
});

test("JWKS cooldown bounds identical and varying unknown kids, then permits rotation", async () => {
  for (const varying of [false, true]) {
    const f = fixture();
    await f.verifier.verify(await token());
    assert.equal(f.calls, 1);
    for (let i = 0; i < 20; i++) {
      const unsigned = [Buffer.from(JSON.stringify({ alg: "RS256", kid: varying ? "missing-" + i : "missing" })).toString("base64url"),
        Buffer.from("{}").toString("base64url"), "AAAA"].join(".");
      await assert.rejects(f.verifier.verify(unsigned), /jwks_refresh_cooldown/);
      assert.equal(f.calls, 1);
    }
    f.keys = [jwk(), jwk(next, "two")];
    f.elapsed = 29.999;
    await assert.rejects(f.verifier.verify(await token({}, next, "two")), /jwks_refresh_cooldown/);
    assert.equal(f.calls, 1);
    f.elapsed = 30;
    await f.verifier.verify(await token({}, next, "two"));
    assert.equal(f.calls, 2);
    await assert.rejects(f.verifier.verify(await token({}, key, "missing")), /jwks_refresh_cooldown/);
    assert.equal(f.calls, 2);
  }
});

test("concurrent JWKS requests share successful and failed fetches", async () => {
  for (const fail of [false, true]) {
    let calls = 0, release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const verifier = new AuthentikVerifier(config, async () => {
      calls++; await blocked;
      if (fail) throw new Error("offline");
      return new Response(JSON.stringify({ keys: [jwk()] }));
    }, () => N, () => 0);
    const known = await token(), unknown = await token({}, key, "missing");
    const outcomes = Promise.allSettled(Array.from({ length: 20 }, (_, i) => verifier.verify(i % 2 ? unknown : known)));
    assert.equal(calls, 1);
    release();
    const results = await outcomes;
    assert.equal(results.filter(r => r.status === "fulfilled").length, fail ? 0 : 10);
    assert.equal(calls, 1);
    await assert.rejects(verifier.verify(unknown), /jwks_refresh_cooldown/);
    assert.equal(calls, 1);
  }
});

test("failed JWKS refresh backs off until cooldown and recovers without stale-key fallback", async () => {
  const f = fixture(), original = await token();
  f.fail = true;
  await assert.rejects(f.verifier.verify(original), /offline/);
  assert.equal(f.calls, 1);
  f.fail = false;
  for (const elapsed of [0, 29.999]) {
    f.elapsed = elapsed;
    await assert.rejects(f.verifier.verify(original), /jwks_refresh_cooldown/);
    assert.equal(f.calls, 1);
  }
  f.elapsed = 30;
  await f.verifier.verify(original);
  assert.equal(f.calls, 2);
  f.elapsed = 90; f.fail = true;
  await assert.rejects(f.verifier.verify(original), /offline/);
  assert.equal(f.calls, 3);
  f.fail = false; f.elapsed = 119.999;
  await assert.rejects(f.verifier.verify(original), /jwks_refresh_cooldown/);
  assert.equal(f.calls, 3);
  f.elapsed = 120;
  await f.verifier.verify(original);
  assert.equal(f.calls, 4);
  f.elapsed = 180; f.keys = [{ ...jwk(), use: "enc" }];
  await assert.rejects(f.verifier.verify(original));
  assert.equal(f.calls, 5);
  for (const jwksTtlSeconds of [0, 301, 1.5, NaN])
    assert.throws(() => new AuthentikVerifier({ ...config, jwksTtlSeconds }));
});

test("JWT nbf defaults to iat and numeric claims require integer literals", async () => {
  const f = fixture();
  const proof = await f.verifier.verify(await token({ nbf: undefined }));
  assert.equal(proof.nbf, N);
  await assert.rejects(f.verifier.verify(await token({ nbf: N - 1 })), /invalid_jwt_lifetime/);
  for (const name of ["iat", "nbf", "exp"] as const) {
    for (const suffix of [".0", "e0"]) {
      const payload = JSON.stringify(claims).replace('"'+ name + '":' + claims[name],
        '"'+ name + '":' + claims[name] + suffix);
      const signed = await new CompactSign(Buffer.from(payload))
        .setProtectedHeader({ alg: "RS256", kid: "one" }).sign(key.privateKey);
      await assert.rejects(f.verifier.verify(signed), /non_integer_literal/);
    }
  }
});

test("dual acceptance preserves PKI; registry controls source, host, kinds, actions and revocation", async () => {
  const r = await rig(); const f = fixture();
  try {
    const auth = new Authorization([r.r], r.trust, r.clock, f.verifier);
    assert.deepEqual((await auth.authorize(await r.token(), "append")).identity,
      (await r.auth.authorize(await r.token(), "append")).identity);
    const jwt = await token();
    await assert.rejects(r.auth.authorize(jwt, "append", r.r.source), /authentik_disabled/);
    const p = await auth.authorize(jwt, "append", r.r.source);
    assert.equal(p.identity.source_id, r.r.source_id);
    assert.equal(p.identity.profile, r.r.profile);
    assert.throws(p.checkCommit, /recheck_required/); await p.recheck(); p.checkCommit();
    await assert.rejects(auth.authorize(jwt, "read", r.r.source), /append_only/);
    await assert.rejects(auth.authorize(jwt, "append", "unregistered"), /unregistered_source/);
    await assert.rejects(auth.authorize(jwt, "append"), /missing_or_mismatched_source/);
    await assert.rejects(auth.authorize(await token({ source: r.r.source }), "append", "other"), /mismatched_source/);
    for (const host of ["agent-b", "unknown"]) {
      await assert.rejects(auth.authorize(await token({ host, preferred_username: "chaldea-" + host }), "append", r.r.source),
        /unregistered_source/);
    }
    const revoked = new Authorization([{ ...r.r, revoked: true }], r.trust, r.clock, f.verifier);
    await assert.rejects(revoked.authorize(jwt, "append", r.r.source), /unregistered_source/);
    // JWT verification deliberately does not depend on PKI clock health or epochs.
    r.sample = { ...r.sample, healthy: false };
    await p.recheck(); p.checkCommit();
  } finally { r.close(); }
});

test("HTTP JWT producers append registered kinds and read route scores with source provenance", async () => {
  const r = await rig("service", "homelab"); const f = fixture();
  const kinds: Kind[] = ["feed_post", "job_finished", "tool_call", "route_score_snapshot", "quota_headroom_snapshot"];
  const registrations = kinds.map((kind, i) => ({ ...r.r, source: kind === "route_score_snapshot" ? "route" : "producer-" + i,
    source_id: "producer-" + i, kinds: [kind], ...(kind === "route_score_snapshot" ? { route_scores_read: true } : {}) }));
  const auth = new Authorization(registrations, r.trust, r.clock, f.verifier);
  const ingress = new Ingress(auth, r.store, () => { project(r.store); }, { waitMs: 1 });
  const server = httpServer(ingress); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  try {
    const jwt = await token({ host: "homelab", preferred_username: "chaldea-homelab" });
    for (const [i, registration] of registrations.entries()) {
      const kind = kinds[i]!;
      const p = await auth.authorize(jwt, "append", registration.source);
      assert.throws(() => ownedKind(p, "report", {}), /kind_forbidden/);
      const data = kind === "tool_call" ? { ts: new Date(N * 1000).toISOString(), session: "session", proc: "1", seq: 1,
        client: "codex", tool: "read", args: [], outcome: "ok", ok: true, tool_source: "test", raw_line_hash: "a".repeat(64) } : kind === "route_score_snapshot" ? { scores: {
          ...scoreFixture, version: 2, metric: "aa-intelligence-cost-per-task", fetchedAt: new Date(N * 1000).toISOString(),
          models: scoreFixture.models.map(m => ({ ...m, coding: null, benchmarkCostUSDPerTask: .5 })) } } : {};
      const res = await fetch(base + "/api/v1/events", { method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer " + jwt, "x-akasha-source": registration.source, "idempotency-key": "event-" + i },
        body: JSON.stringify({ v: 1, kind, ...(kind === "tool_call" ? {} : { title: kind }), data }) });
      assert.equal(res.status, 201, await res.text());
      const pending = r.store.db.prepare("SELECT envelope FROM events WHERE source = ?").get(registration.source) as { envelope: string } | undefined;
      // Stored event ownership is the registered identity, never JWT-supplied profile/project/source_id.
      assert.ok(pending);
      const envelope = JSON.parse(pending.envelope); assert.equal(envelope.source_id, registration.source_id);
      assert.equal(envelope.issuer, registration.issuer); assert.equal(envelope.host, registration.host);
      auth.validateDelivery(envelope);
    }
    const read = await auth.authorize(jwt, "read", "route"); assert.equal(read.scope.routeScores, true);
    const res = await fetch(base + "/api/v1/events", { headers: { authorization: "Bearer " + jwt, "x-akasha-source": "route" } });
    assert.equal(res.status, 200);
    const body = await res.json() as { events: { kind: string }[] };
    assert.deepEqual(body.events.map(e => e.kind), ["route_score_snapshot"]);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});
