import assert from "node:assert/strict";
import { test } from "node:test";

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { recommend } from "../../src/route/policy.ts";


import { newProvider, applyT3 } from "../../src/quota/headroom.ts";
import { DEFAULT_POLICY } from "../../src/route/types.ts";
import { roleAnchors, inProbation, emptyHistory } from "../../src/route/targets.ts";
import { modelWindowPolicy, windowPolicy } from "../../src/quota/window-policy.ts";
import { classifyCapacity } from "../../src/quota/capacity.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { fixture, now, iso, stats } from "../fixtures/route/targets.ts";

test("a fallback cannot replace Terra's incumbent across stop, restart and recovery", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite");
  let state = new RouteState(path);
  try {
    const f = fixture();
    const models = ["gpt-6.1-sol", "gpt-6.1-terra", "gemini-4-neon"];
    const data = { ...f, catalog: [
      { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
        models: models.slice(0, 2).map(id => ({ id, options: [{ id: "reasoningEffort", type: "select", options: [{ id: "high" }] }] })) },
      { providerInstanceId: "google", driverKind: "antigravity", canRunChildTask: true,
        models: [{ id: "gemini-4-neon", options: [{ id: "thought_level", type: "select", options: [{ id: "high" }] }] }] },
    ], scores: { version: 2 as const, metric: "aa-intelligence-cost-per-task" as const,
      fetchedAt: iso(now), indexVersion: "5", unmapped: [], models: models.map((model, i) => ({
        model, effort: "high" as const, aaSlug: model, intelligence: 60, coding: null,
        inputPrice: null, outputPrice: null, benchmarkCostUSDPerTask: i === 0 ? 5 : 1,
      })) }, config: { benchmark: { indexVersion: "5" } },
      analytics: { ...f.analytics, models: { "gpt-6.1-sol": stats(), "gpt-6.1-terra": stats() } },
      history: f.history };
    // Seed sufficient operational evidence for the cheaper Terra's initial trial.
    const db = new DatabaseSync(path);
    const history = emptyHistory(); history.seen["gpt-6.1-terra"] = now - 8 * 86400000;
    db.prepare("INSERT INTO history VALUES(?,?)").run("builder:benchmark:5", JSON.stringify(history));
    db.close();
    assert.equal(state.recommend({ role: "builder" }, data, "fixture", false).model, "gpt-6.1-terra");
    const stopped = { ...data, quota: { codex: { observedAt: iso(now), windows: [], activeStop: true } } };
    assert.equal(state.recommend({ role: "builder" }, stopped, "fixture", false).model, "gemini-4-neon");
    state.close(); state = new RouteState(path);
    assert.equal(state.recommend({ role: "builder" }, data, "fixture", false).model, "gpt-6.1-terra");
    const check = new DatabaseSync(path);
    const stored = JSON.parse(String(check.prepare("SELECT value FROM history WHERE role=?").get("builder:benchmark:5")!.value));
    check.close();
    assert.equal(stored.picks["builder:benchmark:5"].model, "gpt-6.1-terra");
  } finally { state.close(); d.remove(); }
});
test("native Opus and explicit driver allowlists exempt only their own driver", () => {
  const h = emptyHistory();
  assert.ok(roleAnchors("builder", DEFAULT_POLICY, "claudeAgent").includes("claude-opus-5-5"));
  assert.ok(!roleAnchors("builder", DEFAULT_POLICY, "antigravity").includes("claude-opus-5-5"));
  assert.equal(inProbation("claude-opus-5-5", "builder", h, DEFAULT_POLICY, now, "antigravity"), true);
  assert.equal(inProbation("claude-opus-5-5", "builder", h, DEFAULT_POLICY, now, "claudeAgent"), false);
  const config = { ...DEFAULT_POLICY, driverModels: { antigravity: ["custom"] } };
  assert.equal(inProbation("custom", "builder", h, config, now, "antigravity"), false);
  assert.equal(inProbation("custom", "builder", h, config, now, "claudeAgent"), true);
  const f = fixture();
  const google = { providerInstanceId: "google", driverKind: "antigravity", canRunChildTask: true,
    models: [{ id: "claude-opus-5-5", options: [{ id: "thought_level", type: "select", options: [{ id: "high" }] }] }] };
  const result = recommend({ role: "builder" }, { ...f, catalog: [...f.catalog, google],
    config: { providerPreference: ["antigravity"] } });
  assert.equal(result.byProvider.antigravity?.eligible, false);
});
const window = (id: string, remainingPercent: number) => ({ id,
  kind: id.endsWith("5h") ? "session" : "weekly", remainingPercent,
  windowDurationMins: id.endsWith("5h") ? 300 : 10080, resetsAt: iso(now + 3600000) });
test("Antigravity Gemini, third-party and Argon windows gate only matching models", () => {
  const check = (windows: Parameters<typeof modelWindowPolicy>[0], model: string) => modelWindowPolicy(windows, model, now, .1, .1);
  for (const suffix of ["5h", "weekly"]) {
    const windows = [window("3p-" + suffix, 0), window("gemini-" + suffix, 80)];
    assert.equal(check(windows, "gemini-4-neon").gate, null);
    assert.equal(check(windows, "gemini-4-neon").limit, undefined);
    for (const model of ["claude-opus-5-5", "gpt-oss-120b-medium"])
      assert.ok(check(windows, model).gate || check(windows, model).limit);
    const reverse = [window("3p-" + suffix, 80), window("gemini-" + suffix, 0)];
    assert.equal(check(reverse, "claude-opus-5-5").gate, null);
    assert.equal(check(reverse, "claude-opus-5-5").limit, undefined);
    assert.ok(check(reverse, "gemini-4-neon").gate || check(reverse, "gemini-4-neon").limit);
  }
  const argon = [window("gemini-argon-wtu-weekly", 0)];
  assert.ok(check(argon, "gemini-4-argon").limit);
  assert.equal(check(argon, "gemini-4-neon").limit, undefined);
  const row = newProvider("google", "antigravity");
  // Exercise the real T3 usage projection, including usedPercent -> remainingPercent.
  applyT3(row, { instanceId: "google", driver: "antigravity", enabled: true, installed: true,
    status: "ready", auth: { status: "authenticated" }, models: [], usageLimits: { checkedAt: iso(now),
    windows: [window("gemini-weekly", 80), window("3p-5h", 0)].map(w => ({ ...w, usedPercent: 100 - w.remainingPercent })) } });
  assert.equal(row.included.value?.[0]?.remainingPercent, 80);
  assert.equal(classifyCapacity(row, false, now).class, "unknown");
  assert.equal(windowPolicy(row.included.value!, now, .1, .1).gate, null);
  assert.equal(check(row.included.value!, "gemini-4-neon").binding?.id, "gemini-weekly");
});
