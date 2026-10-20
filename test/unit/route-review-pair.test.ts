import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { recommendReviewPair } from "../../src/route/pair.ts";
import { routeReviewPair, route } from "../../src/route/runtime.ts";
import { RouteState } from "../../src/route/state.ts";
import { emptyHistory } from "../../src/route/targets.ts";
import { writeJson } from "../../src/route/cache.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { compactRoute } from "../../src/route/output.ts";
import { recommend } from "../../src/route/policy.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
const base = { catalog, now, quota: {}, analytics: null };
const quota = { observedAt: iso(now), activeStop: false, windows: [
  { id: "seven_day", kind: "weekly", remainingPercent: 0, windowDurationMins: 10080, resetsAt: iso(now + 86400000) }] };

test("adopted pair uses exact native options and cross-provider main for either author", () => {
  for (const authorProvider of ["codex", "claudeAgent"] as const) {
    const r = recommendReviewPair({ authorProvider }, base);
    assert.equal(r.status, "complete"); assert.equal(r.quotaException, false);
    assert.equal(r.main!.model, authorProvider === "codex" ? "claude-opus-5-5" : "gpt-6.1-sol");
    assert.deepEqual([r.main!, r.peer!].find(t => t.model === "gpt-6.1-sol")!.options, { reasoningEffort: "high" });
    assert.deepEqual([r.main!, r.peer!].find(t => t.model === "claude-opus-5-5")!.options, { effort: "medium" });
  }
  const pin = recommendReviewPair({ authorProvider: "codex" }, { ...base,
    config: { pins: { builder: { providerInstanceId: "codex", model: "gpt-6.1-sol" } } } });
  assert.equal(pin.status, "unavailable"); assert.equal(pin.code, "pin_conflict");
});
test("same-provider exception requires fresh real quota pressure and two distinct models", () => {
  const input = { authorProvider: "codex" as const, peerRole: "critical-review" as const, peerEffort: "medium" as const, allowQuotaException: true };
  const known = recommendReviewPair(input, { ...base, quota: { claudeAgent: quota } });
  assert.equal(known.status, "complete"); assert.equal(known.code, "quota_exception");
  assert.equal(known.main!.model, "gpt-6.1-sol"); assert.equal(known.peer!.model, "gpt-6-astra");
  for (const observation of [{ ...quota, observedAt: null, windows: [] }, { ...quota, observedAt: iso(now - 15 * 60000) },
    { ...quota, incomplete: true }]) {
    const result = recommendReviewPair(input, { ...base, quota: { claudeAgent: observation } });
    assert.equal(result.quotaException, false);
  }
  const missing = recommendReviewPair(input, { ...base, catalog: catalog.filter(p => p.driverKind !== "claudeAgent"),
    quota: { claudeAgent: quota } });
  assert.equal(missing.status, "unavailable"); assert.equal(missing.quotaException, false);
  const onlyMain = recommendReviewPair({ authorProvider: "codex", allowQuotaException: true }, { ...base, quota: { claudeAgent: quota } });
  assert.equal(onlyMain.status, "partial"); assert.equal(onlyMain.quotaException, true);
  assert.equal(onlyMain.main!.providerInstanceId, "codex"); assert.equal(onlyMain.peer, null);
  const stopped = recommendReviewPair({ ...input, allowQuotaException: false }, { ...base, quota: { claudeAgent: quota } });
  assert.equal(stopped.status, "unavailable");
});
test("pair runtime collects once, keeps route projection compact and reports catalog/config failures", async () => {
  const d = routeScratch();
  try {
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json"), cacheDir = join(d.path, "cache");
    saveState(stateFile, emptyState(), now);
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir, scores: { enabled: false }, claudeUsage: { enabled: false } }));
    writeJson(join(cacheDir, "slopalytics.json"), { attemptedAt: now, fetchedAt: null, value: null });
    let collections = 0;
    const options = { home: d.path, configPath, now, catalog: async () => { collections++; return catalog; },
      fetcher: async () => { throw new Error("offline"); } };
    const pair = await routeReviewPair({ authorProvider: "codex" }, options);
    assert.equal(pair.status, "complete"); assert.equal(collections, 1);
    const result = compactRoute(await route({ role: "builder" }, options));
    assert.equal(result.model, result.target.model); assert.equal(result.quality_source, "fixed_policy");
    assert.equal(result.fleet!.readiness, "absent"); assert.ok(result.reasons.length <= 2);
    await assert.rejects(route({ role: "builder" }, { ...options, catalog: async () => { throw new Error("offline"); } }),
      { code: "catalog_unavailable" });
    writeFileSync(configPath, "{broken");
    await assert.rejects(route({ role: "builder" }, options), { code: "config" });
    const huge = compactRoute(recommend({ role: "builder" }, { ...base, catalog: [...catalog,
      ...Array.from({ length: 1000 }, (_, i) => ({ ...catalog[0]!, providerInstanceId: "unavailable-" + i, canRunChildTask: false }))] }));
    assert.ok(JSON.stringify(huge).length < 5000);
  } finally { d.remove(); }
});
test("pair probation reserves each returned slot once, without nested single-route reservations", () => {
  const d = routeScratch(), path = join(d.path, "history.sqlite");
  try {
    const routing = new RouteState(path), db = new DatabaseSync(path);
    const history = emptyHistory();
    history.seen["gpt-6-astra"] = now - 1000;
    history.allocations["gpt-6-astra"] = { calls: 20, trials: 1 };
    db.prepare("INSERT INTO history VALUES(?,?)").run("builder:high", JSON.stringify(history));
    const models = ["gpt-6.1-sol", "gpt-6-astra"];
    const stats = { turns: 200, completionRate: .99, failedRate: .01, interruptedRate: 0, minutesPerTurn: 1 };
    const data = { ...base, quota: { claudeAgent: quota },
      scores: { version: 1 as const, fetchedAt: iso(now), indexVersion: "fixture",
        models: models.map(model => ({ model, effort: "high" as const, aaSlug: model,
          intelligence: model === "gpt-6.1-sol" ? 80 : 70, coding: model === "gpt-6.1-sol" ? 80 : 70, inputPrice: 1, outputPrice: 1 })), unmapped: [] },
      analytics: { fetchedAt: iso(now), sourceFetchedAt: iso(now), endExclusive: iso(now),
        models: Object.fromEntries(models.map(model => [model, stats])) } };
    const result = routing.reviewPair({ authorProvider: "codex", allowQuotaException: true }, data);
    assert.equal(result.status, "complete"); assert.equal(result.quotaException, true);
    const stored = JSON.parse(String(db.prepare("SELECT value FROM history WHERE role=?").get("builder:high")!.value));
    assert.deepEqual(stored.allocations["gpt-6-astra"], { calls: 22, trials: 2 });
    routing.close(); db.close();
  } finally { d.remove(); }
});
test("route CLI errors are typed and bounded without the global usage banner", () => {
  const d = routeScratch();
  try {
    const cli = (args: string[]) => spawnSync(process.execPath, [resolve("bin/chaldea"), "route", ...args],
      { encoding: "utf8", env: { ...process.env, HOME: d.path } });
    const usage = cli(["--role", "bad"]);
    assert.equal(usage.status, 2); assert.equal(JSON.parse(usage.stderr).error.code, "usage");
    const invalid = join(d.path, "invalid.json"); writeFileSync(invalid, "{broken");
    const config = cli(["--role", "builder", "--config", invalid]);
    assert.equal(config.status, 3); assert.equal(JSON.parse(config.stderr).error.code, "config");
    const fixture = join(d.path, "fixture.json"); writeFileSync(fixture, JSON.stringify({ ...base, catalog: [] }));
    const none = cli(["--role", "builder", "--fixture", fixture]);
    assert.equal(none.status, 6); assert.equal(JSON.parse(none.stderr).error.code, "no_candidate");
    for (const reply of [usage, config, none]) assert.doesNotMatch(reply.stderr, /chaldea quota|chaldea exec/);
    writeFileSync(fixture, JSON.stringify(base));
    const pair = cli(["review-pair", "--author-provider", "codex", "--fixture", fixture]);
    assert.equal(pair.status, 0, pair.stderr); assert.equal(JSON.parse(pair.stdout).status, "complete");
    const full = cli(["--role", "builder", "--fixture", fixture, "--explain"]);
    assert.equal(full.status, 0); assert.ok(JSON.parse(full.stdout).byProvider.codex.reasons.length);
  } finally { d.remove(); }
});
