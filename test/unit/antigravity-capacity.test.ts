import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import type { Capacity } from "../../src/quota/capacity.ts";
import { HeadroomMonitor, newProvider } from "../../src/quota/headroom.ts";
import type { Window } from "../../src/quota/headroom.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { scoreSnapshot } from "../../src/route/scores.ts";
import { recommend } from "../../src/route/policy.ts";
import type { PolicyData } from "../../src/route/policy.ts";
import { routeCatalog, collectRouteContext } from "../../src/route/runtime.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { fixture, now, iso } from "../fixtures/route/targets.ts";

const WEEK = 10080 * 60_000;
const win = (id: string, kind: string, mins: number, left: number, resetsAt: string | null): Window =>
  ({ id, kind, usedPercent: 100 - left, remainingPercent: left, windowDurationMins: mins, resetsAt });
// The live 2026-11-22 omarchy-pc Antigravity snapshot shape.
const live = (geminiLeft = 66, timeLeft = .8, fiveHourLeft = 90) => [
  win("3p-5h", "session", 300, 100, null), win("gemini-5h", "session", 300, fiveHourLeft, iso(now + 3600_000)),
  win("3p-weekly", "weekly", 10080, 100, null), win("gemini-argon-wtu-weekly", "weekly", 10080, 100, null),
  win("gemini-weekly", "weekly", 10080, geminiLeft, iso(now + timeLeft * WEEK))];
const row = (driver: string, windows: Window[]) => {
  const p = newProvider(driver, driver);
  p.included = { state: "fresh", observedAt: iso(now), source: "t3", error: null, value: windows };
  return p;
};

test("Antigravity capacity is classified from the routed model family's windows", () => {
  const p = row("antigravity", live());
  const provider = classifyCapacity(p, false, now);
  assert.equal(provider.class, "unknown");
  const gemini = classifyCapacity(p, false, now, undefined, "gemini-4-neon");
  assert.equal(gemini.class, "paced");
  assert.equal(gemini.remainingFraction, .66);
  assert.ok(gemini.reasons.includes("weekly 66% left with 80% of window left: on/ahead of pace"));
  assert.ok(gemini.reasons.some(r => r.startsWith("5h window 90% left")));
  assert.ok(!gemini.reasons.some(r => r.startsWith("missing, stale or expired")));
  // 3p-weekly has no reset, so Claude/GPT through Antigravity have no established pacing.
  assert.equal(classifyCapacity(p, false, now, undefined, "claude-opus-5-5").class, "unknown");
  assert.equal(classifyCapacity(row("antigravity", live(95, .5)), false, now, undefined, "gemini-4-neon").class, "use-it");
  // A Gemini short-window gate never touches the 3p family.
  const gated = row("antigravity", live(66, .8, 5));
  assert.equal(classifyCapacity(gated, false, now, undefined, "gemini-4-neon").class, "tight");
  assert.equal(classifyCapacity(gated, false, now, undefined, "claude-opus-5-5").class, "unknown");
  assert.equal(classifyCapacity(p, true, now, undefined, "gemini-4-neon").class, "stopped");
});
test("Claude and Codex capacity ignore the model argument", () => {
  for (const driver of ["codex", "claudeAgent"]) {
    const p = row(driver, [win("five_hour", "session", 300, 60, iso(now + 3600_000)), win("seven_day", "weekly", 10080, 66, iso(now + .8 * WEEK))]);
    const base = classifyCapacity(p, false, now);
    for (const model of ["gemini-4-neon", "claude-opus-5-5", "gpt-6.1-sol"])
      assert.deepEqual(classifyCapacity(p, false, now, undefined, model), base);
  }
});

const capacity = (kind: Capacity["class"]): Capacity => ({ class: kind, reasons: ["fixture"], remainingFraction: .9, reserveWeeks: 0,
  observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: iso(now) });
