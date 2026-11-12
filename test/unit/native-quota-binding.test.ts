import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { HeadroomMonitor, emptyHeadroom, STALE_AFTER_MS, statusSnapshot, validateHeadroom } from "../../src/quota/headroom.ts";
import { headroomConfig } from "../../src/quota/codex-balance.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { route } from "../../src/route/runtime.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { catalog, now, iso } from "../fixtures/route/catalog.ts";

const account = "a".repeat(64), other = "b".repeat(64), alias = "claude-native";
const provider = (key: string | null = account): SwitchProvider => ({
  instanceId: alias, driver: "claudeAgent", ...(key ? { quotaAccountKey: key } : {}),
  enabled: true, installed: true, status: "ready", auth: { status: "authenticated" }, models: [],
  usageLimits: { checkedAt: iso(now), windows: [
    { id: "five_hour", kind: "session", usedPercent: 6, windowDurationMins: 300, resetsAt: iso(now + 3 * 3600000) },
    { id: "seven_day", kind: "weekly", usedPercent: 69, windowDurationMins: 10080, resetsAt: iso(now + 4 * 86400000) },
  ], resetCredits: { availableCount: 0 } },
});
const monitor = () => new HeadroomMonitor({ state: emptyHeadroom(), config: headroomConfig(),
  local: true, now: () => now, save() {} });

test("native Claude binding reaches route with HTTP collection disabled", async () => {
  const d = routeScratch(), m = monitor();
  try {
    m.update([provider()]); await m.tick();
    const row = m.state.providers[0]!;
    assert.equal(row.accountKey, account);
    assert.equal(row.included.source, "t3");
    assert.equal(row.included.error, null);
    const state = emptyState(); state.headroom = m.state;
    const stateFile = join(d.path, "observer.json"), configPath = join(d.path, "route.json");
    saveState(stateFile, state, now);
    writeFileSync(configPath, JSON.stringify({ stateFile, cacheDir: join(d.path, "cache"),
      claudeUsage: { enabled: false }, scores: { enabled: false } }));
    const nativeCatalog = catalog.map(p => p.driverKind === "claudeAgent" && p.providerInstanceId === "claudeAgent"
      ? { ...p, providerInstanceId: alias, accountKey: account } : p);
    const result = await route({ role: "builder", authorProvider: "codex" }, { home: d.path, configPath, now,
      catalog: async () => nativeCatalog, fetcher: async () => { throw new Error("fixture offline"); } });
    assert.equal(result.providerInstanceId, alias);
    assert.equal(result.dataAges.quota[alias], 0);
    assert.match(result.reasons.join(" "), /weekly 31% left/);
    assert.doesNotMatch(result.reasons.join(" "), /Claude pacing unknown|rate_limited/);
  } finally { await m.close(); d.remove(); }
});

test("native Claude account changes or disappears without inheriting prior account windows", async () => {
  const m = monitor();
  try {
    m.update([provider()]); await m.tick();
    const unavailable = { checkedAt: iso(now), windows: [], unavailable: { reason: "unsupported" } };
    m.update([{ ...provider(other), usageLimits: unavailable }]); await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, other);
    assert.equal(m.state.providers[0]?.included.value, null);
    assert.equal(m.state.providers[0]?.manualResets.value, null);
    m.update([provider(other)]); await m.tick();
    m.update([{ ...provider(null), usageLimits: unavailable }]); await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, undefined);
    assert.equal(m.state.providers[0]?.included.value, null);
  } finally { await m.close(); }
});

test("unbound native observations remain unshared and stale native windows retain their age", async () => {
  const m = monitor();
  try {
    m.update([provider(null), { ...provider(other), instanceId: "claude-other" }]); await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, undefined);
    assert.equal(m.state.providers[1]?.accountKey, other);
    m.update([{ ...provider(), usageLimits: { ...provider().usageLimits!, checkedAt: iso(now - STALE_AFTER_MS) } }]);
    await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, account);
    assert.equal(m.state.providers[0]?.included.observedAt, iso(now - STALE_AFTER_MS));
  } finally { await m.close(); }
});


test("missing native data remains unknown and stale data keeps checkedAt", async () => {
  const m = monitor();
  try {
    const { usageLimits, ...missing } = provider();
    m.update([missing]); await m.tick();
    assert.equal(m.state.providers[0]?.included.state, "unknown");
    assert.equal(m.state.providers[0]?.included.value, null);
    m.update([{ ...provider(), usageLimits: { ...provider().usageLimits!, checkedAt: iso(now - STALE_AFTER_MS) } }]);
    await m.tick();
    const snapshot = statusSnapshot(m.state, now).providers[0]!;
    assert.equal(snapshot.included.windows.state, "stale");
    assert.equal(snapshot.included.windows.checkedAt, iso(now - STALE_AFTER_MS));
    assert.equal(snapshot.included.windows.source, "t3");
  } finally { await m.close(); }
});

test("credential changes clear cached native windows for both drivers", async () => {
  for (const driver of ["codex", "claudeAgent"]) {
    const m = monitor();
    try {
      m.update([{ ...provider(), driver, usageLimits: { ...provider().usageLimits!, credentialFingerprint: "first" } }]);
      await m.tick();
      assert.ok(m.state.providers[0]?.included.value?.length);
      m.update([{ ...provider(), driver, usageLimits: {
        checkedAt: iso(now), windows: [], credentialFingerprint: "second",
        unavailable: { reason: "probeFailed" } } }]);
      await m.tick();
      assert.equal(m.state.providers[0]?.included.value, null);
      assert.equal(m.state.providers[0]?.included.error, "probe_failed");
    } finally { await m.close(); }
  }
});

test("old collector windows and burn samples cannot survive cache migration", async () => {
  const m = monitor();
  try {
    m.update([provider()]); await m.tick();
    const state = JSON.parse(JSON.stringify(m.state));
    state.providers[0].included.source = "retired-collector";
    state.providers[0].burnHistory = [{ observedAt: iso(now), windows: state.providers[0].included.value }];
    const migrated = validateHeadroom(state);
    assert.equal(migrated.providers[0]?.included.value, null);
    assert.equal(migrated.providers[0]?.included.state, "unknown");
    assert.equal(migrated.providers[0]?.burnHistory, undefined);
  } finally { await m.close(); }
});
