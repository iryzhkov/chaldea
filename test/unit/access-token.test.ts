import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync, chmodSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { AccessState, Clock, TrustStore, signTrustBundle, TRUST_FRESH_SECONDS, TRUST_POLL_SECONDS } from "../../src/access/trust.ts";
import { verifyToken } from "../../src/access/token.ts";
import { HostIssuer, loadHostSigningKey } from "../../src/access/issuer.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { vectorSets, rig, operation, admission, N } from "../helpers/access.ts";

test("access v1 vectors remain frozen", () => {
  for (const [name, hash] of [
    ["v1.json", "5d49ee7b2c8a8e36b25e8f440295b158b4fb8c7fbd73e0c5c252f43f746aee88"],
    ["v1-encoding.json", "1732273d8d109e4f877ffdb9075d0e6591ff44900f9a52b189885d1fb267436f"],
    ["v1-freshness.json", "f29c45a95b9a42e199ec0b5214f7caa6ad9b278cb34d8ae7986c2b85fccb4845"],
  ]) {
    const bytes = readFileSync(new URL("../fixtures/access/" + name, import.meta.url));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), hash);
  }
});
test("access frozen cross-language request vectors", async t => {
  for (const vectors of vectorSets) for (const c of vectors.cases) await t.test(c.name, async () => {
    const scratch = scratchDir("access-vector");
    const state = new AccessState(join(scratch.path, "state.sqlite"), { initialize: true });
    const clock = new Clock(state, () => c.clock ?? vectors.clock);
    const trust = new TrustStore(state, clock, vectors.anchors);
    try {
      const action = async () => {
        await trust.install(c.bundle ?? vectors.bundle);
        return verifyToken(c.token, c.operation ?? vectors.operation, trust, clock, c.skew);
      };
      if (c.accept) await action(); else await assert.rejects(action);
    } finally { state.close(); scratch.remove(); }
  });
});
test("access frozen trust and clock scenarios survive actual DB reopen", async t => {
  for (const vectors of vectorSets) for (const scenario of vectors.scenarios) await t.test(scenario.name, async () => {
    const scratch = scratchDir("access-scenario");
    let sample = vectors.clock;
    let state = new AccessState(join(scratch.path, "state.sqlite"), { initialize: true });
    let clock = new Clock(state, () => sample);
    let trust = new TrustStore(state, clock, vectors.anchors);
    try {
      await trust.install(vectors.bundle);
      for (const step of scenario.steps) {
        sample = step.clock ?? sample;
        if (step.restart) {
          state.close(); state = new AccessState(join(scratch.path, "state.sqlite"));
          clock = new Clock(state, () => sample); trust = new TrustStore(state, clock, vectors.anchors);
        }
        const action = async () => {
          if (step.install !== undefined) await trust.install(step.install);
          if (step.token !== undefined) await verifyToken(step.token, vectors.operation, trust, clock);
        };
        if (step.accept) await action(); else await assert.rejects(action);
      }
    } finally { state.close(); scratch.remove(); }
  });
});
test("host issuer mints only ceiling-bounded, short, single-audience tokens", async () => {
  const r = await rig();
  try {
    const issuer = r.issuer();
    const request = { ...admission().services[0]!, profile: "daily-health", project: "homelab", runId: "run-1", expiresAt: N + 1000 };
    const a = await issuer.mint(request), b = await issuer.mint(request);
    const result = await verifyToken(a, operation, r.trust, r.clock);
    assert.equal(result.claims.exp - result.claims.iat, 780);
    assert.equal(result.claims.sub, "daily-health");
    assert.equal(result.claims.run_id, "run-1");
    assert.notEqual(result.claims.jti, (await verifyToken(b, operation, r.trust, r.clock)).claims.jti);
    await assert.rejects(() => issuer.mint(request, 781), /invalid_lifetime/);
    await assert.rejects(() => issuer.mint({ ...request, project: "tooling" }), /issuer_ceiling/);
    await assert.rejects(() => issuer.mint({ ...request, grants: [{ resource: "host:agent-a", actions: ["reboot"] }] }), /issuer_ceiling/);
    await assert.rejects(() => issuer.mint({ ...request, expiresAt: N }), /invalid_lifetime/);
    const wrong = generateKeyPairSync("ed25519");
    await assert.rejects(() => new HostIssuer("chaldea:agent-a", "host-1", wrong.privateKey, r.trust, r.clock).mint(request), /unknown_signer/);
  } finally { r.remove(); }
});
test("ongoing stream recheck observes trust removal and expiry deadline", async () => {
  const r = await rig();
  try {
    const token = await r.issuer().mint({ ...admission().services[0]!, profile: "daily-health", project: "homelab", runId: "run-1", expiresAt: N + 90 });
    const session = await verifyToken(token, operation, r.trust, r.clock);
    assert.equal(session.validUntil, N + 90);
    await session.recheck();
    await r.trust.install(await r.sign({ ...r.bundle, sequence: 2, keys: [] }));
    await assert.rejects(() => session.recheck(), /unknown_key/);
  } finally { r.remove(); }
});
test("trust install is authenticated; same sequence retry cannot extend freshness", async () => {
  const r = await rig();
  try {
    await r.trust.install(r.envelope);
    const bad = r.envelope.slice(0, -10) + "A".repeat(10);
    await assert.rejects(() => r.trust.install(bad));
    r.sample = { ...r.sample, unixSeconds: N + 590, monotonicSeconds: 690 };
    await assert.rejects(() => r.trust.snapshot(), /stale_trust/);
    await assert.rejects(() => r.trust.install(r.envelope), /stale_trust/);
    await assert.rejects(() => r.issuer().mint({ ...admission().services[0]!, profile: "daily-health", project: "homelab", runId: "run-1", expiresAt: N + 1000 }), /stale_trust/);
  } finally { r.remove(); }
});
test("rotation old key cannot mint after cutoff or extend verify window", async () => {
  const r = await rig();
  try {
    const old = r.bundle.keys[0]!;
    const next = { ...old, issue_until: N + 10, verify_until: N + 820 };
    await r.trust.install(await r.sign({ ...r.bundle, sequence: 2, keys: [next] }));
    const request = { ...admission().services[0]!, profile: "daily-health", project: "homelab", runId: "run-1", expiresAt: N + 1000 };
    const token = await r.issuer().mint(request);
    assert.equal((await verifyToken(token, operation, r.trust, r.clock)).claims.exp, N + 780);
    r.sample = { ...r.sample, unixSeconds: N + 10, monotonicSeconds: 110 };
    await assert.rejects(() => r.issuer().mint(request), /key_time/);
    await r.trust.install(await r.sign({ ...r.bundle, sequence: 3, keys: [] }));
    r.restart();
    await assert.rejects(async () => r.trust.install(await r.sign({ ...r.bundle, sequence: 4 })), /key_reactivation/);
  } finally { r.remove(); }
});
test("unsafe state and signing-key files fail closed; no key generation API", async () => {
  const r = await rig();
  try {
    const keyPath = join(r.scratch.path, "host.pem");
    writeFileSync(keyPath, r.issuerPair.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    assert.equal(loadHostSigningKey(keyPath).asymmetricKeyType, "ed25519");
    chmodSync(keyPath, 0o644);
    assert.throws(() => loadHostSigningKey(keyPath), /unsafe_key_file/);
    chmodSync(keyPath, 0o600);
    const link = join(r.scratch.path, "link.pem"); symlinkSync(keyPath, link);
    assert.throws(() => loadHostSigningKey(link));
    chmodSync(r.scratch.path, 0o755);
    assert.throws(() => loadHostSigningKey(keyPath), /unsafe_key_directory/);
    assert.throws(() => new AccessState(join(r.scratch.path, "other.sqlite")), /unsafe_state_directory/);
    chmodSync(r.scratch.path, 0o700);
  } finally { r.remove(); }
});
test("deployment signer cannot be an issuer key", async () => {
  const r = await rig();
  try {
    const collision = structuredClone(r.bundle); collision.sequence = 2;
    collision.keys[0]!.public_key = r.anchor.public_key;
    await assert.rejects(async () => r.trust.install(await r.sign(collision)), /issuer_is_trust_anchor/);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await assert.rejects(() => signTrustBundle(r.bundle, "deployment-1", rsa.privateKey), /invalid_signer/);
  } finally { r.remove(); }
});
test("24-hour cached trust survives restart but expires without refresh", async () => {
  assert.equal(TRUST_FRESH_SECONDS, 86400);
  assert.ok(TRUST_POLL_SECONDS > 0 && TRUST_POLL_SECONDS <= 120);
  const r = await rig();
  try {
    const bundle = { ...r.bundle, sequence: 2, published_at: N - 23 * 3600, expires_at: N + 3600 };
    const envelope = await r.sign(bundle);
    await r.trust.install(envelope);
    r.restart();
    assert.equal((await r.trust.snapshot()).expires_at, bundle.expires_at);
    const request = { ...admission().services[0]!, profile: "daily-health", project: "homelab", runId: "run-24h", expiresAt: N + 5000 };
    r.sample = { ...r.sample, unixSeconds: N + 3500, monotonicSeconds: 3600 };
    const token = await r.issuer().mint(request);
    const session = await verifyToken(token, operation, r.trust, r.clock);
    assert.equal(session.validUntil, bundle.expires_at);
    await r.trust.install(envelope);
    r.sample = { ...r.sample, unixSeconds: N + 3599, monotonicSeconds: 3699 };
    await session.recheck();
    r.sample = { ...r.sample, unixSeconds: N + 3600, monotonicSeconds: 3700 };
    await assert.rejects(() => r.trust.snapshot(), /stale_trust/);
    await assert.rejects(() => r.trust.install(envelope), /stale_trust/);
    await assert.rejects(() => session.recheck(), /stale_trust/);
    await assert.rejects(() => r.issuer().mint(request), /stale_trust/);
    r.restart();
    await assert.rejects(() => r.trust.snapshot(), /stale_trust/);
  } finally { r.remove(); }
});
