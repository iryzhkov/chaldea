import test from "node:test";
import assert from "node:assert/strict";
import { rig, event, N } from "./helpers.ts";
import { hash } from "../../src/akasha/schema.ts";
import { Ingress } from "../../src/akasha/ingress.ts";

test("projection notifies every waiter only after commit; stale pending input observes prior commit", async t => {
  const r = await rig();
  try {
    const e = event(1), receipt = r.store.admit(e, hash("request"), N);
    const envelope = JSON.parse(r.store.pending(N)[0]!.envelope);
    const p = await r.auth.authorize(await r.token(), "append");
    const ingress = new Ingress(r.auth, r.store, () => {});
    const first = ingress.visible(p, receipt), second = ingress.visible(p, receipt);
    const complete = r.store.completeSequence.bind(r.store);
    t.mock.method(r.store, "completeSequence", () => { throw new Error("rollback"); });
    assert.throws(() => r.store.project(envelope, 1, N), /rollback/);
    assert.equal(r.store.receipt(e.event_id)?.state, "pending");
    let resolved = false; void first.then(() => { resolved = true; });
    await Promise.resolve(); assert.equal(resolved, false);
    t.mock.method(r.store, "completeSequence", complete);
    r.store.project(envelope, 1, N);
    assert.equal((await first).state, "visible"); assert.equal((await second).state, "visible");
    assert.equal((await ingress.visible(p, receipt)).state, "visible");
    assert.equal(r.store.feed(receipt.feed_id!, p.scope)?.title, e.title);
  } finally { r.close(); }
});

test("receipt timeout preserves pending and clears waiters without a receipt poll", async t => {
  const r = await rig();
  try {
    const e = event(2), receipt = r.store.admit(e, hash("request"), N);
    const p = await r.auth.authorize(await r.token(), "append");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const read = t.mock.method(r.store, "ownedReceipt");
    const ingress = new Ingress(r.auth, r.store, () => {});
    const waiting = ingress.visible(p, receipt);
    t.mock.timers.tick(1799);
    await Promise.resolve(); assert.equal(read.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal((await waiting).state, "pending");
    assert.equal(read.mock.callCount(), 1);
    assert.equal(r.store.scalar("SELECT count(*) FROM events"), 0);
  } finally { r.close(); }
});

test("quarantine wakes pending waiters, and authorization is rechecked before returning", async () => {
  const r = await rig();
  try {
    const e = event(3), receipt = r.store.admit(e, hash("request"), N);
    const envelope = JSON.parse(r.store.pending(N)[0]!.envelope);
    const p = await r.auth.authorize(await r.token(), "append");
    const ingress = new Ingress(r.auth, r.store, () => {});
    const waiting = ingress.visible(p, receipt);
    r.store.quarantine(1, "invalid_payload", N, envelope);
    assert.equal((await waiting).state, "quarantined");
    const next = event(4), pending = r.store.admit(next, hash("next"), N);
    const rejected = ingress.visible(p, pending);
    r.sample = { ...r.sample, healthy: false };
    r.store.project(JSON.parse(r.store.pending(N)[0]!.envelope), 2, N);
    await assert.rejects(rejected);
  } finally { r.close(); }
});
