import assert from "node:assert/strict";
import { test } from "node:test";
import { capacityKey } from "../../src/quota/account.ts";
import { capacitySnapshot, mergeSnapshots, readSnapshotsDetailed, snapshotProvider, fleetConfig } from "../../src/quota/fleet.ts";
import { newProvider } from "../../src/quota/headroom.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import { now, iso } from "../fixtures/route/catalog.ts";

const accountKey = "a".repeat(64);
function snapshot(host: string, remaining = 60, reset = now + 86400000) {
  const p = newProvider(host, "codex"); p.accountKey = accountKey;
  p.included = { state: "fresh", source: "fixture", error: null, observedAt: iso(now), value: [
    { id: "seven_day", kind: "weekly", usedPercent: 100 - remaining, remainingPercent: remaining,
      resetsAt: iso(reset), windowDurationMins: 10080 }] };
  return capacitySnapshot(host, [p], new Set(), now);
}
test("same-observation fleet conflicts use matched ID/reset minimum independent of host order", () => {
  const a = snapshot("agent-a", 80), b = snapshot("agent-b", 12);
  const duplicate = structuredClone(a);
  duplicate.accounts[0]!.windows.push(duplicate.accounts[0]!.windows[0]!);
  assert.throws(() => mergeSnapshots([duplicate], now), /duplicate_capacity_window/);
  for (const inputs of [[a, b], [b, a]]) {
    const merged = mergeSnapshots(inputs, now).get(capacityKey("codex", accountKey))!;
    assert.equal(merged.windows[0]!.remainingPercent, 12);
    assert.equal(merged.host, "agent-a");
    assert.match(merged.conflicts.join(" "), /utilization conflict/);
  }
  const nextReset = snapshot("agent-b", 100, now + 2 * 86400000);
  const unknown = mergeSnapshots([a, nextReset], now).get(capacityKey("codex", accountKey))!;
  assert.deepEqual(unknown.windows, []);
  assert.match(unknown.conflicts.join(" "), /reset epoch/);
  assert.equal(classifyCapacity(snapshotProvider(unknown, "local"), false, now).class, "unknown");
});
test("newest observation wins without adding budgets; local duplicate stops survive", () => {
  const a = snapshot("agent-a", 80), b = snapshot("agent-b", 12);
  a.accounts[0]!.observedAt = iso(now - 1000);
  const merged = mergeSnapshots([a, b], now).get(capacityKey("codex", accountKey))!;
  assert.equal(merged.windows[0]!.remainingPercent, 12);
  assert.equal(merged.host, "agent-b");
  const row = snapshotProvider(b.accounts[0]!, "one");
  const local = capacitySnapshot("local", [row, { ...row, alias: "two" }], new Set(["two"]), now);
  assert.equal(local.accounts.length, 1); assert.equal(local.accounts[0]!.activeStop, true);
  const remote = { ...b.accounts[0]!, credits: { balance: "100", hasCredits: true, unlimited: false } };
  const p = snapshotProvider(remote, "codex-local");
  assert.equal(p.spendControlReached.value, null);
  assert.equal(classifyCapacity(p, true, now).class, "stopped");
  assert.notEqual(classifyCapacity(p, false, now).creditFunded, true);
});
test("fleet readiness distinguishes absent, disabled, transport failure and verified fresh observations", async () => {
  assert.equal((await readSnapshotsDetailed(undefined, now)).readiness, "absent");
  const config = fleetConfig({ enabled: false }, "/fixture");
  assert.equal((await readSnapshotsDetailed(config, now)).readiness, "disabled");
  const enabled = { ...config, enabled: true, url: "https://fixture.invalid", tokenHelper: "/unused" };
  const token = async () => "fixture-token";
  assert.equal((await readSnapshotsDetailed(enabled, now, async () => { throw new Error("offline"); }, token)).readiness, "unavailable");
  const s = snapshot("agent-a");
  const result = await readSnapshotsDetailed(enabled, now, async () => Response.json({ next_cursor: null,
    events: [{ source: "quota", kind: "quota_headroom_snapshot", host: "agent-a", provenance: { type: "verified" }, data: { capacity: s } }] }), token);
  assert.equal(result.readiness, "ready"); assert.equal(mergeSnapshots(result.snapshots, now).size, 1);
  assert.equal(mergeSnapshots(result.snapshots, now + 15 * 60000).size, 0);
});
