import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { writeJson } from "../../src/route/cache.ts";
import { recommend } from "../../src/route/policy.ts";
import { route } from "../../src/route/runtime.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import { modelWindowPolicy, windowPolicy, fableModel } from "../../src/quota/window-policy.ts";
import { HeadroomMonitor, emptyHeadroom, newProvider } from "../../src/quota/headroom.ts";
import { headroomConfig } from "../../src/quota/codex-balance.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const nativeQuota = () => ({ observedAt: iso(now), windows: [
  { id: "five_hour", kind: "session", remainingPercent: 90, resetsAt: iso(now + 3600000), windowDurationMins: 300 },
  { id: "seven_day", kind: "weekly", remainingPercent: 80, resetsAt: iso(now + 86400000), windowDurationMins: 10080 },
  { id: "seven_day_fable", kind: "weekly", remainingPercent: 0, resetsAt: iso(now + 86400000), windowDurationMins: 10080 },
] });
test("common windows constrain every Claude model; scoped limit constrains only normalized Fable", () => {
  const q = { ...nativeQuota(), activeStop: false };
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
  const q = nativeQuota(), p = newProvider("claudeAgent", "claudeAgent");
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
