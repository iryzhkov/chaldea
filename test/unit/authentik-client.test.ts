import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync, linkSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { hostPassword, authentikToken } from "../../src/access/authentik-client.ts";
import { tokenHelperCli } from "../../src/access/helper.ts";

test("credential custody refuses links, modes and unsafe parents", () => {
  assert.equal(process.env.HOME, process.env.CHALDEA_TRUST_TEST_HOME);
  assert.ok(process.env.HOME && process.env.HOME !== "/home/igor");
  const home = mkdtempSync(join(process.env.HOME!, "auth-"));
  const dir = home + "/.config/chaldea/authentik", file = dir + "/host.app-password";
  const identity = { home, host: "agent-a", uid: process.getuid!() };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const secret = "SYNTHETIC-password-only";
  try {
    writeFileSync(file, secret, { mode: 0o600 });
    assert.equal(hostPassword(identity), secret);
    chmodSync(file, 0o644); assert.throws(() => hostPassword(identity)); chmodSync(file, 0o600);
    linkSync(file, dir + "/hard"); assert.throws(() => hostPassword(identity)); unlinkSync(dir + "/hard");
    unlinkSync(file); symlinkSync("missing", file); assert.throws(() => hostPassword(identity)); unlinkSync(file);
    writeFileSync(file, secret, { mode: 0o600 });
    chmodSync(dir, 0o755); assert.throws(() => hostPassword(identity)); chmodSync(dir, 0o700);
    chmodSync(home + "/.config", 0o777); assert.throws(() => hostPassword(identity));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
const identity = { home: "/unused", host: "laptop", uid: 1001 };
const claims = { iss: "https://auth.ryzhkov.dev/application/o/chaldea-akasha/",
  aud: "https://akasha.ryzhkov.dev", host: "omarchy-macbook-air-igor",
  preferred_username: "chaldea-omarchy-macbook-air-igor", run_id: "chaldea-laptop",
  scope: "akasha.ingest", iat: 100, exp: 400 };
function response(change = {}) {
  const token = "e30." + Buffer.from(JSON.stringify({ ...claims, ...change })).toString("base64url") + ".c2ln";
  return new Response(JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 300 }));
}
test("exchange pins resource, username, scope, redirect policy and lifetime; no cache", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++; assert.equal(url, "https://auth.ryzhkov.dev/application/o/token/");
    assert.equal(options!.redirect, "error");
    const body = options!.body as URLSearchParams;
    assert.deepEqual(Object.fromEntries(body), { grant_type: "client_credentials",
      client_id: "chaldea-akasha", username: "chaldea-laptop", password: "SYNTHETIC-password",
      scope: "akasha.ingest", resource: "https://akasha.ryzhkov.dev" });
    return response();
  };
  for (let i = 0; i < 2; i++)
    await authentikToken(identity, claims.host, fetcher, () => "SYNTHETIC-password", () => 101);
  assert.equal(calls, 2);
  for (const change of [{ exp: 401 }, { exp: 100 }, { aud: "foreign" }, { host: "foreign" },
    { preferred_username: "foreign" }, { run_id: "foreign" }, { scope: "goauthentik.io/api" }])
    await assert.rejects(authentikToken(identity, claims.host, async () => response(change), () => "fixture", () => 101));
  await assert.rejects(authentikToken(identity, claims.host, async () => new Response("secret", { status: 400 }), () => "fixture"));
});
test("selected exchange failure is redacted and cannot fall through to PKI", async () => {
  const request = { audience: "akasha", action: "append", source: "feed", host: "agent-a", kind: "feed_post" };
  const flags = Object.entries(request).flatMap(([k, v]) => ["--" + k, v]);
  const config = { authentik: { host: "agent-a", home: "/missing", uid: 1000 },
    issuer: { uid: 995, name: "chaldea:agent-a", key_file: "/must-not-open", kid: "key" },
    state_file: "/must-not-open", bundle_file: "/must-not-open", anchor_file: "/must-not-open",
    clock_health_file: "/must-not-open", grants: [{ ...request, uid: 1000, profile: "feed-writer", project: "chaldea" }] };
  let out = "", err = "";
  assert.equal(await tokenHelperCli(flags, { out: s => { out += s; }, err: s => { err += s; } },
    { uid: 0, caller: "1000", config: () => config }), 1);
  assert.equal(out, ""); assert.equal(err, "chaldea token helper: denied\n");
});
