import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { HeadroomMonitor, emptyHeadroom, STALE_AFTER_MS } from "../../src/quota/headroom.ts";
import { headroomConfig } from "../../src/quota/codex-balance.ts";
import { capacitySnapshot } from "../../src/quota/fleet.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { route } from "../../src/route/runtime.ts";
import type { SwitchProvider } from "../../src/t3/adapter.ts";
import type { collectClaudeUsage } from "../../src/route/claude-usage.ts";
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

test("native Claude binding reaches account snapshot and route with HTTP collection disabled", async () => {
  const d = routeScratch(), m = monitor();
  try {
    m.update([provider()]); await m.tick();
    const row = m.state.providers[0]!;
    assert.equal(row.accountKey, account);
    assert.equal(row.included.source, "t3");
    assert.equal(row.included.error, null);
    const snapshot = capacitySnapshot("fixture-host", m.state.providers, new Set(), now);
    assert.equal(snapshot.accounts[0]?.accountKey, account);
    assert.equal(snapshot.accounts[0]?.windows.find(w => w.kind === "weekly")?.usedPercent, 69);
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
    assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), now).accounts.length, 0);
  } finally { await m.close(); }
});

test("unbound native observations remain unshared and stale native windows retain their age", async () => {
  const m = monitor();
  try {
    m.update([provider(null), { ...provider(other), instanceId: "claude-other" }]); await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, undefined);
    assert.equal(m.state.providers[1]?.accountKey, other);
    assert.deepEqual(capacitySnapshot("fixture-host", m.state.providers, new Set(), now).accounts.map(a => a.accountKey), [other]);
    m.update([{ ...provider(), usageLimits: { ...provider().usageLimits!, checkedAt: iso(now - STALE_AFTER_MS) } }]);
    await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, account);
    assert.equal(m.state.providers[0]?.included.observedAt, iso(now - STALE_AFTER_MS));
    assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), now).accounts.length, 0);
  } finally { await m.close(); }
});

test("native quota is authoritative and HTTP fallback cannot relabel another account", async () => {
  let clock = now, calls = 0;
  let reply: Awaited<ReturnType<typeof collectClaudeUsage>> = { value: { accountKey: other, observedAt: iso(now),
    windows: [{ kind: "weekly", remainingPercent: 80, windowDurationMins: 10080, resetsAt: iso(now + 4 * 86400000) }] },
    fetchedAt: iso(now), reason: null };
  const m = new HeadroomMonitor({ state: emptyHeadroom(), local: true, now: () => clock, save() {},
    config: headroomConfig({ claudeContexts: [{ enabled: true, providerInstanceId: alias, credentialFile: "/unused" }] }),
    claudeRead: async () => { calls++; return reply; } });
  const row = () => m.state.providers[0]!;
  const unavailable = () => ({ ...provider(), usageLimits: { checkedAt: iso(clock), windows: [], unavailable: { reason: "unsupported" } } });
  try {
    m.update([provider()]); await m.tick();
    assert.equal(row().accountKey, account, "HTTP credentials must not replace the native account binding");
    assert.equal(calls, 0, "fresh native quota must not launch a redundant HTTP read");
    assert.equal(row().included.source, "t3"); assert.equal(row().included.error, null);
    m.update([unavailable()]); await m.tick();
    assert.equal(row().included.error, "context_mismatch"); assert.equal(row().included.value, null);
    assert.ok(capacitySnapshot("fixture-host", m.state.providers, new Set(), clock).accounts.every(a => a.accountKey !== other));
    reply = { value: null, fetchedAt: null, reason: "rate_limited; no successful cache" };
    m.update([provider()]); await m.tick();
    clock += STALE_AFTER_MS;
    m.update([provider()]); await m.tick();
    assert.equal(row().included.source, "t3"); assert.equal(row().included.error, null);
    assert.equal(row().included.observedAt, iso(now), "HTTP failure cannot relabel or rejuvenate native windows");
    reply = { ...reply, reason: null, fetchedAt: iso(clock), value: {
      accountKey: account, observedAt: iso(clock), windows: [{ kind: "weekly", remainingPercent: 80,
        windowDurationMins: 10080, resetsAt: iso(clock + 4 * 86400000) }] } };
    m.update([unavailable()]); await m.tick();
    assert.equal(row().accountKey, account); assert.equal(row().included.source, "claude-usage");
    assert.equal(row().included.observedAt, iso(clock)); assert.equal(row().included.error, null);
    m.update([{ ...provider(null), usageLimits: unavailable().usageLimits }]); await m.tick();
    assert.equal(row().manualResets.value, null, "native reset inventory cannot outlive its binding");
  } finally { await m.close(); }
});

