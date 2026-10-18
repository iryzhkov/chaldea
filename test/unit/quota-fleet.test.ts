import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { accountKey, capacityKey } from "../../src/quota/account.ts";
import { capacitySnapshot, mergeSnapshots, snapshotProvider, validateSnapshot, fleetConfig, publishSnapshot, readSnapshots, FLEET_BUCKET_MS } from "../../src/quota/fleet.ts";
import { newProvider, emptyHeadroom, HeadroomMonitor } from "../../src/quota/headroom.ts";
import { headroomConfig } from "../../src/quota/codex-balance.ts";
import { classifyCapacity, classifyCapacities } from "../../src/quota/capacity.ts";
import { collectClaudeUsage, CLAUDE_CADENCE_MS } from "../../src/route/claude-usage.ts";
import { normalize } from "../../src/akasha/schema.ts";
import { scopeSql } from "../../src/akasha/store.ts";
import { recommend } from "../../src/route/policy.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { route } from "../../src/route/runtime.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { writeJson } from "../../src/route/cache.ts";

const metric = <T>(value: T, at = now) => ({ value, state: "fresh" as const, error: null, observedAt: iso(at), source: "fixture" });
function row(provider: string, login: number, at = now) {
  const p = newProvider(provider + login, provider); p.accountKey = accountKey(provider + "-login-" + login)!;
  p.included = metric([{ id: "weekly", kind: "weekly", usedPercent: 80, remainingPercent: 20,
    windowDurationMins: 10080, resetsAt: iso(now + 6 * 86400000) }], at);
  p.credits = metric({ balance: "0.001", hasCredits: true, unlimited: false }, at);
  return p;
}
test("three hosts, two accounts per provider: newest account wins, stale and future observations ignored", () => {
  const providers = ["codex", "claudeAgent"].flatMap(p => [row(p, 1), row(p, 2)]);
  const snapshots = ["agent-a", "agent-b", "laptop"].map((host, i) => {
    const ps = providers.map(p => ({ ...p, included: metric(p.included.value!, now - (2 - i) * 60000),
      credits: metric(p.credits.value!, now - (2 - i) * 60000) }));
    return capacitySnapshot(host, ps, new Set(), now);
  });
  const merged = mergeSnapshots(snapshots, now);
  assert.equal(merged.size, 4);
  assert.ok([...merged.values()].every(a => a.host === "laptop" && a.ageSeconds === 0));
  const newer = structuredClone(snapshots[2]!); newer.accounts.pop();
  const mixed = mergeSnapshots([snapshots[0]!, newer], now);
  assert.equal([...mixed.values()].filter(a => a.host === "agent-a").length, 1);
  assert.equal(mergeSnapshots(snapshots, now + 15 * 60000).size, 0);
  assert.equal(mergeSnapshots(snapshots, now - 1).size, 0);
  const ownBound = structuredClone(snapshots[0]!); ownBound.accounts[0]!.maxAgeMs = 60000;
  assert.equal(mergeSnapshots([ownBound], now).size, 3);
  const disk = JSON.stringify(snapshots);
  assert.doesNotMatch(disk, /login-|credential|token|home|email|alias/i);
  assert.throws(() => validateSnapshot({ ...snapshots[0], credentials: "secret" }));
  const injected = structuredClone(snapshots[0]!); (injected.accounts[0] as any).accessToken = "secret";
  assert.throws(() => validateSnapshot(injected));
});
test("status keys capacity by provider/account, deduplicates aliases and preserves stops", () => {
  const old = { ...row("codex", 1, now - 60000), alias: "old" }, fresh = { ...row("codex", 1), alias: "current" };
  old.credits = metric({ balance: "0", hasCredits: false, unlimited: false }, now - 60000);
  const state = emptyState(); state.headroom.providers.push(fresh, old);
  let capacities = classifyCapacities(state, now);
  assert.deepEqual(Object.keys(capacities), [capacityKey("codex", fresh.accountKey!)]);
  assert.equal(Object.values(capacities)[0]!.class, "unlimited");
  state.parked.set("stop", { provider: "old", resetAt: iso(now + 60000) } as any);
  capacities = classifyCapacities(state, now);
  assert.equal(Object.keys(capacities).length, 1);
  assert.equal(Object.values(capacities)[0]!.class, "stopped");
});
test("shared publisher reserves one combined record per bucket across restarts, failures and concurrent callers", async () => {
  const d = routeScratch();
  try {
    const config = fleetConfig({ enabled: true, url: "https://akasha.invalid", tokenHelper: "/fixture/helper",
      host: "agent-a", cacheFile: join(d.path, "publish.json") }, d.path);
    let posts = 0;
    const keys = new Set<string>();
    const options = { token: async () => "fixture-bearer", fetch: (async (_url, init) => {
      posts++; const headers = new Headers(init!.headers); keys.add(headers.get("Idempotency-Key")!);
      assert.equal(init!.method, "POST"); assert.equal(init!.redirect, "error");
      const event = JSON.parse(init!.body as string);
      assert.equal(event.data.capacity.accounts.length, 4);
      assert.doesNotMatch(init!.body as string, /fixture-bearer|login-|credential|token|home|email/i);
      return Response.json({ state: "visible", event_id: "a".repeat(64) }, { status: 201 });
    }) as typeof fetch };
    const hour = Math.floor(now / 3600000) * 3600000;
    for (let minute = 0; minute < 60; minute++) {
      const at = hour + minute * 60000;
      const ps = ["codex", "claudeAgent"].flatMap(p => [row(p, 1, at), row(p, 2, at)]);
      const s = capacitySnapshot(config.host, ps, new Set(), at);
      await Promise.all(Array.from({ length: 3 }, () => publishSnapshot(config, s, at, options)));
    }
    assert.equal(posts, 4); assert.equal(keys.size, 4);
    assert.equal(statSync(config.cacheFile).mode & 0o777, 0o600);
    const failedConfig = { ...config, cacheFile: join(d.path, "failed.json") };
    let failures = 0;
    const failing = { ...options, fetch: (async () => { failures++; throw new Error("secret"); }) as typeof fetch };
    const s = capacitySnapshot(config.host, [row("codex", 1)], new Set(), now);
    await publishSnapshot(failedConfig, s, now, failing);
    await publishSnapshot(failedConfig, s, now + 1, failing);
    assert.equal(failures, 1);
    await publishSnapshot({ ...config, enabled: false }, s, now + FLEET_BUCKET_MS, options);
    assert.equal(posts, 4);
  } finally { d.remove(); }
});
test("Claude on any host GETs usage and profile, hashes org ID, never writes or logs credentials", async () => {
  const d = routeScratch();
  try {
    const credentialFile = join(d.path, "credential.json"), cacheFile = join(d.path, "cache.json");
    const credential = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-secret", refreshToken: "fixture-refresh", expiresAt: now + 86400000 } });
    writeFileSync(credentialFile, credential, { mode: 0o600 }); const before = statSync(credentialFile).mtimeMs;
    let calls = 0;
    const fetcher: typeof fetch = async (url, init) => {
      calls++; assert.equal(init!.method, "GET"); assert.equal(init!.redirect, "error");
      return Response.json(String(url).endsWith("/profile") ? { organization: { uuid: "fixture-org" }, email: "private@example.invalid" } :
        { five_hour: { utilization: 10, resets_at: iso(now + 3600000) }, seven_day: { utilization: 80, resets_at: iso(now + 86400000) } });
    };
    const o = { enabled: true, credentialFile, cacheFile, now, fetcher };
    const result = await collectClaudeUsage(o);
    assert.equal(result.value?.accountKey, accountKey("fixture-org")); assert.equal(calls, 2);
    await collectClaudeUsage({ ...o, now: now + CLAUDE_CADENCE_MS - 1 }); assert.equal(calls, 2);
    assert.equal(readFileSync(credentialFile, "utf8"), credential); assert.equal(statSync(credentialFile).mtimeMs, before);
    assert.doesNotMatch(readFileSync(cacheFile, "utf8"), /fixture-secret|fixture-refresh|fixture-org|private@/);
    const state = emptyHeadroom();
    const monitor = new HeadroomMonitor({ state, local: true, now: () => now, save() {},
      config: headroomConfig({ claudeContexts: [{ enabled: true, credentialFile, providerInstanceId: "claude2" }] }),
      claudeRead: async () => result });
    try { monitor.update([]); await monitor.tick(); assert.equal(state.providers[0]?.accountKey, accountKey("fixture-org")); }
    finally { await monitor.close(); }
  } finally { d.remove(); }
});
test("Codex credits, even a tiny balance and exhausted quota, are unlimited without conversion or reserve; expiring is use-it", () => {
  const p = row("codex", 1); p.included = metric(p.included.value!.map(w => ({ ...w, remainingPercent: 0, usedPercent: 100 })));
  assert.equal(classifyCapacity(p, false, now).class, "unlimited");
  assert.equal(classifyCapacity(p, false, now).burnTargetPerHour, null);
  p.creditExpiresAt = iso(now + 3600000);
  const capacity = classifyCapacity(p, false, now);
  assert.equal(capacity.class, "use-it"); assert.match(capacity.reasons.join(" "), /no credit reserve floor/);
  const r = recommend({ role: "builder" }, { catalog, quota: { codex: { observedAt: iso(now), windows: p.included.value!, activeStop: false } },
    capacity: { codex: capacity }, now, analytics: null });
  assert.equal(r.providerInstanceId, "codex");
  assert.equal(classifyCapacity(p, true, now).class, "stopped");
  p.creditExpiresAt = iso(now - 1); assert.equal(classifyCapacity(p, false, now).class, "tight");
});
test("Akasha snapshot schema rejects credentials and host spoofing; fleet reads stay quota-only and receipts stay owned", () => {
  const identity = { issuer: "chaldea:agent-a", profile: "quota-service", project: "chaldea", source: "quota", host: "agent-a", run_id: "run", source_id: "quota-agent-a" };
  const s = capacitySnapshot("agent-a", [row("codex", 1)], new Set(), now);
  normalize({ v: 1, kind: "quota_headroom_snapshot", title: "Quota", data: { capacity: s } }, identity, false);
  assert.throws(() => normalize({ v: 1, kind: "quota_headroom_snapshot", title: "Quota", data: { capacity: { ...s, host: "laptop" } } }, identity, false), /snapshot_host_mismatch/);
  const scope = { ...identity, global: false, quotaFleet: true };
  const q = scopeSql(scope);
  assert.deepEqual(q.params, ["quota-service", "chaldea", "quota", "quota_headroom_snapshot"]);
  assert.doesNotMatch(q.sql, /issuer|host/);
  assert.match(scopeSql({ ...scope, quotaFleet: false }).sql, /issuer/);
});
test("four local T3 instances select the matching shared account and reject a conflicting live login", async () => {
  const d = routeScratch();
  try {
    const stateFile = join(d.path, "state.json"), quotaConfigFile = join(d.path, "quota.json"), configPath = join(d.path, "route.json");
    saveState(stateFile, emptyState(), now);
    const cacheDir = join(d.path, "cache");
    writeJson(join(cacheDir, "slopalytics.json"), { attemptedAt: now, fetchedAt: iso(now), value: null });
    const helper = join(d.path, "token-helper");
    writeFileSync(helper, "#!/bin/sh\nprintf 'fixture.token.signature\\n'\n", { mode: 0o700 });
    const aliases = ["codex", "codex-work", "claudeAgent", "claude-work"];
    const ps = ["codex", "claudeAgent"].flatMap(driver => [row(driver, 1), row(driver, 2)]);
    ps[1]!.creditExpiresAt = iso(now + 3600000);
    const snapshots = ["agent-a", "agent-b", "laptop"].map((host, i) => capacitySnapshot(host,
      ps.map(p => ({ ...p, included: metric(p.included.value!, now - (2 - i) * 60000),
        credits: metric(p.credits.value!, now - (2 - i) * 60000) })), new Set(), now));
    writeJson(quotaConfigFile, {
      contexts: [0, 1].map(i => ({ providers: [aliases[i]], home: d.path, codexHome: join(d.path, "codex" + i), accountKey: ps[i]!.accountKey })),
      claudeContexts: [2, 3].map(i => ({ providerInstanceId: aliases[i], credentialFile: join(d.path, "missing" + i), enabled: false, accountKey: ps[i]!.accountKey })),
      fleet: { enabled: true, url: "https://akasha.invalid", tokenHelper: helper, host: "agent-a", cacheFile: join(d.path, "publisher.json") },
    });
    writeJson(configPath, { stateFile, quotaConfigFile, cacheDir });
    const localCatalog = catalog.filter(p => aliases.includes(p.providerInstanceId)).map(p => ({ ...p, canRunChildTask: true }));
    const fetcher: typeof fetch = async () => Response.json({ events: snapshots.map(s => ({ source: "quota", host: s.host,
      kind: "quota_headroom_snapshot", provenance: { type: "verified" }, data: { capacity: s } })), next_cursor: null });
    const r = await route({ role: "builder" }, { home: d.path, configPath, now, catalog: async () => localCatalog, fetcher });
    assert.equal(r.providerInstanceId, "codex-work"); assert.equal(r.accountKey, ps[1]!.accountKey);
    assert.equal(r.alternatives.length, 3);
    assert.equal(new Set([r, ...r.alternatives].map(p => p.accountKey)).size, 4);
    assert.ok(r.reasons.some(s => s.includes("observed on laptop; age 0s")));
    assert.equal(r.dataAges.quota["codex-work"], 0);
    const conflict = await route({ role: "builder" }, { home: d.path, configPath, now,
      catalog: async () => localCatalog.map(p => p.providerInstanceId === "codex-work" ? { ...p, accountKey: ps[0]!.accountKey! } : p), fetcher });
    assert.notEqual(conflict.providerInstanceId, "codex-work");
    assert.match(conflict.reasons.join(" "), /does not match the observed provider login/);
    const mismatched = newProvider("claude-work", "claudeAgent");
    mismatched.included = { ...mismatched.included, state: "error", error: "context_mismatch" };
    const observed = emptyState(); observed.headroom.providers.push(mismatched);
    saveState(stateFile, observed, now);
    const observerMismatch = await route({ role: "critical-review", authorProvider: "codex" }, {
      home: d.path, configPath, now, catalog: async () => localCatalog, fetcher });
    assert.equal(observerMismatch.providerInstanceId, "claudeAgent");
    assert.ok(observerMismatch.alternatives.every(p => p.providerInstanceId !== "claude-work"));
    saveState(stateFile, emptyState(), now);
    const credentialFile = join(d.path, "claude-credential.json");
    writeJson(credentialFile, { claudeAiOauth: { accessToken: "fixture-token", expiresAt: now + 86400000 } });
    writeJson(configPath, { stateFile, quotaConfigFile, cacheDir,
      claudeUsage: { enabled: true, providerInstanceId: "claude-work", credentialFile } });
    const liveMismatch = await route({ role: "critical-review", authorProvider: "codex" }, {
      home: d.path, configPath, now, catalog: async () => localCatalog,
      fetcher: async (url, init) => String(url).includes("api.anthropic.com") ? Response.json({
        organization_id: "claudeAgent-login-1",
        five_hour: { utilization: 100, resets_at: iso(now + 3600000) },
        seven_day: { utilization: 100, resets_at: iso(now + 86400000) },
      }) : fetcher(url, init) });
    assert.equal(liveMismatch.providerInstanceId, "claudeAgent");
    assert.ok(liveMismatch.alternatives.every(p => p.providerInstanceId !== "claude-work"));
    writeJson(configPath, { stateFile, quotaConfigFile, cacheDir });
    const offline = await route({ role: "builder" }, { home: d.path, configPath, now, catalog: async () => localCatalog,
      fetcher: async () => { throw new Error("offline"); } });
    assert.equal(offline.providerInstanceId, "claude-work");
    const stale = await route({ role: "builder" }, { home: d.path, configPath, now: now + 15 * 60000,
      catalog: async () => localCatalog, fetcher });
    assert.equal(stale.providerInstanceId, "claude-work");
  } finally { d.remove(); }
});

