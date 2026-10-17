import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { chronyHealth, trustedBytes, atomicPublicFile, installBundle, maintenanceCli, sampleChrony } from "../../src/access/maintenance.ts";
import { AccessState, Clock, TrustStore } from "../../src/access/trust.ts";
import { rig, N } from "../helpers/access.ts";
import { scratchDir } from "../helpers/scratch.ts";

// CI and remote runs must establish an isolated home before any fixture is created.
assert.ok(process.env.HOME && process.env.HOME !== "/home/igor");
assert.equal(process.env.HOME, process.env.CHALDEA_TRUST_TEST_HOME);
assert.ok(process.env.CHALDEA_TEST_SCRATCH);
assert.equal(process.env.HOME, process.env.CHALDEA_TEST_SCRATCH + "-home");

const tracking = (offset = "0.01", ref = N) => [
  "Reference ID    : C0000201 (192.0.2.1)", "Stratum         : 3",
  "Ref time (UTC)  : " + new Date(ref * 1000).toUTCString().replace(/^(\w{3}), (\d{2}) (\w{3}) (\d{4}) ([\d:]+) GMT$/, "$1 $3 $2 $5 $4"),
  "System time     : " + offset + " seconds slow of NTP time",
  "Last offset     : -0.001 seconds", "RMS offset      : 0.001 seconds",
  "Frequency       : 1.0 ppm slow", "Residual freq   : 0.001 ppm", "Skew            : 0.01 ppm",
  "Root delay      : 0.02 seconds", "Root dispersion : 0.01 seconds",
  "Update interval : 64.0 seconds", "Leap status     : Normal",
].join("\n");

test("chrony health fails closed for unknown, unsynchronised, local and stale clocks", () => {
  assert.equal(chronyHealth(tracking(), N).healthy, true);
  assert.equal(chronyHealth(tracking(), N).offsetSeconds, -0.01);
  for (const report of [
    "", "506 Cannot talk to daemon", tracking("30.01"), tracking("29.99"),
    tracking().replace("Normal", "Not synchronised"),
    tracking().replace("C0000201", "7F7F0101"),
    tracking().replace("C0000201", "00000000"),
    tracking().replace("Stratum         : 3", "Stratum         : 0"),
    tracking().replace("0.02 seconds", "-0.02 seconds"),
    tracking().replace("64.0 seconds", "NaN seconds"),
    tracking("NaN"), tracking("0.01", N - 193), tracking("0.01", N + 31),
    tracking() + "\nLeap status : Normal",
  ]) assert.equal(chronyHealth(report, N).healthy, false, report);
  assert.equal(chronyHealth(tracking("29.97"), N).healthy, true);
});

test("clock-health CLI publishes healthy and unknown samples with correct exit status", async () => {
  const s = scratchDir("trust-clock-cli");
  const mask = process.umask();
  try {
    const path = join(s.path, "health.json"), args = ["clock-health", "--output", path];
    assert.equal(sampleChrony(() => { throw new Error("unavailable"); }).healthy, false);
    const now = Math.floor(Date.now() / 1000);
    assert.equal(sampleChrony(() => tracking("0.01", now)).healthy, true);
    for (const healthy of [true, false]) {
      const h = { healthy, offsetSeconds: 0, checked_at: now };
      assert.equal(await maintenanceCli(args, () => h), healthy ? 0 : 1);
      assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), h);
    }
  } finally { process.umask(mask); s.remove(); }
});

test("trusted file boundaries, public mode, and atomic replacement", () => {
  const s = scratchDir("trust-files");
  try {
    const output = join(s.path, "out");
    atomicPublicFile(output, "signed");
    assert.equal(lstatSync(output).mode & 0o777, 0o644);
    assert.equal(trustedBytes(output, 6).toString(), "signed");
    assert.throws(() => trustedBytes(output, 5));
    const link = join(s.path, "link"); symlinkSync(output, link);
    assert.throws(() => trustedBytes(link, 100));
    chmodSync(output, 0o666); assert.throws(() => trustedBytes(output, 100));
    chmodSync(output, 0o644);
    atomicPublicFile(link, "new"); assert.equal(lstatSync(link).isSymbolicLink(), false);
    assert.equal(readFileSync(output, "utf8"), "signed");
  } finally { s.remove(); }
});

test("updater preserves signed bytes and durable rollback/history across restart", async () => {
  const r = await rig();
  try {
    const output = join(r.scratch.path, "bundle.jws");
    await installBundle(r.trust, r.envelope, output);
    assert.equal(readFileSync(output, "utf8"), r.envelope);
    const removed = await r.sign({ ...r.bundle, sequence: 2, keys: [] });
    await installBundle(r.trust, removed, output); r.restart();
    await assert.rejects(installBundle(r.trust, r.envelope, output), /trust_rollback/);
    await assert.rejects(installBundle(r.trust, await r.sign({ ...r.bundle, sequence: 3 }), output), /key_reactivation/);
    await assert.rejects(installBundle(r.trust, removed.slice(0, -10) + "tampered", output));
    await assert.rejects(installBundle(r.trust, await r.sign({ ...r.bundle, sequence: 2 }), output), /trust_rollback/);
    assert.equal(readFileSync(output, "utf8"), removed);
    await installBundle(r.trust, removed, output); // idempotent recovery after state-before-file crash
  } finally { r.remove(); }
});

