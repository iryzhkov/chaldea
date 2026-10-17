import test from "node:test";
import assert from "node:assert/strict";
import { HEALTH_FIELDS, readHealth } from "../../src/access/clock.ts";
import { AccessError } from "../../src/access/token.ts";
import { ensure, fields, HttpError, parse } from "../../src/akasha/schema.ts";

const policy = { decode: parse, fields: (h: Record<string, unknown>) => fields(h, HEALTH_FIELDS), check: ensure };
test("shared clock reader preserves access and Akasha error contracts", () => {
  const now = 100;
  const valid = { healthy: true, offsetSeconds: 0, checked_at: 99 };
  assert.deepEqual(readHealth(Buffer.from(JSON.stringify(valid)), now, policy), { healthy: true, offsetSeconds: 0 });
  for (const [sample, code] of [
    ["{", "invalid_json"], ["[]", "invalid_object"],
    [JSON.stringify({ ...valid, extra: true }), "unknown_field"],
    [JSON.stringify({ ...valid, checked_at: 69 }), "clock_health_stale"],
    [JSON.stringify({ ...valid, checked_at: 101 }), "clock_health_stale"],
    [JSON.stringify({ ...valid, offsetSeconds: "0" }), "clock_health_stale"],
  ]) {
    assert.throws(() => readHealth(Buffer.from(sample!), now, policy),
      (error: unknown) => error instanceof HttpError && error.status === 400 && error.message === code);
  }
  assert.throws(() => readHealth(Buffer.from("{}"), now),
    (error: unknown) => error instanceof AccessError && error.message === "invalid_fields");
});
