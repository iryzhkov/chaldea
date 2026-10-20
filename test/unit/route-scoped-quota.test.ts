import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { parseClaudeUsage, collectClaudeUsage } from "../../src/route/claude-usage.ts";
import { writeJson } from "../../src/route/cache.ts";
import { recommend } from "../../src/route/policy.ts";
import { route } from "../../src/route/runtime.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import { modelWindowPolicy, windowPolicy, fableModel } from "../../src/quota/window-policy.ts";
import { HeadroomMonitor, emptyHeadroom, newProvider } from "../../src/quota/headroom.ts";
import { headroomConfig } from "../../src/quota/codex-balance.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { capacitySnapshot } from "../../src/quota/fleet.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const raw = (fable = 100) => ({ five_hour: { utilization: 10, resets_at: iso(now + 3600000) },
  seven_day: { utilization: 20, resets_at: iso(now + 86400000) },
  seven_day_fable: { utilization: fable, resets_at: iso(now + 86400000) } });
test("direct parser and successful-cache path retain distinct native window IDs", async () => {
  const d = routeScratch();
  try {
    const value = parseClaudeUsage(raw(), now);
    assert.deepEqual(value.windows.map(w => w.id), ["five_hour", "seven_day", "seven_day_fable"]);
    assert.equal(parseClaudeUsage({ ...raw(), seven_day_fable: null }, now).windows.length, 2);
    assert.throws(() => parseClaudeUsage({ ...raw(), seven_day_fable: { utilization: "bad" } }, now));
    const cacheFile = join(d.path, "usage.json");
    writeJson(cacheFile, { attemptedAt: now, fetchedAt: iso(now), value });
    const cached = await collectClaudeUsage({ enabled: true, credentialFile: "/must-not-read",
      cacheFile, now, fetcher: async () => { throw new Error("must not collect"); } });
    assert.deepEqual(cached.value?.windows, value.windows);
  } finally { d.remove(); }
});
test("direct Claude observer fallback preserves the optional scoped native ID", async () => {
  const accountKey = "b".repeat(64), usage = { ...parseClaudeUsage(raw(), now), accountKey };
  const m = new HeadroomMonitor({ state: emptyHeadroom(), local: true, now: () => now, save() {},
    config: headroomConfig({ claudeContexts: [{ enabled: true, providerInstanceId: "claude-fallback",
      credentialFile: "/must-not-read" }] }),
    claudeRead: async () => ({ value: usage, fetchedAt: iso(now), reason: null }) });
  try {
    m.update([{ instanceId: "claude-fallback", driver: "claudeAgent", quotaAccountKey: accountKey,
      enabled: true, installed: true, status: "ready", auth: { status: "authenticated" }, models: [],
      usageLimits: { checkedAt: iso(now), windows: [], unavailable: { reason: "unsupported" } } }]);
    await m.tick();
    assert.equal(m.state.providers[0]!.included.source, "claude-usage");
    assert.deepEqual(m.state.providers[0]!.included.value!.map(w => w.id), ["five_hour", "seven_day", "seven_day_fable"]);
  } finally { await m.close(); }
});

test("common windows constrain every Claude model; scoped limit constrains only normalized Fable", () => {
  const q = { ...parseClaudeUsage(raw(), now), activeStop: false };
  const data = { catalog, now, quota: { claudeAgent: q }, analytics: null };
  assert.equal(recommend({ role: "builder" }, data).model, "claude-opus-5-5");
  assert.equal(recommend({ role: "critical-review" }, data).model, "gpt-6-astra");
  for (const model of ["claude-fable-5-1", "fable-5.1", "custom/claude-fable-5-1", "custom:anthropic/fable"]) {
    assert.equal(fableModel(model), true);
    assert.equal(modelWindowPolicy(q.windows, model, now, .1, .1).limit?.id, "seven_day_fable");
    const pinned = { ...data, catalog: catalog.map(p => p.driverKind === "claudeAgent"
      ? { ...p, models: [{ ...p.models[0]!, id: model }] } : p),
      config: { pins: { builder: { model } } } };
    assert.throws(() => recommend({ role: "builder" }, pinned), /No eligible/);
  }
  const stopped = { ...q, windows: q.windows.map(w => w.id === "five_hour" ? { ...w, remainingPercent: 0 } : w) };
  assert.equal(recommend({ role: "builder" }, { ...data, quota: { claudeAgent: stopped } }).providerInstanceId, "codex");
  const commonLow = { ...q, windows: q.windows.map(w => w.id === "seven_day" ? { ...w, remainingPercent: 1 } : w) };
  assert.equal(recommend({ role: "builder" }, { ...data, quota: { claudeAgent: commonLow } }).providerInstanceId, "codex");
});
test("scoped windows cannot establish provider capacity; missing scoped data stays unknown", () => {
  const q = parseClaudeUsage(raw(), now), p = newProvider("claudeAgent", "claudeAgent");
  p.included = { value: q.windows.map(w => ({ ...w, id: w.id!, usedPercent: 100 - w.remainingPercent })),
    observedAt: iso(now), state: "fresh", error: null, source: "fixture" };
  assert.equal(classifyCapacity(p, false, now).class, "use-it");
  p.included = { ...p.included, value: p.included.value!.filter(w => w.id === "seven_day_fable") };
  assert.equal(classifyCapacity(p, false, now).class, "unknown");
  const missing = modelWindowPolicy(q.windows.filter(w => w.id !== "seven_day_fable"), "claude-fable-5-1", now, .1, .1);
  assert.equal(missing.scopeKnown, false); assert.equal(missing.pace, null);
  const long = q.windows.filter(w => w.kind === "weekly").map(w => ({ ...w, id: "account-" + w.id }));
  assert.ok(windowPolicy(long, now, .1, .1).limit, "a second weekly window cannot hide a binding limit");
});
test("native T3 IDs cross observer, fleet and runtime candidate boundaries with collection disabled", async () => {
  const d = routeScratch(), accountKey = "a".repeat(64);
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config: headroomConfig(), local: true, now: () => now, save() {} });
  try {
    const usage = parseClaudeUsage(raw(), now);
    const p: SwitchProvider = { instanceId: "claudeAgent", driver: "claudeAgent", quotaAccountKey: accountKey,
      enabled: true, installed: true, status: "ready", auth: { status: "authenticated" }, models: [],
      usageLimits: { checkedAt: iso(now), windows: usage.windows.map(w => ({ id: w.id!, kind: w.kind,
        usedPercent: 100 - w.remainingPercent, windowDurationMins: w.windowDurationMins!, resetsAt: w.resetsAt! })) } };
    m.update([p]); await m.tick();
    assert.deepEqual(capacitySnapshot("fixture", m.state.providers, new Set(), now).accounts[0]!.windows.map(w => w.id),
      ["five_hour", "seven_day", "seven_day_fable"]);
    const state = emptyState(); state.headroom = m.state;
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
    saveState(stateFile, state, now);
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache"),
      claudeUsage: { enabled: false }, scores: { enabled: false } }));
    const result = await route({ role: "critical-review" }, { home: d.path, configPath, now,
      catalog: async () => catalog.map(p => p.providerInstanceId === "claudeAgent" ? { ...p, accountKey } : p),
      fetcher: async () => { throw new Error("fixture offline"); } });
    assert.equal(result.model, "gpt-6-astra");
    assert.equal(result.diagnostics?.fleet?.readiness, "absent");
    assert.equal(result.diagnostics?.quality_source, "fixed_policy");
  } finally { await m.close(); d.remove(); }
});
