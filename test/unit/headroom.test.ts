import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { headroomConfig, loadHeadroomConfig, readCodexBalance, BalanceReadError } from "../../src/quota/codex-balance.ts";
import { applyCodex, applyT3, emptyHeadroom, failCodex, HeadroomMonitor, humanStatus, metricNow,
  newProvider, routingLanes, statusSnapshot, STALE_AFTER_MS, COLLECT_EVERY_MS } from "../../src/quota/headroom.ts";
import { emptyState, loadState, saveState } from "../../src/quota/state.ts";
import { EventSink } from "../../src/quota/run.ts";
import { body, quotaPublication } from "../../src/feed/poster.ts";
import { normalize } from "../../src/akasha/schema.ts";
import { equivalentTarget, hasQuota, switchConfig } from "../../src/quota/routing.ts";
import { toSwitchProvider, type SwitchProvider } from "../../src/t3/adapter.ts";
import type { QuotaRecord } from "../../src/quota/observer.ts";
import { scratchDir } from "../helpers/scratch.ts";

assert.equal(process.env.HOME, process.env.CHALDEA_TRUST_TEST_HOME);
assert.equal(process.env.HOME, process.env.CHALDEA_TEST_SCRATCH + "-home");
assert.notEqual(process.env.HOME, "/home/igor");
const AT = "2026-10-17T17:57:35.000Z", START = Date.parse(AT);
const logger = { info() {}, warn() {}, error() {} };
const response = { accountId: "PRIVATE_ACCOUNT", ordinaryUsageAllowed: false,
  rateLimits: { credits: { balance: "999999", hasCredits: true, unlimited: false } },
  rateLimitsByLimitId: { codex: { planType: "pro", spendControlReached: false,
    credits: { balance: "61951.0098125000", hasCredits: true, unlimited: false } } },
  rateLimitResetCredits: { availableCount: 1, credits: [{ id: "PRIVATE_REDEMPTION_ID" }] } };
const provider = (alias = "codex", runtimeHome = "/scratch/codex"): SwitchProvider => ({
  instanceId: alias, driver: "codex", runtimeHome, enabled: true, installed: true, status: "ready",
  auth: { status: "authenticated", type: "chatgpt" }, models: [], usageLimits: { checkedAt: AT,
    windows: [{ id: "primary", kind: "weekly", usedPercent: 100, windowDurationMins: 10080, resetsAt: "2026-10-21T23:13:21Z" }],
    resetCredits: { availableCount: 1, nextExpiresAt: "2026-11-01T00:00:00Z" } },
});

test("quota config defaults to the observer user's .config/chaldea/quota.json", () => {
  const f = scratchDir("quota-config");
  const previousXdg = process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CONFIG_HOME;
  try {
    assert.deepEqual(loadHeadroomConfig(f.path), headroomConfig({}, f.path));
    const dir = join(f.path, ".config", "chaldea"), path = join(dir, "quota.json");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify({ contexts: [{ providers: ["codex"], home: f.path, codexHome: join(f.path, ".codex") }] }));
    assert.equal(loadHeadroomConfig(f.path).contexts[0]?.codexHome, join(f.path, ".codex"));
    assert.throws(() => loadHeadroomConfig(f.path, join(f.path, "missing.json")));
    writeFileSync(path, "{broken");
    assert.throws(() => loadHeadroomConfig(f.path));
    const explicit = join(f.path, "explicit.json"); writeFileSync(explicit, "{}");
    assert.deepEqual(loadHeadroomConfig(f.path, explicit), headroomConfig({}, f.path));
  } finally {
    if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = previousXdg;
    f.remove();
  }
});

