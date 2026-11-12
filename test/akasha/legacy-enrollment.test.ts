import assert from "node:assert/strict";
import { test } from "node:test";
import { Authorization } from "../../src/akasha/auth.ts";
import { rig } from "./helpers.ts";

test("legacy quota_fleet_read is boolean-only and grants no access", async () => {
  const r = await rig("service");
  try {
    const token = await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] });
    const baseline = await r.auth.authorize(token, "read");
    for (const quota_fleet_read of [false, true]) {
      const registration = { ...r.r, quota_fleet_read };
      const auth = new Authorization([registration], r.trust, r.clock);
      const principal = await auth.authorize(token, "read");
      assert.deepEqual(principal.scope, baseline.scope);
      assert.equal(principal.scope.global, false);
      assert.equal(principal.scope.routeScores, false);
    }
    for (const quota_fleet_read of [null, 1, "true", {}]) {
      const registration = { ...r.r, quota_fleet_read };
      assert.throws(() => new Authorization([registration], r.trust, r.clock), /invalid_quota_fleet_read/);
    }
    const registration = { ...r.r, mode: "report" as const, quota_fleet_read: true };
    const auth = new Authorization([registration], r.trust, r.clock);
    await assert.rejects(auth.authorize(token, "read"), /append_only/);
  } finally { r.close(); }
});
