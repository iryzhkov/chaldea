import assert from "node:assert/strict";
import { test } from "node:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { headroomConfig, readCodexBalance, BalanceReadError } from "../../src/quota/codex-balance.ts";
import { applyCodex, applyT3, emptyHeadroom, failCodex, HeadroomMonitor, humanStatus, metricNow,
  newProvider, routingLanes, statusSnapshot, STALE_AFTER_MS, COLLECT_EVERY_MS } from "../../src/quota/headroom.ts";
import { emptyState, loadState, saveState } from "../../src/quota/state.ts";
import { EventSink } from "../../src/quota/run.ts";
import { body, quotaPublication } from "../../src/feed/poster.ts";
import { normalize } from "../../src/akasha/schema.ts";
import { hasQuota } from "../../src/quota/routing.ts";
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
  assert.equal(row.manualResets.value?.availableCount, 1);
  assert.equal(row.ordinaryUsageAllowed.value, false);
  const duplicate = newProvider("alias", "codex");
  const wallet = { credits: { balance: "7.000", hasCredits: true, unlimited: false } };
  applyCodex(duplicate, { rateLimitsByLimitId: { a: wallet, b: wallet } }, AT);
  assert.equal(duplicate.credits.value?.balance, "7.000");
  applyCodex(duplicate, { rateLimitsByLimitId: { a: wallet, b: { credits: { ...wallet.credits, balance: "8" } } } }, AT);
  assert.equal(duplicate.credits.value, null);
  applyT3(row, { ...provider(), usageLimits: { checkedAt: new Date(START - 1).toISOString(), windows: [], resetCredits: { availableCount: 9 } } });
  assert.equal(row.manualResets.value?.availableCount, 1);
  const later = new Date(START + 5 * 60_000).toISOString();
  applyT3(row, { ...provider(), usageLimits: { checkedAt: later, windows: [{ usedPercent: 20 }] } });
  assert.equal(row.manualResets.observedAt, AT); assert.equal(row.credits.observedAt, AT);
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
test("headroom records survive restart via the existing durable sink; quarter-hour and threshold crossings", async () => {
  const f = scratchDir("headroom-feed"), state = emptyState(), delivered: QuotaRecord[] = [];
  const path = join(f.path, "state.json");
  const sink = new EventSink(state, path, { enqueue: r => delivered.push(r) }, logger);
  let now = START;
  const m = new HeadroomMonitor({ state: state.headroom, config: headroomConfig(), local: true, now: () => now,
    save: records => { sink.record(records); sink.save(); } });
  try {
    m.update([provider()]); await m.tick();
    assert.equal(delivered.filter(r => r.kind === "quota_headroom_snapshot").length, 1);
    assert.equal(delivered.filter(r => r.kind === "quota_headroom_low").length, 1);
    await m.tick(); assert.equal(delivered.filter(r => r.kind === "quota_headroom_low").length, 1);
    m.update([{ ...provider(), usageLimits: { checkedAt: AT, windows: [{ usedPercent: 0 }] } }]);
    m.update([provider()]); await m.tick();
    assert.equal(delivered.filter(r => r.kind === "quota_headroom_low").length, 2);
    now = Math.floor(START / STALE_AFTER_MS + 1) * STALE_AFTER_MS;
    await m.tick(); assert.equal(delivered.filter(r => r.kind === "quota_headroom_snapshot").length, 2);
    const loaded = loadState(path, now); assert.equal(loaded.headroom.snapshotSlot, state.headroom.snapshotSlot);
    assert.ok(loaded.pendingDelivery.size > 0);
    const replayed: QuotaRecord[] = [];
    const restored = new EventSink(loaded, path, { enqueue: r => replayed.push(r) }, logger);
    restored.save(); assert.equal(replayed.length, loaded.pendingDelivery.size); restored.close();
    for (const record of replayed) {
      const p = quotaPublication(record, "agent-a");
      normalize(p.payload, { issuer: "i", profile: "p", project: "x", source: p.source, host: "agent-a", run_id: "r", source_id: "s" }, false);
      assert.ok(Buffer.byteLength(body(record, "agent-a")) < 48 * 1024);
      assert.doesNotMatch(body(record, "agent-a"), /PRIVATE|credentialFingerprint|nextCreditId|runtimeHome/);
    }
  } finally { await m.close(); sink.close(); f.remove(); }
});
test("headroom coalescing and eviction preserve the full transition queue during a delivery outage", () => {
  const f = scratchDir("headroom-priority"), state = emptyState(), queued = new Map<string, QuotaRecord>();
  const path = join(f.path, "state.json");
  const sink = new EventSink(state, path, { enqueue: r => queued.set(r.runId, r),
    discard: key => { for (const [id, r] of queued) if (quotaPublication(r, "test").key === key) queued.delete(id); } }, logger);
  const advisory = (alias: string, i: number): QuotaRecord => ({
    kind: "quota_headroom_snapshot", severity: "info", threadId: "headroom", runId: String(i), provider: "all", resetAt: null, subagent: false,
    headroom: statusSnapshot({ ...emptyHeadroom(), providers: [newProvider(alias, "codex")] }, START),
  });
  try {
    for (let i = 0; i < 300; i++) { sink.record([advisory("alias", i)]); sink.save(); }
    assert.equal(state.pendingDelivery.size, 1); assert.equal(queued.size, 1);
    for (let i = 0; i < 220; i++) { sink.record([advisory("p" + i, i + 300)]); sink.save(); }
    assert.equal(state.pendingDelivery.size, 192); assert.equal(queued.size, 192);
    for (let i = 0; i < 256; i++) {
      sink.record([{ kind: "quota_parked", severity: "warn", threadId: "t" + i, runId: "run" + i,
        provider: "codex", resetAt: AT, subagent: false }]); sink.save();
    }
    assert.equal(state.pendingDelivery.size, 256);
    assert.equal([...state.pendingDelivery.values()].filter(r => r.kind === "quota_parked").length, 256);
    assert.equal([...queued.values()].filter(r => r.kind === "quota_parked").length, 256);
    assert.equal(state.deliveryDropped, 0);
    assert.equal(loadState(path, START).pendingDelivery.size, 256);
  } finally { sink.close(); f.remove(); }
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
    assert.deepEqual(requests.map(r => r.method), ["initialize", "initialized", "account/rateLimits/read"]);
    assert.deepEqual(requests[2].params, { excludeResetCreditDetails: true, supportsLunaReserve: false });
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
    applyT3(row, provider()); applyCodex(row, response, AT); state.headroom.providers = [row];
    saveState(path, state, START);
    for (const json of [false, true]) {
      const child = spawn(process.execPath, ["src/cli.ts", "quota", "status", "--state-file", path, ...(json ? ["--json"] : [])],
        { env: { ...process.env, PATH: "/nonexistent" }, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "";
      child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
      const code = await new Promise(r => child.once("close", r));
      assert.equal(code, 0, stderr);
      assert.doesNotMatch(stdout + stderr, /PRIVATE|accountId|nextCreditId|credentialFingerprint|runtimeHome/);
      if (json) assert.equal(JSON.parse(stdout).providers[0].creditFunded.credits.value.balance, "61951.0098125000");
      else { assert.match(stdout, /61951.0098125000 credits/); assert.match(stdout, /manual resets: 1/); }
    }
  } finally { f.remove(); }
});
