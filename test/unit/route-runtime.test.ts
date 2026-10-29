import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
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
    const initial = await route({ role: "builder" }, opts);
    assert.equal(initial.model, "claude-opus-5-5");
    assert.match(initial.reasons.join(" "), /AA snapshot transport disabled/);
    assert.equal(initial.reasons.some(reason => reason.startsWith("AA ") && /collection.*fail/.test(reason)), false);
    assert.equal(existsSync(join(d.path, "cache", "aa-scores.json")), false);
    assert.equal(readFileSync(stateFile, "utf8"), before);
    state.parked.set("thread", { provider: "claudeAgent", runId: "r", stopAt: now, seenAt: now, resetAt: null });
    saveState(stateFile, state, now);
    assert.equal((await route({ role: "builder" }, opts)).model, "gpt-6.1-sol");
    writeFileSync(stateFile, "corrupt");
    await assert.rejects(route({ role: "builder" }, opts), /refusing to ignore possible active stops/);
  } finally { d.remove(); }
});
test("runtime accepts partial benchmark coverage and holds only the unmeasured provider", async () => {
  for (const missing of ["claude-opus-5-5", "gpt-6.1-sol"]) {
    const d = routeScratch();
    try {
      const helper = join(d.path, "helper");
      writeFileSync(helper, "#!/bin/sh\nprintf 'fixture.token.value\\n'\n", { mode: 0o700 });
      const configPath = join(d.path, "route.json");
      writeFileSync(configPath, JSON.stringify({ cacheDir: join(d.path, "cache"),
        benchmark: { indexVersion: "4.3" }, scores: { enabled: true, url: "https://akasha.fixture",
          tokenHelper: helper, host: "omarchy-pc" } }));
      const selected = catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)).map(p => ({
        ...p, models: p.models.filter(m => ["gpt-6.1-sol", "claude-opus-5-5"].includes(m.id)),
      }));
      const scores = { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "4.3",
        fetchedAt: iso(now), unmapped: [], models: ["gpt-6.1-sol", "claude-opus-5-5"].map(model => ({
          model, effort: "high", aaSlug: model + "-high", intelligence: 52, coding: null,
          inputPrice: null, outputPrice: null, benchmarkCostUSDPerTask: model === missing ? null : .5,
        })) };
      const result = await route({ role: "executor" }, { home: d.path, configPath, now, catalog: async () => selected,
        fetcher: async url => {
          if (!String(url).startsWith("https://akasha.fixture/")) throw new Error("fixture offline");
          return Response.json({ events: [{ source: "route", host: "homelab", kind: "route_score_snapshot",
            provenance: { type: "verified" }, data: { scores } }], next_cursor: null });
        } });
      const expected = missing.startsWith("claude") ? "codex" : "claudeAgent";
      assert.equal(result.providerInstanceId, expected);
      assert.equal(result.byProvider[expected]?.eligible, true);
      assert.equal(result.byProvider[expected === "codex" ? "claudeAgent" : "codex"]?.eligible, false);
    } finally { d.remove(); }
  }
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
    assert.match(r.reasons.join(" "), /credential_unavailable/);
  } finally { d.remove(); }
});
test("enabled collector skips credential access when its catalog binding is absent", async () => {
  const d = routeScratch();
  try {
    const configPath = join(d.path, "route.json"), cacheDir = join(d.path, "cache");
    writeFileSync(configPath, JSON.stringify({ cacheDir, claudeUsage: { enabled: true } }));
    const requests: string[] = [];
    const r = await route({ role: "builder" }, { home: d.path, configPath, now,
      catalog: async () => catalog.filter(p => p.providerInstanceId === "codex"),
      fetcher: async url => { requests.push(String(url)); throw new Error("fixture offline"); } });
    assert.equal(r.providerInstanceId, "codex");
    assert.ok(!requests.some(url => url.includes("api.anthropic.com")));
    assert.equal(existsSync(join(cacheDir, "claude-usage.json")), false);
  } finally { d.remove(); }
});
test("capacity thresholds are shared defaults; route overrides also govern capacity ranking", async () => {
  const d = routeScratch();
  try {
    const capacityConfigFile = join(d.path, "capacity.json"), configPath = join(d.path, "route.json");
    writeFileSync(capacityConfigFile, JSON.stringify({ paceMargin: .05, minimumRemaining: .07, maxAgeMs: 3600000 }));
    writeFileSync(configPath, JSON.stringify({ capacityConfigFile }));
    assert.equal(loadRouteConfig(d.path, configPath).paceMargin, .05);
    assert.equal(loadRouteConfig(d.path, configPath).minimumRemaining, .07);
    assert.equal(loadRouteConfig(d.path, configPath).quotaMaxAgeMs, 3600000);
    writeFileSync(configPath, JSON.stringify({ capacityConfigFile, paceMargin: .03 }));
    assert.equal(loadRouteConfig(d.path, configPath).paceMargin, .03);
  } finally { d.remove(); }
});
test("config defaults safe, validates fractions/keys/collector/target", () => {
  const d = routeScratch();
  try {
    assert.equal(loadRouteConfig(d.path).claudeUsage.enabled, false);
    assert.equal(loadRouteConfig(d.path).analyticsMaxAgeMs, 21 * 86400000);
    const valid = join(d.path, "valid.json");
    writeFileSync(valid, JSON.stringify({ analyticsMaxAgeMs: 7 * 86400000 }));
    assert.equal(loadRouteConfig(d.path, valid).analyticsMaxAgeMs, 7 * 86400000);
    for (const invalid of [{ minimumRemaining: -1 }, { paceMargin: 15 }, { minimumTurns: 0 },
      { analyticsMaxAgeMs: 0 }, { analyticsMaxAgeMs: -1 }, { analyticsMaxAgeMs: "21" },
      { claudeUsage: { enabled: "yes" } }, { claudeWeeklyTarget: { remainingPercent: 62 } }, { misspelled: true }]) {
      const path = join(d.path, "config.json"); writeFileSync(path, JSON.stringify(invalid));
      assert.throws(() => loadRouteConfig(d.path, path), /Invalid/);
    }
  } finally { d.remove(); }
});