test("cached trust survives publisher loss until exact 24h expiry; clock rollback parks", async () => {
  const r = await rig();
  try {
    const envelope = await r.sign({ ...r.bundle, sequence: 2, published_at: N, expires_at: N + 86400 });
    const output = join(r.scratch.path, "bundle.jws");
    await installBundle(r.trust, envelope, output);
    r.sample = { ...r.sample, unixSeconds: N + 86399, monotonicSeconds: r.sample.monotonicSeconds + 86399 };
    assert.equal((await r.trust.snapshot()).sequence, 2); r.restart();
    r.sample = { ...r.sample, unixSeconds: N + 86400, monotonicSeconds: r.sample.monotonicSeconds + 1 };
    await assert.rejects(r.trust.snapshot(), /stale_trust/);
    r.sample = { ...r.sample, unixSeconds: N - 1 };
    await assert.rejects(r.trust.snapshot(), /clock_rollback/);
    assert.equal(readFileSync(output, "utf8"), envelope);
  } finally { r.remove(); }
});

test("rotation overlap installs new material; retired/removed key cannot return", async () => {
  const r = await rig();
  try {
    const next = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    const newKey = { ...r.bundle.keys[0]!, kid: "host-2",
      public_key: { kty: "OKP" as const, crv: "Ed25519" as const, x: next.x! } };
    const output = join(r.scratch.path, "bundle.jws");
    await installBundle(r.trust, await r.sign({ ...r.bundle, sequence: 2, keys: [...r.bundle.keys, newKey] }), output);
    await installBundle(r.trust, await r.sign({ ...r.bundle, sequence: 3, keys: [newKey] }), output);
    r.restart();
    await assert.rejects(installBundle(r.trust, await r.sign({ ...r.bundle, sequence: 4,
      keys: [...r.bundle.keys, newKey] }), output), /key_reactivation/);
  } finally { r.remove(); }
});

test("operator CLI initializes exclusively, signs fleet grants and verifies installation", async () => {
  const s = scratchDir("trust-cli");
  const previousUmask = process.umask();
  try {
    const key = generateKeyPairSync("ed25519");
    const keyPath = join(s.path, "deployment.pem"), grants = join(s.path, "grants.json"),
      health = join(s.path, "health.json"), output = join(s.path, "bundle.jws"), state = join(s.path, "signer.sqlite");
    writeFileSync(keyPath, key.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
    const now = Math.floor(Date.now() / 1000);
    const issuer = generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" });
    writeFileSync(grants, JSON.stringify([{
      issuer: "chaldea:agent-a", kid: "issuer-1", public_key: { kty: "OKP", crv: "Ed25519", x: issuer.x! },
      not_before: now - 60, issue_until: now + 3600, verify_until: now + 4410,
      ceilings: [{ audience: "akasha", profile: "daily-health", project: "homelab", source: "daily-health",
        grants: [{ resource: "daily-health", actions: ["append"] }] }],
    }]), { mode: 0o600 });
    writeFileSync(health, JSON.stringify({ healthy: true, offsetSeconds: 0, checked_at: now }), { mode: 0o600 });
    assert.equal(await maintenanceCli(["initialize-state", "--state-file", state]), 0);
    assert.equal(await maintenanceCli(["initialize-state", "--state-file", state]), 1);
    const args = ["sign-bundle", "--state-file", state, "--clock-health-file", health,
      "--key-file", keyPath, "--kid", "deployment-1", "--grants-file", grants, "--sequence", "1", "--output", output];
    assert.equal(await maintenanceCli(args), 0);
    const first = readFileSync(output, "utf8");
    const a = new AccessState(join(s.path, "check.sqlite"), { initialize: true });
    try {
      const c = new Clock(a, () => ({ unixSeconds: now, monotonicSeconds: 1, bootId: "test", healthy: true, offsetSeconds: 0 }));
      const pub = key.publicKey.export({ format: "jwk" });
      const t = new TrustStore(a, c, [{ kid: "deployment-1", public_key: { kty: "OKP", crv: "Ed25519", x: pub.x! } }]);
      await t.install(first);
      const signed = await t.snapshot();
      assert.equal(signed.expires_at, signed.published_at + 86400);
    } finally { a.close(); }
    // Healthy clock plus valid lifetime isolates same-sequence equivocation.
    assert.equal(await maintenanceCli([...args, "--lifetime", "86399"]), 1);
    const anchors = join(s.path, "anchors.json"), candidate = join(s.path, "candidate.jws"),
      installed = join(s.path, "installed.jws"), verifierState = join(s.path, "verifier.sqlite");
    const pub = key.publicKey.export({ format: "jwk" });
    writeFileSync(anchors, JSON.stringify([{ kid: "deployment-1",
      public_key: { kty: "OKP", crv: "Ed25519", x: pub.x! } }]));
    writeFileSync(candidate, first + "\n");
    assert.equal(await maintenanceCli(["initialize-state", "--state-file", verifierState]), 0);
    const install = ["install-bundle", "--state-file", verifierState, "--clock-health-file", health,
      "--anchor-file", anchors, "--bundle-file", candidate, "--output", installed];
    assert.equal(await maintenanceCli(install), 0);
    assert.equal(readFileSync(installed, "utf8"), first);
    writeFileSync(candidate, first.slice(0, -10) + "tampered");
    assert.equal(await maintenanceCli(install), 1);
    assert.equal(readFileSync(installed, "utf8"), first);
    assert.equal(await maintenanceCli([...args, "--lifetime", "86401"]), 1);
    writeFileSync(health, JSON.stringify({ healthy: false, offsetSeconds: 0, checked_at: now }));
    assert.equal(await maintenanceCli(args), 1);
    assert.equal(readFileSync(output, "utf8"), first);
  } finally { process.umask(previousUmask); s.remove(); }
});
