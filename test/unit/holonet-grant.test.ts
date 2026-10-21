import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { claimsEqual, parseServiceGrant, serviceSubset, type HolonetGrant } from "../../src/session/service-grant.ts";

const golden = JSON.parse(readFileSync(new URL("../fixtures/holonet-catalog.json", import.meta.url), "utf8")) as HolonetGrant;

test("HoloNet closed grant codec binds server, user, library, namespace and catalog-only actions", () => {
  const parsed = parseServiceGrant(golden);
  assert.deepEqual(parsed, golden);
  assert.notEqual(parsed, golden);
  const { audience: _audience, ...wire } = golden;
  assert.ok(claimsEqual(wire, golden));
  assert.ok(serviceSubset(parsed, golden));
  for (const patch of [
    { holonet_server: "c".repeat(32) }, { holonet_catalog_users: ["c".repeat(32)] },
    { holonet_libraries: ["456"] }, { holonet_namespace: "other" },
  ]) {
    const changed = parseServiceGrant({ ...golden, ...patch });
    assert.equal(serviceSubset(changed, golden), false);
    assert.equal(serviceSubset(golden, changed), false);
    assert.equal(claimsEqual({ ...wire, ...patch }, golden), false);
  }
  for (const patch of [
    { scope: "holonet.read holonet.curate" }, { scope: "holonet.home" },
    { holonet_history_users: ["b".repeat(32)] }, { holonet_target_users: ["b".repeat(32)] },
    { holonet_actions: ["catalog.read", "userdata.read"] }, { holonet_libraries: [] },
    { holonet_libraries: ["123", "456"] }, { holonet_libraries: ["01"] },
    { holonet_libraries: ["9223372036854775808"] }, { holonet_catalog_users: [] },
    { holonet_server: "A".repeat(32) }, { holonet_namespace: "Upper" },
    { holonet_extra: [] }, { holonet_namespace: "synthetic\n" },
    { holonet_server: "a".repeat(32) + "\n" }, { holonet_libraries: ["123\n"] },
  ]) assert.throws(() => parseServiceGrant({ ...golden, ...patch }));
  for (const key of Object.keys(golden)) {
    const absent = { ...golden } as Record<string, unknown>;
    delete absent[key];
    assert.throws(() => parseServiceGrant(absent));
  }
  for (const extra of [{ ha_actions: [] }, { holonet_extra: [] }, { Holonet_server: golden.holonet_server },
    { holonet_ſerver: golden.holonet_server }, { Scope: golden.scope }]) {
    assert.equal(claimsEqual({ ...wire, ...extra }, golden), false);
  }
});