function data(): PolicyData {
  const f = fixture();
  const scores = scoreSnapshot({ intelligence_index_version: 5, data: ([["low", 44.1], ["medium", 54.9], ["high", 59.6]] as const)
    .map(([effort, intelligence]) => ({ slug: "gemini-4-neon-" + effort,
      evaluations: { artificial_analysis_intelligence_index: intelligence, artificial_analysis_coding_index: 60 },
      pricing: { price_1m_input_tokens: 1, price_1m_output_tokens: 2 },
      artificial_analysis_intelligence_index_cost: { cost_per_task: { total_cost: { low: .5, medium: 1, high: 2 }[effort] } } })) }, now, 2);
  return { ...f,
    scores: { ...scores, models: [...scores.models, ...f.scores.models.map(s => ({ ...s, benchmarkCostUSDPerTask: 5 }))] },
    catalog: [...f.catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId)).map(p => ({
      ...p, models: p.models.filter(m => ["claude-opus-5-5", "gpt-6.1-sol"].includes(m.id)) })),
    { providerInstanceId: "antigravity", driverKind: "antigravity", canRunChildTask: true,
      models: [{ id: "gemini-4-neon", options: [{ id: "thought_level", type: "select", options: ["low", "medium", "high"].map(id => ({ id })) }] }] }],
    config: { benchmark: { indexVersion: "5" }, bans: ["*sonnet*"] } };
}
test("a use-it Antigravity model still ranks after every eligible primary driver", () => {
  const f = data();
  f.capacity = { codex: capacity("paced"), claudeAgent: capacity("paced"), antigravity: capacity("unknown"),
    "antigravity:gemini-4-neon": capacity("use-it") };
  for (const role of ["general", "builder", "executor"] as const) {
    const r = recommend({ role }, f);
    assert.notEqual(r.providerInstanceId, "antigravity", role);
    assert.equal(r.alternatives.at(-1)?.providerInstanceId, "antigravity", role);
    assert.ok(r.reasons.some(x => x.startsWith("antigravity capacity use-it")), role);
  }
  // The per-model entry, not the provider-wide one, gates the routed model.
  f.capacity = { ...f.capacity, "antigravity:gemini-4-neon": capacity("tight") };
  assert.equal(recommend({ role: "general" }, f).byProvider.antigravity?.eligible, false);
  f.capacity = { ...f.capacity, antigravity: capacity("tight"), "antigravity:gemini-4-neon": capacity("paced") };
  assert.equal(recommend({ role: "general" }, f).byProvider.antigravity?.eligible, true);
});
test("route context reports the live Gemini weekly pacing as Antigravity capacity", async () => {
  const d = routeScratch();
  try {
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
    const state = emptyState();
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache") }));
    const usage = (at: number) => ({ credentialFingerprint: "a".repeat(64), checkedAt: iso(at), windows: live().map(w =>
      ({ id: w.id, kind: w.kind, usedPercent: w.usedPercent, windowDurationMins: w.windowDurationMins!, ...(w.resetsAt ? { resetsAt: w.resetsAt } : {}) })) });
    const ag = (at: number): SwitchProvider => ({ instanceId: "antigravity", driver: "antigravity", enabled: true, installed: true,
      status: "ready", auth: { status: "authenticated" }, models: ["gemini-4-neon", "claude-opus-5-5"].map(slug => ({ slug,
        capabilities: { optionDescriptors: [{ id: "thought_level", type: "select", options: [{ id: "medium" }] }] } })),
      usageLimits: usage(at) });
    // Two attributed snapshots admit the live credential context, as in the observer.
    let clock = now - 20;
    const monitor = new HeadroomMonitor({ state: state.headroom, config: { contexts: [], lowHeadroomPercent: 10 },
      local: true, now: () => clock, save: () => {} });
    monitor.update([ag(clock - 1)]); clock += 10; monitor.update([ag(clock - 1)]);
    saveState(stateFile, state, now);
    const { data: context } = await collectRouteContext({ home: d.path, configPath, now, catalog: async () => routeCatalog([ag(now - 1)]),
      fetcher: async () => { throw new Error("fixture offline"); } });
    assert.equal(context.capacity?.antigravity?.class, "unknown");
    assert.equal(context.capacity?.["antigravity:gemini-4-neon"]?.class, "paced");
    assert.equal(context.capacity?.["antigravity:claude-opus-5-5"]?.class, "unknown");
    const r = recommend({ role: "general" }, { ...context, config: { ...context.config, benchmark: { indexVersion: "5" },
      driverModels: { antigravity: ["gemini-4-neon"] } },
      scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(now), unmapped: [],
        models: [{ model: "gemini-4-neon", effort: "medium", aaSlug: "gemini-4-neon", intelligence: 60, coding: 60,
          inputPrice: 1, outputPrice: 1, benchmarkCostUSDPerTask: 1 }] } });
    assert.equal(r.providerInstanceId, "antigravity");
    const line = r.reasons.find(x => x.startsWith("antigravity capacity "));
    assert.match(line!, /^antigravity capacity paced: 5h window 90% left; reset .*; weekly 66% left with 80% of window left: on\/ahead of pace; /);
    assert.doesNotMatch(line!, /missing, stale or expired/);
  } finally { d.remove(); }
});
