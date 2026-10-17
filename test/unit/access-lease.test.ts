import { test } from "node:test";
import assert from "node:assert/strict";
import { RunLeases } from "../../src/access/run-lease.ts";
import { AccessState, Clock } from "../../src/access/trust.ts";
import { verifyToken } from "../../src/access/token.ts";
import { rig, admission, operation, N } from "../helpers/access.ts";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

test("lease renews with fresh jti until completion, which survives restart", async () => {
  const r = await rig();
  try {
    let leases = new RunLeases(r.state, r.clock);
    const a = admission(); leases.admit(a);
    const token = await leases.renew(a.runId, "homelab", r.issuer(), async x => structuredClone(x));
    r.sample = { ...r.sample, unixSeconds: N + 120, monotonicSeconds: 220 };
    const next = await leases.renew(a.runId, "homelab", r.issuer(), async x => structuredClone(x));
    const c = (await verifyToken(next, operation, r.trust, r.clock)).claims;
    assert.equal(c.iat, N + 120);
    assert.notEqual(c.jti, (await verifyToken(token, operation, r.trust, r.clock)).claims.jti);
    leases.end(a.runId); r.restart(); leases = new RunLeases(r.state, r.clock);
    await assert.rejects(() => leases.renew(a.runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
    assert.throws(() => leases.admit(a), /run_already_admitted/);
  } finally { r.remove(); }
});
test("cancellation survives restart and copied last bearer expires", async () => {
  const r = await rig();
  try {
    let leases = new RunLeases(r.state, r.clock);
    const a = admission(); a.expiresAt = N + 90; leases.admit(a);
    const token = await leases.renew(a.runId, "homelab", r.issuer(), async x => structuredClone(x));
    leases.cancel(a.runId); leases.cancel(a.runId); r.restart(); leases = new RunLeases(r.state, r.clock);
    await assert.rejects(() => leases.renew(a.runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
    await verifyToken(token, operation, r.trust, r.clock);
    r.sample = { ...r.sample, unixSeconds: N + 120, monotonicSeconds: 220 };
    await assert.rejects(() => verifyToken(token, operation, r.trust, r.clock), /token_time/);
  } finally { r.remove(); }
});
test("cancellation during async reauthorization in another DB connection discards token", async () => {
  const r = await rig();
  const other = new AccessState(join(r.scratch.path, "state.sqlite"));
  const otherClock = new Clock(other, () => r.sample);
  try {
    const leases = new RunLeases(r.state, r.clock), canceller = new RunLeases(other, otherClock);
    leases.admit(admission());
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const renewal = leases.renew(admission().runId, "homelab", r.issuer(), async x => {
      entered(); await gate; return structuredClone(x);
    });
    await ready; canceller.cancel(admission().runId); resume();
    await assert.rejects(() => renewal, /run_changed/);
    r.restart();
    await assert.rejects(() => new RunLeases(r.state, r.clock).renew(admission().runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
  } finally { other.close(); r.remove(); }
});
test("only one competing renewal can release a bearer from the same revision", async () => {
  const r = await rig();
  try {
    const leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    const results = await Promise.allSettled([1, 2].map(() =>
      leases.renew(admission().runId, "homelab", r.issuer(), async x => structuredClone(x))));
    assert.equal(results.filter(x => x.status === "fulfilled").length, 1);
    assert.equal(results.filter(x => x.status === "rejected").length, 1);
  } finally { r.remove(); }
});
test("renewal can only narrow saved grants and deadline, including across restart", async () => {
  const r = await rig();
  try {
    let leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    const narrow = admission(); narrow.services[0]!.grants[0]!.actions = ["health.summary"]; narrow.expiresAt = N + 60;
    const token = await leases.renew(narrow.runId, "homelab", r.issuer(), async () => narrow);
    assert.equal((await verifyToken(token, operation, r.trust, r.clock)).claims.exp, N + 60);
    r.restart(); leases = new RunLeases(r.state, r.clock);
    await assert.rejects(() => leases.renew(narrow.runId, "homelab", r.issuer(), async () => admission()), /grant_expansion/);
    const badIdentity = { ...narrow, project: "tooling" };
    await assert.rejects(() => leases.renew(narrow.runId, "homelab", r.issuer(), async () => badIdentity), /grant_expansion/);
    await assert.rejects(() => leases.renew(narrow.runId, "feed", r.issuer(), async () => narrow), /audience_not_admitted/);
  } finally { r.remove(); }
});
test("current authorization denial durably cancels; cancellation works with bad clocks/trust", async () => {
  const r = await rig();
  try {
    let leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    await assert.rejects(() => leases.renew(admission().runId, "homelab", r.issuer(), async () => null), /run_not_authorized/);
    r.restart(); leases = new RunLeases(r.state, r.clock);
    await assert.rejects(() => leases.renew(admission().runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
    const other = { ...admission(), runId: "run-2" }; leases.admit(other);
    r.sample = { ...r.sample, healthy: false }; leases.cancel(other.runId);
    r.sample = { ...r.sample, healthy: true };
    await assert.rejects(() => leases.renew(other.runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
  } finally { r.remove(); }
});
test("expired/unknown runs never renew; retention never revives cancelled run IDs", async () => {
  const r = await rig();
  try {
    let leases = new RunLeases(r.state, r.clock);
    await assert.rejects(() => leases.renew("unknown", "homelab", r.issuer(), async x => structuredClone(x)), /unknown_run/);
    const a = admission(); a.expiresAt = N + 10; leases.admit(a);
    r.sample = { ...r.sample, unixSeconds: N + 10, monotonicSeconds: 110 };
    await assert.rejects(() => leases.renew(a.runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
    leases.cancel(a.runId);
    r.sample = { ...r.sample, unixSeconds: N + 15 * 86400, monotonicSeconds: 100 + 15 * 86400 };
    leases.prune(); r.restart(); leases = new RunLeases(r.state, r.clock);
    assert.throws(() => leases.admit({ ...a, expiresAt: r.sample.unixSeconds + 100 }), /run_already_admitted/);
    const row = r.state.db.prepare("SELECT body FROM access_runs WHERE run_id=?").get(a.runId) as { body: string };
    assert.equal(JSON.parse(row.body).admission.services.length, 0);
  } finally { r.remove(); }
});
test("clock rollback and unhealthy time park minting and renewal after reboot", async () => {
  const r = await rig();
  try {
    let leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    r.sample = { ...r.sample, unixSeconds: N - 1, bootId: "reboot", monotonicSeconds: 1 };
    r.restart(); leases = new RunLeases(r.state, r.clock);
    await assert.rejects(() => leases.renew(admission().runId, "homelab", r.issuer(), async x => structuredClone(x)), /clock_rollback/);
    leases.cancel(admission().runId);
  } finally { r.remove(); }
});
test("SIGKILL after durable cancellation cannot resurrect renewal", async () => {
  const r = await rig();
  try {
    const leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    const child = spawnSync(process.execPath, [
      new URL("../helpers/access-cancel-crash.ts", import.meta.url).pathname,
      join(r.scratch.path, "state.sqlite"), admission().runId,
    ], { encoding: "utf8" });
    assert.equal(child.signal, "SIGKILL", child.stderr);
    r.restart();
    await assert.rejects(() => new RunLeases(r.state, r.clock).renew(
      admission().runId, "homelab", r.issuer(), async x => structuredClone(x)), /run_inactive/);
  } finally { r.remove(); }
});
test("cancellation while signing never releases the new token", async () => {
  const r = await rig();
  try {
    const leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    const issuer = r.issuer(), original = issuer.mint.bind(issuer);
    issuer.mint = async (...args) => {
      const token = await original(...args);
      leases.cancel(admission().runId);
      return token;
    };
    await assert.rejects(() => leases.renew(admission().runId, "homelab", issuer, async x => structuredClone(x)), /run_changed/);
  } finally { r.remove(); }
});
test("frequent checks cannot hide cumulative frozen-clock drift, even across restarts", async () => {
  const r = await rig();
  try {
    for (let i = 1; i <= 30; i++) {
      r.sample = { ...r.sample, monotonicSeconds: 100 + i };
      r.clock.check();
      if (i === 15) r.restart();
    }
    r.sample = { ...r.sample, monotonicSeconds: 131 };
    assert.throws(() => r.clock.check(), /clock_rollback/);
  } finally { r.remove(); }
});
test("clock samples taken after lock acquisition tolerate interleaved processes", async () => {
  const r = await rig();
  const other = new AccessState(join(r.scratch.path, "state.sqlite"));
  try {
    let ticks = 0;
    const sample = () => ({ ...r.sample, monotonicSeconds: 100 + (++ticks) / 1000 });
    const a = new Clock(r.state, sample), b = new Clock(other, sample);
    const transaction = r.state.transaction.bind(r.state);
    // B commits while A is waiting for the lock. A must not retain a pre-lock sample.
    r.state.transaction = fn => { b.check(); return transaction(fn); };
    assert.equal(a.check(), N);
    assert.equal(ticks, 2);
    r.state.transaction = transaction;
  } finally { other.close(); r.remove(); }
});
test("missing durable state fails closed and initialization never overwrites state", async () => {
  const r = await rig();
  try {
    const path = join(r.scratch.path, "missing.sqlite");
    assert.throws(() => new AccessState(path), /ENOENT/);
    const created = new AccessState(path, { initialize: true }); created.close();
    assert.throws(() => new AccessState(path, { initialize: true }), /EEXIST/);
    const reopened = new AccessState(path); reopened.close();
  } finally { r.remove(); }
});
test("state and lease constructors wait for another process holding a write lock", { timeout: 15000 }, async () => {
  const r = await rig();
  try {
    for (const mode of ["open", "leases"]) {
      const args = [new URL("../helpers/access-lock.ts", import.meta.url).pathname, join(r.scratch.path, "state.sqlite")];
      const opener = spawn(process.execPath, [...args, mode], { stdio: ["pipe", "pipe", "pipe"] });
      let stderr = "", stdout = "";
      opener.stderr.on("data", x => { stderr += String(x); });
      opener.stdout.on("data", x => { stdout += String(x); });
      const completed = new Promise<number | null>(resolve => opener.once("exit", resolve));
      let holder: ReturnType<typeof spawn> | undefined;
      try {
        assert.match(String((await once(opener.stdout, "data"))[0]), /ready/);
        holder = spawn(process.execPath, [...args, "hold"], { stdio: ["pipe", "pipe", "pipe"] });
        assert.match(String((await once(holder.stdout!, "data"))[0]), /locked/);
        const opening = once(opener.stdout, "data");
        opener.stdin.end("go\n");
        assert.match(String((await opening)[0]), /opening/);
        await new Promise(resolve => setTimeout(resolve, 200));
        holder.stdin!.end("release\n");
        assert.equal(await completed, 0, stderr);
        assert.match(stdout, /opened/);
      } finally { opener.kill(); holder?.kill(); }
    }
  } finally { r.remove(); }
});
test("empty and marker-less state cannot reset durable revocations", async () => {
  const r = await rig();
  try {
    const empty = join(r.scratch.path, "empty.sqlite");
    writeFileSync(empty, "", { mode: 0o600 });
    assert.throws(() => new AccessState(empty), /uninitialized_state/);
    r.state.db.prepare("DELETE FROM access_meta WHERE name='format'").run();
    assert.throws(() => new AccessState(join(r.scratch.path, "state.sqlite")), /invalid_state_format/);
  } finally { r.remove(); }
});
test("storage failure cannot acknowledge revocation or release a renewed bearer", async () => {
  const r = await rig();
  try {
    const leases = new RunLeases(r.state, r.clock); leases.admit(admission());
    r.state.db.exec("PRAGMA query_only=ON");
    assert.throws(() => leases.cancel(admission().runId), /readonly/);
    await assert.rejects(() => leases.renew(admission().runId, "homelab", r.issuer(), async x => structuredClone(x)), /readonly/);
    r.state.db.exec("PRAGMA query_only=OFF");
    leases.cancel(admission().runId);
  } finally { r.remove(); }
});
