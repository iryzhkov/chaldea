import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AccessState } from "../../src/access/trust.ts";
import { healthClock } from "../../src/access/maintenance.ts";
import { scratchDir } from "../helpers/scratch.ts";

assert.ok(process.env.HOME && process.env.HOME !== "/home/igor");
assert.equal(process.env.HOME, process.env.CHALDEA_TRUST_TEST_HOME);
assert.ok(process.env.CHALDEA_TEST_SCRATCH?.startsWith(process.env.HOME + "/"));

test("health file rejects stale, future, unknown, malformed and excessive-offset samples", () => {
  const s = scratchDir("trust-health");
  const state = new AccessState(join(s.path, "state.sqlite"), { initialize: true });
  try {
    const path = join(s.path, "health.json"), now = Math.floor(Date.now() / 1000);
    const good = { healthy: true, offsetSeconds: 0, checked_at: now };
    for (const value of [
      { ...good, checked_at: now - 31 }, { ...good, checked_at: now + 60 },
      { ...good, healthy: false }, { ...good, offsetSeconds: 30.01 },
      { ...good, offsetSeconds: -30.01 }, { ...good, offsetSeconds: "0" },
      { ...good, extra: true }, { healthy: true, offsetSeconds: 0 },
    ]) {
      writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
      assert.throws(() => healthClock(state, path).check());
    }
    writeFileSync(path, JSON.stringify({ ...good, checked_at: Math.floor(Date.now() / 1000) }));
    assert.ok(healthClock(state, path).check() >= now);
  } finally { state.close(); s.remove(); }
});
