import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync, readFileSync } from "node:fs";
import { route } from "../../src/route/runtime.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { newProvider } from "../../src/quota/headroom.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
const failFetch: typeof fetch = async () => { throw new Error("fixture offline"); };
test("runtime consumes observer cache/stops without writing observer, collector stays opt-in", async () => {
  const d = routeScratch();
  try {
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache") }));
    const state = emptyState(), provider = newProvider("claudeAgent", "claudeAgent");
    provider.included = { value: [{ id: "weekly", kind: "weekly", usedPercent: 38, remainingPercent: 62,
      windowDurationMins: 10080, resetsAt: iso(now + .4 * 7 * 86400000) }], observedAt: iso(now), state: "fresh", source: "fixture", error: null };
    state.headroom.providers.push(provider); saveState(stateFile, state, now);
    const before = readFileSync(stateFile, "utf8");
    const opts = { home: d.path, configPath, now, catalog: async () => catalog, fetcher: failFetch };
    assert.equal((await route({ role: "builder" }, opts)).model, "claude-opus-5-5");
    assert.equal(readFileSync(stateFile, "utf8"), before);
    state.parked.set("thread", { provider: "claudeAgent", runId: "r", stopAt: now, seenAt: now, resetAt: null });
    saveState(stateFile, state, now);
    assert.equal((await route({ role: "builder" }, opts)).model, "gpt-6.1-sol");
    writeFileSync(stateFile, "corrupt");
    await assert.rejects(route({ role: "builder" }, opts), /refusing to ignore possible active stops/);
  } finally { d.remove(); }
});
test("operator weekly fallback lasts until reset, collector failures degrade with a reason", async () => {
  const d = routeScratch();
  try {
    const configPath = join(d.path, "route.json");
    writeFileSync(configPath, JSON.stringify({ stateFile: join(d.path, "none"), cacheDir: join(d.path, "cache"),
      claudeUsage: { enabled: true, credentialFile: join(d.path, "missing-credential") },
      claudeWeeklyTarget: { observedAt: iso(now - 86400000), remainingPercent: 62, resetsAt: iso(now + .4 * 7 * 86400000) } }));
    const r = await route({ role: "builder" }, { home: d.path, configPath, now, catalog: async () => catalog, fetcher: failFetch });
    assert.equal(r.model, "claude-opus-5-5");
    assert.match(r.reasons.join(" "), /operator-set weekly target/);
    assert.match(r.reasons.join(" "), /under-paced/);
    assert.equal(r.dataAges.quota.claudeAgent, 86400);
    assert.match(r.reasons.join(" "), /collection failed/);
  } finally { d.remove(); }
});
test("config defaults safe, validates fractions/keys/collector/target", () => {
  const d = routeScratch();
  try {
    assert.equal(loadRouteConfig(d.path).claudeUsage.enabled, false);
    for (const invalid of [{ minimumRemaining: -1 }, { paceMargin: 15 }, { minimumTurns: 0 },
      { claudeUsage: { enabled: "yes" } }, { claudeWeeklyTarget: { remainingPercent: 62 } }, { misspelled: true }]) {
      const path = join(d.path, "config.json"); writeFileSync(path, JSON.stringify(invalid));
      assert.throws(() => loadRouteConfig(d.path, path), /Invalid/);
    }
  } finally { d.remove(); }
});
