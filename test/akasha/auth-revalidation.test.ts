import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { rig, N } from "./helpers.ts";
import { AccessState } from "../../src/access/trust.ts";

async function principal(r: Awaited<ReturnType<typeof rig>>) {
  return r.auth.authorize(await r.token({ grants: [{ resource: r.r.source, actions: ["read"] }] }), "read");
}

test("ongoing checks durably sample every call and isolate returned claims", async () => {
  const r = await rig("operator");
  try {
    const p = await principal(r);
    assert.throws(() => p.checkCommit(), /recheck_required/);
    p.access.claims.exp = N + 9999; p.access.claims.grants.length = 0;
    for (let i = 1; i <= 4; i++) {
      r.sample = { ...r.sample, unixSeconds: N + i, monotonicSeconds: 100 + i };
      await p.recheck(); p.checkCommit();
      assert.equal(JSON.parse(r.state.get("clock")!).unixSeconds, N + i);
    }
    r.sample = { ...r.sample, unixSeconds: N + 300, monotonicSeconds: 400 };
    await assert.rejects(() => p.recheck(), /token_time/);
    assert.throws(() => p.checkCommit(), /recheck_required/);
    assert.throws(() => r.trust.currentCheck(structuredClone(r.bundle)), /unverified_trust/);
  } finally { r.close(); }
});

for (const change of ["delete", "same-sequence-bytes", "key", "ceiling", "grant"] as const) {
  test("ongoing and commit checks reject cross-connection trust change: " + change, async () => {
    const r = await rig("operator");
    const other = new AccessState(join(r.dir.path, "access.db"));
    try {
      const p = await principal(r); await p.recheck();
      if (change === "delete") other.db.exec("DELETE FROM access_meta WHERE name='trust'");
      else if (change === "same-sequence-bytes") other.put("trust", r.state.get("trust")! + " ");
      else {
        const bundle = structuredClone(r.bundle); bundle.sequence++;
        if (change === "key") bundle.keys = [];
        if (change === "ceiling") bundle.keys[0]!.ceilings = [{ ...bundle.keys[0]!.ceilings[0]!, profile: "other" }];
        if (change === "grant") bundle.keys[0]!.ceilings[0]!.grants[0]!.actions = ["append"];
        await r.install(bundle);
      }
      assert.throws(() => p.checkCommit(), /trust_changed/);
      await assert.rejects(() => p.recheck(), /trust_changed/);
    } finally { other.close(); r.close(); }
  });
}

for (const failure of ["health", "rollback", "frozen", "trust-expiry"] as const) {
  test("ongoing check enforces " + failure, async () => {
    const r = await rig("operator");
    try {
      if (failure === "trust-expiry") await r.install({ ...r.bundle, sequence: 2, expires_at: N + 10 });
      const p = await principal(r); await p.recheck();
      if (failure === "health") r.sample = { ...r.sample, healthy: false };
      if (failure === "rollback") r.sample = { ...r.sample, unixSeconds: N - 1 };
      if (failure === "frozen") r.sample = { ...r.sample, monotonicSeconds: 131 };
      if (failure === "trust-expiry") r.sample = { ...r.sample, unixSeconds: N + 10, monotonicSeconds: 110 };
      await assert.rejects(() => p.recheck(), /clock_unhealthy|clock_rollback|stale_trust/);
    } finally { r.close(); }
  });
}

test("initial token verification rejects same-sequence trust replacement across await", async () => {
  const r = await rig("operator");
  try {
    const snapshot = r.trust.snapshot.bind(r.trust);
    r.trust.snapshot = async () => {
      const bundle = await snapshot();
      // The caller still must complete async token key import/signature verification.
      queueMicrotask(() => r.state.put("trust", r.state.get("trust")! + " "));
      return bundle;
    };
    await assert.rejects(() => principal(r), /trust_changed/);
  } finally { r.close(); }
});

test("initial trust authentication rejects replacement across await", async () => {
  const r = await rig("operator");
  try {
    const pending = r.trust.snapshot();
    r.state.put("trust", r.state.get("trust")! + " ");
    await assert.rejects(pending, /trust_changed/);
  } finally { r.close(); }
});

test("authenticated snapshot mutations cannot extend retained trust freshness", async () => {
  const r = await rig("operator");
  try {
    await r.install({ ...r.bundle, sequence: 2, expires_at: N + 10 });
    const snapshot = await r.trust.snapshot();
    snapshot.expires_at = N + 9999;
    const check = r.trust.currentCheck(snapshot);
    r.sample = { ...r.sample, unixSeconds: N + 10, monotonicSeconds: 110 };
    assert.throws(check, /stale_trust/);
  } finally { r.close(); }
});

test("trust replacement while the durable clock acquires its lock fails closed", async () => {
  const r = await rig("operator");
  try {
    const p = await principal(r), check = r.clock.check.bind(r.clock);
    r.clock.check = () => { const now = check(); r.state.put("trust", r.state.get("trust")! + " "); return now; };
    await assert.rejects(() => p.recheck(), /trust_changed/);
  } finally { r.close(); }
});
