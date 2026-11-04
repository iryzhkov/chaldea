import assert from "node:assert/strict";
import { test } from "node:test";
import { publisherForRun, type Publication } from "../../src/events/publisher.ts";

test("run leases are isolated by source, host and kind, expire early, and never persist across runs", async () => {
  let now = Date.now(), minted = 0;
  const token = async () => "e30." + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 60, jti: ++minted })).toString("base64url") + ".sig";
  const e: Publication = { key: "k", source: "agent-a.toolfeedback", host: "agent-a", payload: { kind: "tool_call" } };
  const options = publisherForRun({ token }, () => now);
  const first = await options.token!(e);
  assert.equal(await options.token!({ ...e, key: "next" }), first);
  assert.equal(minted, 1);
  for (const variant of [{ ...e, source: "other" }, { ...e, host: "other" }, { ...e, payload: { kind: "agent_status" } }])
    assert.notEqual(await options.token!(variant), first);
  now += 20_000;
  assert.notEqual(await options.token!(e), first);
  assert.equal(minted, 5);
  assert.notEqual(await publisherForRun({ token }, () => now).token!(e), first);
  assert.equal(minted, 6);
});

test("near-expiry and unparseable leases are minted per request, and failures are not cached", async () => {
  let now = Date.now(), calls = 0;
  const e: Publication = { key: "k", source: "s", host: "h", payload: { kind: "tool_call" } };
  for (const value of ["unparseable", "e30." + Buffer.from(JSON.stringify({ exp: Math.floor(now / 1000) + 4 })).toString("base64url") + ".sig"]) {
    const options = publisherForRun({ token: async () => { calls++; return value; } }, () => now);
    await options.token!(e); await options.token!(e);
  }
  assert.equal(calls, 4);
  const options = publisherForRun({ token: async () => { calls++; throw Error("mint failed"); } }, () => now);
  await assert.rejects(options.token!(e), /mint failed/);
  await assert.rejects(options.token!(e), /mint failed/);
  assert.equal(calls, 6);
});