test("configured Claude binding rejects a different native account before HTTP or publication", async () => {
  const m = new HeadroomMonitor({ state: emptyHeadroom(), local: true, now: () => now, save() {},
    config: headroomConfig({ claudeContexts: [{ enabled: true, providerInstanceId: alias,
      accountKey: other, credentialFile: "/unused" }] }),
    claudeRead: async () => { throw new Error("binding mismatch must not read credentials"); } });
  try {
    m.update([provider()]);
    assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), now).accounts.length, 0);
    await m.tick();
    assert.equal(m.state.providers[0]?.included.error, "context_mismatch");
    assert.equal(m.state.providers[0]?.accountKey, undefined);
    assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), now).accounts.length, 0);
  } finally { await m.close(); }
});

test("a native refresh during a pending HTTP read keeps the current account authoritative", async () => {
  let finish!: (value: Awaited<ReturnType<typeof collectClaudeUsage>>) => void;
  const pending = new Promise<Awaited<ReturnType<typeof collectClaudeUsage>>>(resolve => { finish = resolve; });
  const m = new HeadroomMonitor({ state: emptyHeadroom(), local: true, now: () => now, save() {},
    config: headroomConfig({ claudeContexts: [{ enabled: true, providerInstanceId: alias, credentialFile: "/unused" }] }),
    claudeRead: async () => pending });
  try {
    m.update([{ ...provider(), usageLimits: { checkedAt: iso(now), windows: [], unavailable: { reason: "unsupported" } } }]);
    m.update([provider(other)]);
    finish({ value: { accountKey: account, observedAt: iso(now), windows: [] }, fetchedAt: iso(now), reason: null });
    await m.tick();
    assert.equal(m.state.providers[0]?.accountKey, other);
    assert.equal(m.state.providers[0]?.included.source, "t3");
    assert.equal(m.state.providers[0]?.included.error, null);
  } finally { await m.close(); }
});

for (const configured of [false, true]) test(`unbound native updates never inherit HTTP identity, configured=${configured}`, async () => {
  let clock = now;
  const http = { accountKey: other, observedAt: iso(now - 1000), windows: [
    { kind: "weekly" as const, remainingPercent: 80, windowDurationMins: 10080, resetsAt: iso(now + 4 * 86400000) }] };
  let reply: Awaited<ReturnType<typeof collectClaudeUsage>> = { value: http, fetchedAt: http.observedAt, reason: null };
  const m = new HeadroomMonitor({ state: emptyHeadroom(), local: true, now: () => clock, save() {},
    config: headroomConfig({ claudeContexts: [{ enabled: true, providerInstanceId: alias,
      credentialFile: "/unused", ...(configured ? { accountKey: other } : {}) }] }),
    claudeRead: async () => reply });
  const row = () => m.state.providers[0]!;
  const native = () => ({ ...provider(null), usageLimits: { ...provider().usageLimits!, checkedAt: iso(clock) } });
  try {
    m.update([{ ...provider(null), usageLimits: { checkedAt: iso(clock), windows: [], unavailable: { reason: "unsupported" } } }]);
    await m.tick();
    assert.equal(row().accountKey, other); assert.equal(row().included.source, "claude-usage");
    reply = { value: null, fetchedAt: null, reason: "rate_limited; no successful cache" };
    clock++;
    m.update([native()]);
    assert.equal(row().accountKey, undefined, "unbound native data must lose the prior HTTP key before async collection");
    assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), clock).accounts.length, 0);
    await m.tick();
    assert.equal(row().included.source, "t3"); assert.equal(row().included.observedAt, iso(clock));
    assert.equal(row().included.error, null); assert.equal(row().manualResets.value, null);
    reply = { value: { observedAt: iso(clock), windows: http.windows }, fetchedAt: iso(clock), reason: null };
    await m.tick();
    assert.notEqual(row().included.error, "context_mismatch", "missing HTTP identity is unknown, not a conflicting account");
    assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), clock).accounts.length, 0);
    reply = { value: http, fetchedAt: http.observedAt, reason: null };
    for (let repeat = 0; repeat < 2; repeat++) {
      clock++; m.update([native()]);
      assert.equal(capacitySnapshot("fixture-host", m.state.providers, new Set(), clock).accounts.length, 0);
      await m.tick();
      assert.equal(row().accountKey, other); assert.equal(row().included.source, "claude-usage");
      assert.equal(row().included.value?.[0]?.usedPercent, 20);
      assert.equal(row().included.observedAt, http.observedAt); assert.equal(row().manualResets.value, null);
    }
  } finally { await m.close(); }
});