test("legacy fleet quota config is ignored by file and raw loaders", () => {
  const d = scratchDir("legacy-fleet");
  try {
    const raw = { lowHeadroomPercent: 17, contexts: [{ providers: ["codex"], home: d.path, codexHome: join(d.path, ".codex") }] };
    const expected = headroomConfig(raw, d.path);
    const fleet = { enabled: true, endpoint: "https://retired.invalid", tokenHelper: "/must-not-run" };
    assert.deepEqual(headroomConfig({ ...raw, fleet }, d.path), expected);
    for (const name of ["quota.json", "quota-sharing.json", "quota-fleet-reader.json"]) {
      const path = join(d.path, name);
      writeFileSync(path, JSON.stringify({ ...raw, fleet }));
      assert.deepEqual(loadHeadroomConfig(d.path, path), expected);
      writeFileSync(path, JSON.stringify({ ...raw, unknown: true }));
      assert.throws(() => loadHeadroomConfig(d.path, path), /Unknown configuration key/);
    }
    assert.throws(() => headroomConfig({ ...raw, unknown: true }), /unknown quota reporting option/);
  } finally { d.remove(); }
});

test("T3 projection preserves full windows/reset count and drops identity and redemption fields", () => {
  const raw = { ...provider(), auth: { status: "authenticated", email: "PRIVATE_EMAIL", workspaceId: "PRIVATE_WORKSPACE" },
    runtimePaths: { homePath: "/scratch/codex", shadowHomePath: null },
    usageLimits: { ...provider().usageLimits, credentialFingerprint: "PRIVATE_FINGERPRINT",
      resetCredits: { availableCount: 3, nextExpiresAt: "2026-11-01T00:00:00Z", nextCreditId: "PRIVATE_REDEMPTION" } } };
  const p = toSwitchProvider(raw as never);
  assert.equal(p.usageLimits?.resetCredits?.availableCount, 3);
  assert.equal(p.usageLimits?.windows[0]?.windowDurationMins, 10080);
  assert.equal(p.usageLimits?.windows[0]?.resetsAt, "2026-10-21T23:13:21Z");
  assert.ok(!JSON.stringify(p).includes("PRIVATE"));
});
test("exact credit units, zero/null, duplicate map, permissions and independent freshness", () => {
  const row = newProvider("codex", "codex"); applyT3(row, provider()); applyCodex(row, response, AT);
  assert.equal(row.credits.value?.balance, "61951.0098125000");
  assert.equal(row.manualResets.state, "unknown", "app-server reset inventory is ignored");
  assert.equal(row.ordinaryUsageAllowed.value, false);
  const duplicate = newProvider("alias", "codex");
  const wallet = { credits: { balance: "7.000", hasCredits: true, unlimited: false } };
  applyCodex(duplicate, { rateLimitsByLimitId: { a: wallet, b: wallet } }, AT);
  assert.equal(duplicate.credits.value?.balance, "7.000");
  applyCodex(duplicate, { rateLimitsByLimitId: { a: wallet, b: { credits: { ...wallet.credits, balance: "8" } } } }, AT);
  assert.equal(duplicate.credits.value, null);
  applyT3(row, { ...provider(), usageLimits: { checkedAt: new Date(START - 1).toISOString(), windows: [], resetCredits: { availableCount: 9 } } });
  assert.equal(row.manualResets.value?.availableCount, 9);
  const later = new Date(START + 5 * 60_000).toISOString();
  applyT3(row, { ...provider(), usageLimits: { checkedAt: later, windows: [{ usedPercent: 20 }] } });
  assert.equal(row.manualResets.observedAt, new Date(START - 1).toISOString()); assert.equal(row.credits.observedAt, AT);
  assert.equal(metricNow(row.included, START + STALE_AFTER_MS).state, "fresh");
  assert.equal(hasQuota({ ...provider(), usageLimits: { checkedAt: AT, windows: [{ usedPercent: 0 }] }, headroom: routingLanes(row, START) }, START), false);
  failCodex(row, "rate_limited");
  assert.equal(metricNow(row.credits, START + STALE_AFTER_MS).state, "stale");
  assert.equal(row.credits.value?.balance, "61951.0098125000");
  assert.equal(row.credits.error, "rate_limited");
  const text = humanStatus({ ...emptyHeadroom(), providers: [row] }, START + STALE_AFTER_MS);
  assert.match(text, /61951.0098125000 credits/); assert.doesNotMatch(text, /PRIVATE|USD|purchased/);
  const lanes = routingLanes(row, START);
  assert.equal(lanes.creditFunded.admissionAllowed, false);
  assert.equal(lanes.manualResetInventory.automaticRedemptionAllowed, false);
  const includedOnly = { ...provider(), usageLimits: { checkedAt: AT, windows: [{ usedPercent: 0 }] },
    headroom: { ...lanes, included: { ...lanes.included, ordinaryUsageAllowed: { ...lanes.included.ordinaryUsageAllowed, value: true } },
      creditFunded: { ...lanes.creditFunded, spendControlReached: { ...lanes.creditFunded.spendControlReached, value: true } } } };
  assert.equal(hasQuota(includedOnly, START), true, "paid spend control does not deny included quota");
  assert.equal(hasQuota({ ...provider(), usageLimits: { checkedAt: AT, windows: [{ usedPercent: 0 }] }, headroom: lanes }, START), true, "failed permission observation does not override fresh included windows");
  applyCodex(row, { rateLimits: { credits: { hasCredits: false, unlimited: false, balance: "0" } } }, later);
  assert.equal(row.credits.value?.balance, "0");
  applyCodex(row, { rateLimits: { credits: null } }, later);
  assert.equal(row.credits.value, null); assert.equal(row.credits.state, "unknown");
  const claude = newProvider("claudeAgent", "claudeAgent");
  applyT3(claude, { ...provider(), driver: "claudeAgent" });
  assert.equal(claude.manualResets.source, "t3-internal-claude-reset-read");
  assert.equal(claude.extraUsage.state, "unknown"); assert.equal(claude.credits.state, "unsupported");
  assert.equal(metricNow(claude.extraUsage, START).ageSeconds, null);
});
test("one startup read per matching context, shared aliases, single-flight, jitter and failure backoff", async () => {
  let now = START, calls = 0, release!: (value: unknown) => void;
  const config = headroomConfig({ contexts: [
    { providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" },
    { providers: ["alias"], home: "/scratch/home", codexHome: "/scratch/codex" },
  ] });
  assert.equal(config.contexts.length, 1);
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => now, random: () => 0,
    save() {}, read: async () => { calls++; return await new Promise(r => { release = r; }); } });
  m.update([provider(), provider("alias")]);
  assert.equal(calls, 1);
  const flight = m.tick(); assert.equal(m.tick(), flight); release(response); await flight;
  assert.equal(m.state.providers[1]?.credits.value?.balance, "61951.0098125000");
  now += COLLECT_EVERY_MS * 0.9 - 1; await m.tick(); assert.equal(calls, 1);
  now++; const again = m.tick(); assert.equal(calls, 2); release(response); await again;
  m.inactive(); now += 20 * COLLECT_EVERY_MS; await m.tick(); assert.equal(calls, 2);
  await m.close();
  let failures = 0;
  const failing = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => now, random: () => 0.5,
    save() {}, read: async () => { failures++; throw new BalanceReadError("rate_limited"); } });
  failing.update([provider()]); await failing.tick(); assert.equal(failures, 1);
  now += COLLECT_EVERY_MS; await failing.tick(); assert.equal(failures, 1);
  now += COLLECT_EVERY_MS; await failing.tick(); assert.equal(failures, 2);
  assert.equal(failing.state.providers[0]?.credits.error, "rate_limited"); await failing.close();
});
test("missing published runtime home reports one sanitized rejection and recovers when bound", async () => {
  const { runtimeHome, ...missingHome } = provider();
  const diagnostics: unknown[] = [];
  let reads = 0;
  const config = headroomConfig({ contexts: [{ providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" }] });
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => START,
    save() {}, diagnostic: d => diagnostics.push(d), read: async () => { reads++; return response; } });
  try {
    m.update([missingHome]); await m.tick();
    assert.equal(reads, 0);
    assert.equal(m.state.providers[0]?.credits.error, "runtime_home_unknown");
    assert.deepEqual(diagnostics, [{ provider: "codex", reason: "runtime_home_unknown" }]);
    const text = humanStatus(m.state, START).split("\n").find(line => line.includes("aggregate credits"));
    assert.match(text!, /reason runtime_home_unknown/);
    assert.doesNotMatch(text!, /observed never/);
    m.update([missingHome]); await m.tick(); await m.tick();
    assert.equal(diagnostics.length, 1);
    m.update([provider()]); await m.tick();
    assert.equal(reads, 1); assert.equal(m.state.providers[0]?.credits.error, null);
    assert.equal(m.state.providers[0]?.credits.value?.balance, response.rateLimitsByLimitId.codex.credits.balance);
    assert.doesNotMatch(JSON.stringify(diagnostics), /scratch|PRIVATE|account|codexHome|runtimeHome/);
  } finally { await m.close(); }
});

test("operator assertion is explicit, visible, and cannot override published homes or other guards", async () => {
  const entry = { providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" };
  assert.equal(headroomConfig({ contexts: [entry] }).contexts[0]?.assertRuntimeHome, false);
  assert.equal(headroomConfig({ contexts: [{ ...entry, assertRuntimeHome: false }] }).contexts[0]?.assertRuntimeHome, false);
  for (const value of ["true", 1, null]) {
    assert.throws(() => headroomConfig({ contexts: [{ ...entry, assertRuntimeHome: value }] }), /must be a boolean/);
  }
  const config = headroomConfig({ contexts: [{ ...entry, assertRuntimeHome: true }] });
  const { runtimeHome, ...missingHome } = provider();
  const diagnostics: unknown[] = [];
  let reads = 0;
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => START,
    random: () => 0.5, save() {}, diagnostic: d => diagnostics.push(d),
    read: async () => { reads++; return response; } });
  try {
    m.update([missingHome]); await m.tick();
    assert.equal(reads, 1);
    assert.equal(statusSnapshot(m.state, START).providers[0]?.binding, "asserted");
    assert.match(humanStatus(m.state, START), /binding: asserted/);
    assert.deepEqual(diagnostics, [
      { provider: "codex", reason: "read_started", binding: "asserted" },
      { provider: "codex", reason: "read_completed", binding: "asserted" },
    ]);
    m.update([{ ...missingHome, enabled: false }]); await m.tick();
    assert.equal(statusSnapshot(m.state, START).providers[0]?.binding, "asserted");
    assert.match(humanStatus(m.state, START), /binding: asserted/);
    assert.equal(m.state.providers[0]?.credits.value?.balance, response.rateLimitsByLimitId.codex.credits.balance);
    m.update([missingHome]); await m.tick(); assert.equal(reads, 1);
    assert.equal(m.state.providers[0]?.credits.observedAt, AT);
    m.update([provider("codex", "/different-account")]); await m.tick();
    assert.equal(reads, 1); assert.equal(m.state.providers[0]?.credits.error, "runtime_home_mismatch");
    assert.equal(m.state.providers[0]?.credits.value, null);
    assert.equal(m.state.providers[0]?.credits.observedAt, null);
    // Returning to an asserted binding is a new identity and must wait for the existing deadline.
    m.update([missingHome]); await m.tick();
    assert.equal(reads, 1); assert.equal(m.state.providers[0]?.credits.error, "read_scheduled");
    assert.equal(m.state.providers[0]?.credits.value, null);
    assert.equal(m.state.providers[0]?.credits.observedAt, null);
    m.update([provider()]); await m.tick();
    assert.equal(statusSnapshot(m.state, START).providers[0]?.binding, "verified");
  } finally { await m.close(); }
  for (const [local, p, reason] of [
    [false, missingHome, "remote_t3"],
    [true, { ...missingHome, quotaContextBlocked: true }, "instance_environment_unsupported"],
    [true, { ...missingHome, auth: { status: "unauthenticated" } }, "auth_not_authenticated"],
    [true, { ...missingHome, auth: { status: "authenticated", type: "apiKey" } }, "auth_type_not_chatgpt"],
  ] as const) {
    const guarded = new HeadroomMonitor({ state: emptyHeadroom(), config, local, now: () => START,
      save() {}, read: async () => assert.fail("assertion bypassed a guard") });
    try {
      guarded.update([p]); await guarded.tick();
      assert.equal(guarded.state.providers[0]?.credits.error, reason);
    } finally { await guarded.close(); }
  }
});

test("operator-asserted observations cannot suppress or admit an included provider switch", () => {
  const row = newProvider("codex", "codex");
  applyCodex(row, response, AT); // The asserted account says ordinary usage is forbidden.
  const target = { ...provider(), models: [{ slug: "gpt-6.1-sol", capabilities: null }],
    usageLimits: { checkedAt: AT, windows: [{ usedPercent: 0 }] } };
  const source = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
  const config = switchConfig({ enabled: true });
  for (const binding of ["verified", "asserted"] as const) {
    row.binding = binding;
    const p = { ...target, headroom: routingLanes(row, START) };
    assert.equal(p.headroom.included.ordinaryUsageAllowed.value, false);
    assert.deepEqual(equivalentTarget(source, [p], config, START),
      binding === "asserted" ? { instanceId: "codex", model: "gpt-6.1-sol" } : null);
    assert.equal(equivalentTarget(source, [{ ...p, usageLimits: { checkedAt: AT, windows: [{ usedPercent: 100 }] } }], config, START), null);
    assert.equal(equivalentTarget(source, [p], config, START + COLLECT_EVERY_MS + 1), null);
  }
});

test("mixed assertion policies share one read without opting other aliases in", async () => {
  const entry = { home: "/scratch/home", codexHome: "/scratch/codex" };
  for (const reverse of [false, true]) {
    const contexts = [
      { ...entry, providers: ["asserted"], assertRuntimeHome: true },
      { ...entry, providers: ["default", "verified"] },
    ];
    const config = headroomConfig({ contexts: reverse ? contexts.reverse() : contexts });
    let reads = 0, now = START;
    const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => now,
      random: () => 0.5, save() {}, read: async () => { reads++; return response; } });
    const catalog = ["asserted", "default", "verified"].map(alias => {
      const { runtimeHome, ...p } = provider(alias);
      return { ...p, ...(alias === "verified" ? { runtimeHome: runtimeHome! } : {}) };
    });
    try {
      m.update(catalog); await m.tick();
      const rows = new Map(m.state.providers.map(p => [p.alias, p]));
      assert.equal(reads, 1);
      assert.equal(rows.get("asserted")?.credits.value?.balance, response.rateLimitsByLimitId.codex.credits.balance);
      assert.equal(rows.get("verified")?.credits.value?.balance, response.rateLimitsByLimitId.codex.credits.balance);
      assert.equal(rows.get("default")?.credits.error, "runtime_home_unknown");
      assert.equal(rows.get("default")?.credits.value, null);
      now += COLLECT_EVERY_MS; await m.tick(); assert.equal(reads, 2);
    } finally { await m.close(); }
  }
});

