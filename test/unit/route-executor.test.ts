import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { recommend } from "../../src/route/policy.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { WAIT_TOOLS } from "../../src/mcp.ts";
import { fixture, now, iso } from "../fixtures/route/targets.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const weekly = () => ({ observedAt: iso(now), activeStop: false, windows: [
  { kind: "weekly", remainingPercent: 40, windowDurationMins: 10080, resetsAt: iso(now + 3600000) },
] });
const base = () => ({ ...fixture(), quota: { claudeAgent: weekly() } });

test("executor prefers Codex over expiring Claude quota with fixed and AA policies", () => {
  for (const scores of [null, fixture().scores]) {
    const data = { ...base(), scores };
    const result = recommend({ role: "executor" }, data);
    assert.equal(result.providerInstanceId, "codex");
    assert.equal(result.model, "gpt-6.1-sol");
    assert.deepEqual(result.options, { reasoningEffort: "medium" });
    assert.equal(result.topPick?.providerInstanceId, "codex");
    assert.equal(result.byProvider.claudeAgent?.eligible, true);
    assert.match(result.reasons.join(" "), /Executor prefers eligible Codex/);
    assert.equal(recommend({ role: "general" }, data).providerInstanceId, "claudeAgent");
  }
});

test("executor preference precedes use-it capacity and follows driver for custom instances", () => {
  const data = base();
  data.catalog = data.catalog.map(p => p.driverKind === "codex" ? { ...p, providerInstanceId: "cheap-codex" } : p);
  const result = recommend({ role: "executor" }, { ...data, capacity: {
    claudeAgent: { class: "use-it", reasons: ["expires soon"], remainingFraction: .4,
      reserveWeeks: 0, observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: iso(now) },
  } });
  assert.equal(result.providerInstanceId, "cheap-codex");
});

test("executor retains availability, active stops, floors, bans and effort gates", () => {
  const data = base();
  const stopped = { ...weekly(), activeStop: true };
  const cases = [
    { ...data, catalog: data.catalog.map(p => p.driverKind === "codex" ? { ...p, canRunChildTask: false } : p) },
    { ...data, quota: { ...data.quota, codex: stopped } },
    { ...data, config: { bans: ["gpt-*"] } },
    { ...data, scores: { ...data.scores, models: data.scores.models.map(s => s.model.startsWith("gpt-") ? { ...s, intelligence: 0 } : s) } },
    { ...data, catalog: data.catalog.map(p => p.driverKind === "codex" ? { ...p, models: p.models.map(m => ({ ...m, options: [] })) } : p) },
  ];
  for (const input of cases) assert.equal(recommend({ role: "executor" }, input).providerInstanceId, "claudeAgent");
  assert.throws(() => recommend({ role: "executor" }, { ...data,
    quota: { codex: stopped, claudeAgent: stopped } }), /No eligible/);
  assert.deepEqual(recommend({ role: "executor", effortOverride: "high" }, data).options, { reasoningEffort: "high" });
});

test("executor retains explicit pins, review separation and measured reliability exclusions", () => {
  const data = base();
  const pinned = recommend({ role: "executor" }, { ...data,
    config: { pins: { executor: { model: "claude-opus-5-5", providerInstanceId: "claudeAgent" } } } });
  assert.equal(pinned.providerInstanceId, "claudeAgent");
  assert.equal(recommend({ role: "executor", authorProvider: "codex" }, data).providerInstanceId, "claudeAgent");
  const analytics = structuredClone(data.analytics);
  analytics.models["gpt-6.1-sol"]!.failedRate = .5;
  assert.equal(recommend({ role: "executor" }, { ...data, scores: null, analytics }).providerInstanceId, "claudeAgent");
});

test("executor is exposed through config, MCP and CLI", () => {
  const scratch = routeScratch();
  try {
    assert.equal(loadRouteConfig(scratch.path).floors.executor, 48);
    const schema = WAIT_TOOLS.find(t => t.name === "chaldea_route")!.inputSchema;
    assert.ok((schema.properties.role as { enum: string[] }).enum.includes("executor"));
    const result = spawnSync(process.execPath, ["bin/chaldea", "route", "--role", "executor",
      "--fixture", "test/fixtures/route/builder.json"], { encoding: "utf8", env: { ...process.env, HOME: scratch.path } });
    assert.equal(result.status, 0, result.stderr);
    const r = JSON.parse(result.stdout);
    assert.equal(r.providerInstanceId, "codex");
    assert.deepEqual(r.options, { reasoningEffort: "medium" });
  } finally { scratch.remove(); }
});
