import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { collectRouteContext, route } from "../../src/route/runtime.ts";
import { headroomConfig, loadHeadroomConfig } from "../../src/quota/codex-balance.ts";
import { capacitySnapshot, readSnapshotsDetailed } from "../../src/quota/fleet.ts";
import { newProvider, STALE_AFTER_MS } from "../../src/quota/headroom.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { writeJson } from "../../src/route/cache.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const accountKey = "a".repeat(64);
function provider(alias: string, remaining: number) {
  const p = newProvider(alias, "codex");
  p.accountKey = accountKey;
  p.included = { state: "fresh", source: "fixture", error: null, observedAt: iso(now), value: [
    { id: "seven_day", kind: "weekly", usedPercent: 100 - remaining, remainingPercent: remaining,
      resetsAt: iso(now + 86400000), windowDurationMins: 10080 }] };
  return p;
}
function fixture() {
  const d = routeScratch(), state = emptyState();
  const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
  const quotaConfigFile = join(d.path, "quota.json"), cacheDir = join(d.path, "cache");
  writeJson(quotaConfigFile, {});
  writeJson(configPath, { stateFile, quotaConfigFile, cacheDir,
    scores: { enabled: false }, claudeUsage: { enabled: false } });
  return { ...d, state, quotaConfigFile, stateFile,
    save: () => saveState(stateFile, state, now),
    options: { home: d.path, configPath, now,
      catalog: async () => catalog,
      fetcher: (async () => { throw new Error("fixture offline"); }) as typeof fetch } };
}
test("runtime reconciles same-host aliases at 80 vs 0 before every capacity classification", async () => {
  const f = fixture();
  try {
    const generous = provider("codex", 80), exhausted = provider("codex-work", 0);
    const localCatalog = catalog.filter(p => ["codex", "codex-work", "claudeAgent"].includes(p.providerInstanceId))
      .map(p => p.driverKind === "codex" ? { ...p, accountKey, canRunChildTask: true } : p);
    for (const rows of [[generous, exhausted], [exhausted, generous]]) {
      f.options.catalog = async () => rows[0] === generous ? localCatalog : localCatalog.toReversed();
      f.state.headroom.providers = rows; f.save();
      const context = await collectRouteContext(f.options);
      for (const alias of ["codex", "codex-work"]) {
        assert.equal(context.data.quota[alias]!.windows[0]!.remainingPercent, 0);
        assert.equal(context.data.capacity![alias]!.class, "tight");
        assert.match(context.provenance[alias]!.conflicts.join(" "), /utilization conflict/);
      }
      const result = await route({ role: "builder" }, f.options);
      assert.equal(result.providerInstanceId, "claudeAgent");
      assert.ok(result.alternatives.every(p => !["codex", "codex-work"].includes(p.providerInstanceId)));
    }
    const shifted = structuredClone(exhausted);
    shifted.included = { ...shifted.included,
      value: shifted.included.value!.map(w => ({ ...w, resetsAt: iso(now + 2 * 86400000) })) };
    f.state.headroom.providers = [generous, shifted]; f.save();
    const uncertain = await collectRouteContext(f.options);
    for (const alias of ["codex", "codex-work"]) {
      assert.deepEqual(uncertain.data.quota[alias]!.windows, []);
      assert.equal(uncertain.data.quota[alias]!.incomplete, true);
      assert.equal(uncertain.data.capacity![alias]!.class, "unknown");
      assert.match(uncertain.provenance[alias]!.conflicts.join(" "), /reset epoch/);
    }
  } finally { f.remove(); }
});
test("equal-time remote short-window conflict retains matching fresh local funded admission", async () => {
  const f = fixture();
  try {
    const local = provider("codex", 80);
    local.included = { ...local.included, value: [...local.included.value!,
      { id: "five_hour", kind: "session", usedPercent: 20, remainingPercent: 80,
        resetsAt: iso(now + 3600000), windowDurationMins: 300 }] };
    local.credits = { ...local.included, value: { balance: "25", hasCredits: true, unlimited: false } };
    local.spendControlReached = { ...local.included, value: false };
    local.ordinaryUsageAllowed = { ...local.included, value: false };
    f.state.headroom.providers = [local];
    f.options.catalog = async () => catalog.filter(p => p.providerInstanceId === "codex").map(p => ({ ...p, accountKey }));
    const helper = join(f.path, "token-helper");
    writeFileSync(helper, "#!/bin/sh\nprintf 'fixture.token.signature\\n'\n", { mode: 0o700 });
    for (const host of ["a-remote", "z-remote"]) {
      writeJson(f.quotaConfigFile, { fleet: { enabled: true, url: "https://fixture.invalid",
        tokenHelper: helper, host: "local", cacheFile: join(f.path, "fleet.json") } });
      const remote = capacitySnapshot(host, [local], new Set(), now);
      remote.accounts[0]!.windows = remote.accounts[0]!.windows.map(w => w.id === "five_hour"
        ? { ...w, usedPercent: 100, remainingPercent: 0 } : w);
      f.options.fetcher = async () => Response.json({ next_cursor: null, events: [
        { source: "quota", kind: "quota_headroom_snapshot", host,
          provenance: { type: "verified" }, data: { capacity: remote } }] });
      f.save();
      const context = await collectRouteContext(f.options);
      assert.equal(context.fleet.readiness, "ready");
      assert.equal(context.data.quota.codex!.windows.find(w => w.id === "five_hour")!.remainingPercent, 0);
      assert.equal(context.data.capacity!.codex!.creditFunded, true);
      assert.equal(context.data.capacity!.codex!.class, "unlimited");
      assert.match(context.provenance.codex!.conflicts.join(" "), /five_hour: utilization conflict/);
      assert.equal((await route({ role: "builder" }, f.options)).providerInstanceId, "codex");

      for (const variant of ["missing credits", "stale credits", "different credits", "spend reached", "stale spend",
        "wrong account", "active stop"] as const) {
        f.state.parked.clear();
        const changed = structuredClone(local);
        if (variant === "wrong account") changed.accountKey = "b".repeat(64);
        if (variant === "active stop") f.state.parked.set("thread", {
          runId: "run", provider: "codex", resetAt: null, stopAt: now, seenAt: now });
        if (variant === "missing credits") changed.credits = newProvider("codex", "codex").credits;
        if (variant === "stale credits") changed.credits = { ...changed.credits, observedAt: iso(now - STALE_AFTER_MS) };
        if (variant === "different credits") changed.credits = { ...changed.credits,
          value: { balance: "5", hasCredits: true, unlimited: false } };
        if (variant === "spend reached") changed.spendControlReached = { ...changed.spendControlReached, value: true };
        if (variant === "stale spend") changed.spendControlReached = { ...changed.spendControlReached, observedAt: iso(now - STALE_AFTER_MS) };
        f.state.headroom.providers = [changed]; f.save();
        const denied = await collectRouteContext(f.options);
        assert.notEqual(denied.data.capacity!.codex!.creditFunded, true, variant);
        assert.equal(denied.data.capacity!.codex!.class, "stopped", variant);
        await assert.rejects(route({ role: "builder" }, f.options), { code: "no_candidate" }, variant);
      }
      f.state.parked.clear();
      f.state.headroom.providers = [local];
    }
  } finally { f.remove(); }
});
test("configuration producer preserves absent versus explicit disabled fleet readiness", async () => {
  const f = fixture();
  try {
    assert.equal(headroomConfig().fleet, undefined);
    assert.equal(loadHeadroomConfig(f.path).fleet, undefined, "missing default quota file");
    f.save();
    for (const [config, expected] of [
      [{}, "absent"], [{ fleet: {} }, "disabled"], [{ fleet: { enabled: false } }, "disabled"], [{ fleet: null }, "disabled"],
    ] as const) {
      writeJson(f.quotaConfigFile, config);
      const reporting = loadHeadroomConfig(f.path, f.quotaConfigFile);
      assert.equal((await readSnapshotsDetailed(reporting.fleet, now)).readiness, expected);
      assert.equal((await collectRouteContext(f.options)).fleet.readiness, expected);
      assert.equal((await route({ role: "builder" }, f.options)).diagnostics!.fleet!.readiness, expected);
    }
    writeJson(f.quotaConfigFile, { fleet: { enabled: true } });
    assert.throws(() => loadHeadroomConfig(f.path, f.quotaConfigFile));
  } finally { f.remove(); }
});