test("route matches remote accounts to local instances, exposes account and age, falls back locally on shared outage or staleness", async () => {
  const d = routeScratch();
  try {
    const state = emptyState(), local = { ...row("codex", 1, now - 60000), alias: "codex" }; state.headroom.providers.push(local);
    const stateFile = join(d.path, "state.json"); saveState(stateFile, state, now);
    const quotaConfigFile = join(d.path, "quota.json");
    writeJson(quotaConfigFile, { contexts: [{ home: d.path, codexHome: d.path, providers: ["codex"], accountKey: local.accountKey }],
      fleet: { enabled: true, url: "https://akasha.invalid", tokenHelper: "/missing-helper", host: "agent-a", cacheFile: join(d.path, "publish.json") } });
    const cacheDir = join(d.path, "cache");
    writeJson(join(cacheDir, "slopalytics.json"), { attemptedAt: now, fetchedAt: iso(now), value: null });
    const configPath = join(d.path, "route.json"); writeJson(configPath, { stateFile, quotaConfigFile, cacheDir });
    const r = await route({ role: "builder" }, { home: d.path, configPath, now, catalog: async () => catalog });
    assert.equal(r.providerInstanceId, "codex"); assert.equal(r.accountKey, local.accountKey);
    assert.equal(r.dataAges.quota.codex, 60); assert.match(r.reasons.join(" "), /observed on agent-a/);
    const shared = capacitySnapshot("laptop", [row("codex", 1)], new Set(), now);
    const config = fleetConfig({ enabled: true, url: "https://akasha.invalid", tokenHelper: "/fixture", host: "agent-a", cacheFile: join(d.path, "shared.json") }, d.path);
    let reads = 0;
    const snapshots = await readSnapshots(config, now, (async (url, init) => {
      reads++; assert.equal(new URL(String(url)).searchParams.get("kind"), "quota_headroom_snapshot");
      assert.equal(init!.method, "GET"); assert.equal(new Headers(init!.headers).get("authorization"), "Bearer fixture-token");
      return Response.json({ events: [{ source: "quota", kind: "quota_headroom_snapshot", host: "laptop", provenance: { type: "verified" }, data: { capacity: shared } }], next_cursor: null });
    }) as typeof fetch, async (_helper, _event, action) => { assert.equal(action, "read"); return "fixture-token"; });
    assert.equal(reads, 1); const merged = mergeSnapshots([capacitySnapshot("agent-a", [local], new Set(), now), ...snapshots], now);
    const a = merged.get(capacityKey("codex", local.accountKey!))!;
    assert.equal(a.host, "laptop"); assert.equal(snapshotProvider(a, "codex").accountKey, local.accountKey);
    assert.equal(mergeSnapshots(snapshots, now + 15 * 60000).size, 0);
  } finally { d.remove(); }
});