test("every rejected binding has a stable status reason without a read or repeated logs", async () => {
  const config = headroomConfig({ contexts: [{ providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" }] });
  const cases: Array<{ reason: string; p?: SwitchProvider; local?: boolean }> = [
    { reason: "provider_not_found" },
    { reason: "provider_driver_mismatch", p: { ...provider(), driver: "claudeAgent" } },
    { reason: "provider_disabled", p: { ...provider(), enabled: false } },
    { reason: "provider_not_installed", p: { ...provider(), installed: false } },
    { reason: "provider_unavailable", p: { ...provider(), availability: "unavailable" } },
    { reason: "auth_not_authenticated", p: { ...provider(), auth: { status: "unauthenticated" } } },
    { reason: "auth_type_not_chatgpt", p: { ...provider(), auth: { status: "authenticated", type: "apiKey" } } },
    { reason: "instance_environment_unsupported", p: { ...provider(), quotaContextBlocked: true } },
    { reason: "runtime_home_mismatch", p: provider("codex", "/PRIVATE_CONTEXT") },
    { reason: "remote_t3", p: provider(), local: false },
  ];
  for (const c of cases) {
    const diagnostics: unknown[] = [];
    const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: c.local ?? true, now: () => START,
      save() {}, diagnostic: d => diagnostics.push(d), read: async () => assert.fail("rejected read") });
    try {
      for (let i = 0; i < 3; i++) { m.update(c.p ? [c.p] : []); await m.tick(); }
      assert.equal(m.state.providers.find(p => p.alias === "codex")?.credits.error, c.reason);
      assert.deepEqual(diagnostics, [{ provider: "codex", reason: c.reason }]);
      assert.doesNotMatch(JSON.stringify(statusSnapshot(m.state, START)) + JSON.stringify(diagnostics), /PRIVATE_CONTEXT|scratch/);
    } finally { await m.close(); }
  }
  const unconfigured = new HeadroomMonitor({ state: emptyHeadroom(), config: headroomConfig(), local: true,
    now: () => START, save() {}, read: async () => assert.fail("unconfigured read") });
  try { unconfigured.update([provider()]); await unconfigured.tick();
    assert.equal(unconfigured.state.providers[0]?.credits.error, "context_not_configured");
  } finally { await unconfigured.close(); }
});

test("catalog rejection recovery preserves normal cadence and rate-limit backoff", async () => {
  const config = headroomConfig({ contexts: [{ providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" }] });
  for (const balance of [response.rateLimitsByLimitId.codex.credits.balance, null]) for (const rateLimited of [false, true]) {
    let now = START, reads = 0;
    const records: QuotaRecord[] = [];
    const result = { ...response, rateLimitsByLimitId: { codex: { ...response.rateLimitsByLimitId.codex,
      credits: { ...response.rateLimitsByLimitId.codex.credits, balance } } } };
    const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => now, random: () => 0.5,
      save: batch => records.push(...batch),
      read: async () => { reads++; if (rateLimited) throw new BalanceReadError("rate_limited"); return result; } });
    try {
      m.update([provider()]); await m.tick(); assert.equal(reads, 1);
      now += 1_000;
      for (const rejected of [{ ...provider(), availability: "unavailable" }, { ...provider(), enabled: false }]) {
        m.update([rejected]); await m.tick();
        m.update([provider()]); await m.tick();
        assert.equal(reads, 1, "availability and enablement flaps must preserve the deadline");
        const row = m.state.providers[0]!;
        for (const key of ["credits", "ordinaryUsageAllowed", "spendControlReached"] as const) {
          const metric = row[key];
          if (!rateLimited) {
            assert.equal(metric.observedAt, AT, key);
            assert.equal(metric.error, null, key);
          }
        }
        const json = statusSnapshot(m.state, now).providers[0]!.creditFunded.credits;
        const human = humanStatus(m.state, now);
        if (rateLimited) {
          assert.equal(json.value, null); assert.equal(json.observedAt, null);
          assert.equal(json.error, "read_scheduled");
          assert.match(human, /reason read_scheduled/);
        } else {
          assert.equal(json.value?.balance, balance);
          assert.equal(json.state, balance === null ? "unknown" : "fresh");
          assert.equal(json.observedAt, AT); assert.equal(json.error, null);
          assert.match(human, balance === null ? /unknown credits; hasCredits=true; unlimited=false \[unknown/ : /61951\.0098125000 credits/);
          assert.match(human, /observed 2026-10-17T17:57:35\.000Z/);
          assert.equal(row.ordinaryUsageAllowed.value, false);
          assert.equal(row.spendControlReached.value, false);
          assert.equal(row.plan.value, null, "plan is not collected by the wallet adapter");
          assert.equal(row.manualResets.state, "unknown", "app-server reset inventory is ignored");
        }
      }
      now = START + COLLECT_EVERY_MS * (rateLimited ? 2 : 1) - 1;
      await m.tick(); assert.equal(reads, 1);
      now++; await m.tick(); assert.equal(reads, 2);
    } finally { await m.close(); }
  }
});

test("read diagnostics are bounded, redact failures, and cannot overwrite a new rejection", async () => {
  const config = headroomConfig({ contexts: [{ providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" }] });
  let now = START, reject!: (error: Error) => void;
  const diagnostics: unknown[] = [];
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => now, random: () => 0.5,
    save() {}, diagnostic: d => diagnostics.push(d), read: () => new Promise((_, r) => { reject = r; }) });
  try {
    m.update([provider()]); const flight = m.tick();
    m.update([{ ...provider(), enabled: false }]); reject(new Error("PRIVATE_TOKEN PRIVATE_ACCOUNT"));
    await flight;
    assert.equal(m.state.providers[0]?.credits.error, "provider_disabled");
    assert.doesNotMatch(JSON.stringify(diagnostics), /PRIVATE/);
  } finally { await m.close(); }
  const quiet: unknown[] = [];
  const healthy = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => now, random: () => 0.5,
    save() {}, diagnostic: d => quiet.push(d), read: async () => response });
  try {
    healthy.update([provider()]); await healthy.tick();
    for (let i = 0; i < 5; i++) { now += COLLECT_EVERY_MS; await healthy.tick(); }
    assert.deepEqual(quiet, [{ provider: "codex", reason: "read_started" }, { provider: "codex", reason: "read_completed" }]);
  } finally { await healthy.close(); }
});

test("unmatched/remote/disabled contexts never launch a collector and reconfiguration discards wallet", async () => {
  const config = headroomConfig({ contexts: [{ providers: ["codex"], home: "/scratch/home", codexHome: "/scratch/codex" }] });
  for (const [local, p] of [[true, provider("codex", "/wrong")], [false, provider()], [true, { ...provider(), enabled: false }], [true, { ...provider(), quotaContextBlocked: true }], [true, { ...provider(), auth: { status: "authenticated", type: "apiKey" } }]] as const) {
    const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local, now: () => START, save() {},
      read: async () => { assert.fail("unmatched collector launched"); } });
    m.update([p]); await m.tick(); assert.equal(m.state.providers[0]?.credits.value, null); await m.close();
  }
  let release!: (v: unknown) => void;
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => START, save() {},
    read: () => new Promise(r => { release = r; }) });
  m.update([provider()]); m.update([provider("codex", "/changed")]); release(response); await m.tick();
  assert.equal(m.state.providers[0]?.credits.value, null); await m.close();
  const wrongAccount = new HeadroomMonitor({ state: emptyHeadroom(), config, local: true, now: () => START, save() {},
    read: async () => response });
  wrongAccount.update([{ ...provider(), quotaAccountKey: "does-not-match" }]); await wrongAccount.tick();
  assert.equal(wrongAccount.state.providers[0]?.credits.value, null);
  assert.equal(wrongAccount.state.providers[0]?.credits.error, "context_mismatch");
  assert.doesNotMatch(JSON.stringify(statusSnapshot(wrongAccount.state, START)), /does-not-match|PRIVATE|quotaAccountKey/);
  await wrongAccount.close();
});
test("idle scheduler ticks do not write state and malformed persisted headroom fails closed at load", async () => {
  let writes = 0, now = START;
  const m = new HeadroomMonitor({ state: emptyHeadroom(), config: headroomConfig(), local: true, now: () => now,
    save: () => { writes++; } });
  m.update([provider()]); await m.tick(); const initial = writes;
  for (let i = 0; i < 5; i++) { now += 10_000; await m.tick(); }
  assert.equal(writes, initial);
  await m.close();
  const f = scratchDir("headroom-invalid");
  try {
    const path = join(f.path, "state.json"), bytes = JSON.stringify({ version: 5, headroom: {} });
    writeFileSync(path, bytes);
    assert.throws(() => loadState(path, START), /invalid_headroom_state/);
    assert.equal(readFileSync(path, "utf8"), bytes);
  } finally { f.remove(); }
});
test("stdio fake verifies the complete allowlisted exchange and redaction; failures are bounded and sanitized", async () => {
  const f = scratchDir("codex-balance");
  const old = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "PRIVATE_INHERITED_TOKEN";
  try {
    const home = join(f.path, "home"), codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true }); writeFileSync(join(home, "quota-fake-home"), "");
    const command = join(f.path, "fake-codex");
    copyFileSync(resolve("test/fixtures/fake-codex-balance.mjs"), command); chmodSync(command, 0o700);
    const ctx = { providers: ["codex"], home, codexHome, command };
    const scenario = (mode: string) => writeFileSync(join(home, "scenario.json"), JSON.stringify({ mode, codexHome, result: response }));
    scenario("success");
    const raw = await readCodexBalance(ctx, new AbortController().signal);
    const row = newProvider("codex", "codex"); applyCodex(row, raw, AT);
    assert.equal(row.credits.value?.balance, "61951.0098125000");
    assert.doesNotMatch(JSON.stringify(statusSnapshot({ ...emptyHeadroom(), providers: [row] }, START)), /PRIVATE/);
    const requests = readFileSync(join(home, "requests.jsonl"), "utf8").trim().split("\n").map(l => JSON.parse(l));
    assert.deepEqual(requests.map(r => r.method), ["initialize", "initialized", "account/read", "account/rateLimits/read"]);
    assert.deepEqual(requests[2].params, { refreshToken: false });
    assert.deepEqual(requests[3].params, { excludeResetCreditDetails: true, supportsLunaReserve: false });
    await assert.rejects(readCodexBalance({ ...ctx, command: join(f.path, "missing") }, new AbortController().signal), e => e instanceof BalanceReadError && e.code === "spawn_failed");
    chmodSync(command, 0o600);
    await assert.rejects(readCodexBalance(ctx, new AbortController().signal), e => e instanceof BalanceReadError && e.code === "spawn_failed");
    chmodSync(command, 0o700);
    scenario("account-error");
    const withoutAccountRead = await readCodexBalance(ctx, new AbortController().signal) as { accountId: string };
    assert.equal(withoutAccountRead.accountId, response.accountId);
    writeFileSync(join(home, "scenario.json"), JSON.stringify({ mode: "success", codexHome,
      result: response, account: { id: "PRIVATE_DIFFERENT_USER_ID" } }));
    assert.equal((await readCodexBalance(ctx, new AbortController().signal) as { accountId: string }).accountId, response.accountId);
    scenario("error"); await assert.rejects(readCodexBalance(ctx, new AbortController().signal), e => e instanceof BalanceReadError && e.code === "rate_limited");
    scenario("overflow"); await assert.rejects(readCodexBalance(ctx, new AbortController().signal), e => e instanceof BalanceReadError && e.code === "protocol");
    scenario("hang"); await assert.rejects(readCodexBalance(ctx, new AbortController().signal, 100), e => e instanceof BalanceReadError && e.code === "timeout");
    const abort = new AbortController(); abort.abort();
    await assert.rejects(readCodexBalance(ctx, abort.signal), e => e instanceof BalanceReadError && e.code === "aborted");
  } finally { if (old === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = old; f.remove(); }
});
test("status CLI reads only the snapshot (human and JSON) without a T3 connection or provider", async () => {
  const f = scratchDir("quota-status");
  try {
    const path = join(f.path, "state.json"), state = emptyState(), row = newProvider("codex", "codex");
    const rejected = newProvider("codex_skipped", "codex"); failCodex(rejected, "runtime_home_unknown");
    applyT3(row, provider()); applyCodex(row, response, AT); state.headroom.providers = [row, rejected];
    row.binding = "asserted";
    saveState(path, state, START);
    for (const json of [false, true]) {
      const child = spawn(process.execPath, ["src/cli.ts", "quota", "status", "--state-file", path, ...(json ? ["--json"] : [])],
        { env: { ...process.env, PATH: "/nonexistent" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
      const code = await new Promise(r => child.once("close", r));
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout + stderr, /PRIVATE|accountId|nextCreditId|credentialFingerprint|runtimeHome/);
      if (json) {
        assert.equal(JSON.parse(stdout).providers[0].creditFunded.credits.value.balance, "61951.0098125000");
        assert.equal(JSON.parse(stdout).providers[1].creditFunded.credits.error, "runtime_home_unknown");
        assert.equal(JSON.parse(stdout).providers[0].binding, "asserted");
      } else {
        assert.match(stdout, /61951.0098125000 credits/); assert.match(stdout, /manual resets: 1/);
        assert.match(stdout, /binding: asserted/);
        assert.match(stdout, /aggregate credits: unknown \[error; codex-app-server; reason runtime_home_unknown;/);
      }
    }
  } finally { f.remove(); }
});
