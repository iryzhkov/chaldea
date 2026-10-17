import { test } from "node:test";
import assert from "node:assert/strict";
import { tokenRequest, helperConfig, producerToken, tokenHelperCli } from "../../src/access/helper.ts";
import { rig, N } from "../helpers/access.ts";
import { verifyToken } from "../../src/access/token.ts";

const flags = ["--audience", "akasha", "--action", "append", "--source", "quota", "--host", "agent-a", "--kind", "quota_parked"];
test("token helper accepts exactly five flag pairs and rejects caller-controlled authority", () => {
  assert.equal(tokenRequest(flags).source, "quota");
  for (const args of [[], flags.slice(0, -2), [...flags, "--profile", "admin"],
    [...flags.slice(0, -2), "--source", "other"], flags.map(x => x === "akasha" ? "jocasta" : x),
    flags.map(x => x === "append" ? "admin" : x)]) assert.throws(() => tokenRequest(args));
  assert.throws(() => helperConfig({}));
});
const config = {
  issuer: { uid: 1234, key_file: "/private/host-b.pem", name: "chaldea:agent-b", kid: "host-b-key" },
  state_file: "/private/state", bundle_file: "/public/bundle", anchor_file: "/public/anchors",
  clock_health_file: "/public/health",
  grants: [{ ...tokenRequest(flags), uid: 1000, profile: "quota-service", project: "chaldea" }],
};
test("issuer identity is required, validated and copied from protected configuration", async () => {
  assert.deepEqual(helperConfig(config).issuer, config.issuer);
  for (const issuer of [undefined, { ...config.issuer, uid: 0 }, { ...config.issuer, uid: 1.5 },
    { ...config.issuer, uid: 4294967295 }, { ...config.issuer, key_file: "relative" },
    { ...config.issuer, name: "other:agent-b" }, { ...config.issuer, kid: "" },
    { ...config.issuer, extra: true }]) assert.throws(() => helperConfig({ ...config, issuer }));
  let output = "";
  const io = { out: (s: string) => { output += s; }, err: () => {} };
  assert.equal(await tokenHelperCli(flags, io, { uid: 995, caller: "1000", config: () => config }), 1);
  assert.equal(output, "");
});
test("producer grants bind UID and all five selectors, including read vs append", async () => {
  assert.ok(process.env.CHALDEA_TRUST_TEST_HOME);
  assert.equal(process.env.HOME, process.env.CHALDEA_TRUST_TEST_HOME);
  assert.notEqual(process.env.HOME, "/home/igor");
  const r = await rig();
  try {
    const request = tokenRequest(flags), grant = { ...request, uid: 1000, profile: "quota-service", project: "chaldea" };
    r.bundle.keys[0]!.ceilings = [{ audience: "akasha", profile: grant.profile, project: grant.project,
      source: grant.source, grants: [{ resource: grant.source, actions: ["append"] }] }];
    r.bundle.sequence++;
    await r.trust.install(await r.sign(r.bundle));
    const token = await producerToken(request, 1000, [grant], r.issuer());
    const access = await verifyToken(token, { audience: "akasha", resource: "quota", action: "append" }, r.trust, r.clock);
    assert.equal(access.claims.exp - N, 780);
    assert.equal(access.claims.sub, "quota-service");
    for (const change of [{ host: "other" }, { source: "other" }, { kind: "report" }, { action: "read" as const }])
      await assert.rejects(producerToken({ ...request, ...change }, 1000, [grant], r.issuer()));
    await assert.rejects(producerToken(request, 1001, [grant], r.issuer()));
    await assert.rejects(producerToken(request, 1000, [grant, grant], r.issuer()));
    await assert.rejects(verifyToken(token, { audience: "akasha", resource: "quota", action: "read" }, r.trust, r.clock));
  } finally { r.remove(); }
});
test("helper denies calls without a sudo caller before opening config and redacts errors", async () => {
  let opened = false, out = "", err = "";
  const code = await tokenHelperCli(flags, { out: s => { out += s; }, err: s => { err += s; } },
    { uid: 1000, caller: undefined, config: () => { opened = true; throw new Error("SECRET"); } });
  assert.equal(code, 1); assert.equal(opened, false); assert.equal(out, "");
  assert.equal(err, "chaldea token helper: denied\n");
});
