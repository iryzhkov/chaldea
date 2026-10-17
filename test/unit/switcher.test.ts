import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AuthenticationError, ProtocolIncompatibleError, type ModelChoice, type ShellThread, type SwitchPort, type SwitchProvider } from "../../src/t3/adapter.ts";
import { DEFAULT_EQUIVALENCES, equivalentTarget, hasQuota, MAX_USAGE_AGE_MS, switchConfig } from "../../src/quota/routing.ts";
import { ProviderSwitcher, switchIds, holdDeadline, HOLD_GRACE_MS, RESETLESS_BOUND_MS, type SwitchIntent, MAX_ACTIVE_SWITCHES } from "../../src/quota/switcher.ts";
import { emptyState, prune, KEY_TTL_MS, DAY_MS, type ObserverState } from "../../src/quota/state.ts";
import { observe, type QuotaRecord } from "../../src/quota/observer.ts";
import { limited } from "../helpers/threads.ts";

const config = switchConfig({ enabled: true });
const from: ModelChoice = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };
const children: ProviderSwitcher[] = [];
afterEach(async () => { for (const s of children.splice(0)) await s.close(); });
function provider(instanceId = "codex", model = "gpt-6.1-sol", effort = "reasoningEffort"): SwitchProvider {
  return { instanceId, driver: instanceId, enabled: true, installed: true, status: "ready",
    auth: { status: "authenticated" }, models: [{ slug: model, capabilities: {
      optionDescriptors: [{ id: effort, type: "select", options: [{ id: "high" }] }],
    } }], usageLimits: { checkedAt: new Date().toISOString(), windows: [{ usedPercent: 0 }, { usedPercent: 99 }] } };
}
function harness(state: ObserverState = emptyState()) {
  let offset = 0;
  const now = () => Date.now() + offset;
  let current: ShellThread | undefined = limited("run-a", now(), new Date(now() + 60_000).toISOString(), { modelSelection: from });
  const calls: Array<{ kind: string; input: any }> = [], records: QuotaRecord[] = [], logs: string[] = [];
  let durable = true, acceptDispatch = true, acceptRelease = true, delivered = false, catalogCalls = 0, autoResume = true;
  let onRecovery: (() => void) | undefined, onContinue: (() => void) | undefined;
  const port: SwitchPort = {
    catalog: async () => { catalogCalls++; return { providers: [provider()], autoResume }; },
    thread: async () => current,
    recovery: async (input) => {
      calls.push({ kind: "recovery", input });
      if (input.commandId.includes(":release") && !acceptRelease) return false;
      if (current) current = { ...current, limitRecovery: {
        ...current.limitRecovery, ...input, requestId: input.commandId,
      } };
      onRecovery?.(); return true;
    },
    clearRecovery: async (threadId, commandId) => {
      calls.push({ kind: "clear", input: { threadId, commandId } });
      if (current) current = { ...current, limitRecovery: null };
      return true;
    },
    delivered: async () => delivered,
    continue: async (input) => {
      assert.ok(durable, "dispatch must follow persistence");
      calls.push({ kind: "continue", input }); onContinue?.();
      if (acceptDispatch) {
        delivered = true;
        if (current) current = { ...current, latestRunId: "continued", status: "completed",
          providerInstanceId: input.target.instanceId, modelSelection: input.target };
      }
      return acceptDispatch;
    },
  };
  const make = (enabled = true) => {
    const s = new ProviderSwitcher({ state, port, config: { ...config, enabled }, now,
      save: () => durable, record: (r) => records.push(r),
      logger: { info() {}, warn(message) { logs.push(message); }, error(message) { logs.push(message); } } });
    children.push(s); return s;
  };
  const event = () => ({ kind: "thread" as const, sequence: 1, thread: current! });
  const start = async (s: ProviderSwitcher) => { await s.handle({ kind: "snapshot", sequence: 1, threads: current ? [current] : [] }); await s.handle({ kind: "synchronized" }); };
  const seed = (phase: SwitchIntent["phase"] = "dispatching"): SwitchIntent => {
    const intent: SwitchIntent = {
      threadId: current!.id, runId: current!.latestRunId!, resetAt: current!.usageLimitResetAt,
      from: current!.modelSelection!, target: { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }] },
      stopAt: Date.parse(current!.usageLimitResetAt!), createdAt: now(), expiresAt: current!.usageLimitResetAt === null ? now() + RESETLESS_BOUND_MS : Date.parse(current!.usageLimitResetAt) + HOLD_GRACE_MS,
      restoreAutoResume: true, subagent: false, phase,
    };
    state.switches.set(switchIds(intent.threadId, intent.runId).key, intent);
    current = { ...current!, limitRecovery: { runId: intent.runId, resetAt: intent.resetAt!, autoResume: false,
      requestId: switchIds(intent.threadId, intent.runId).hold } };
    return intent;
  };
  return { state, port, calls, records, logs, make, start, event, seed, now,
    advance(ms: number) { offset += ms; },
    get current() { return current; }, set current(value) { current = value; },
    get catalogCalls() { return catalogCalls; },
    set durable(v: boolean) { durable = v; }, set acceptDispatch(v: boolean) { acceptDispatch = v; },
    set acceptRelease(v: boolean) { acceptRelease = v; }, set delivered(v: boolean) { delivered = v; },
    set autoResume(v: boolean) { autoResume = v; },
    set onRecovery(v: () => void) { onRecovery = v; }, set onContinue(v: () => void) { onContinue = v; } };
}

test("defaults route all three pairs both ways and preserve supported effort", () => {
  assert.equal(switchConfig().enabled, false);
  for (const [claude, codex] of DEFAULT_EQUIVALENCES) {
    const target = equivalentTarget({ ...from, model: claude }, [provider("codex", codex)], config)!;
    assert.equal(target.model, codex);
    assert.deepEqual(target.options, [{ id: "reasoningEffort", value: "high" }]);
    assert.deepEqual(equivalentTarget(target, [provider("claudeAgent", claude, "effort")], config), { ...from, model: claude });
  }
});
test("configuration rejects ambiguous, invalid and oversized maps", () => {
  assert.equal(switchConfig({ equivalences: [["c", "g"]] }).equivalences.length, 1);
  for (const raw of [null, [], { enabled: "yes" }, { equivalences: [["c"]] },
    { equivalences: [["c", "g"], ["c", "x"]] }, { equivalences: [[" ", "g"]] },
    { equivalences: Array(129).fill(["c", "g"]) }]) assert.throws(() => switchConfig(raw));
});
test("admission requires healthy instances and fresh known nonempty quota windows", () => {
  const p = provider(); assert.equal(hasQuota(p), true);
  const { usageLimits, ...unknown } = p;
  for (const value of [undefined, unknown, { ...p, enabled: false }, { ...p, installed: false },
    { ...p, status: "warning" }, { ...p, availability: "unavailable" }, { ...p, auth: { status: "unknown" } },
    { ...p, usageLimits: { checkedAt: "", windows: [] } },
    { ...p, usageLimits: { checkedAt: new Date().toISOString(), windows: [{ usedPercent: 100 }] } },
    { ...p, usageLimits: { ...usageLimits!, checkedAt: new Date(Date.now() - MAX_USAGE_AGE_MS - 100).toISOString() } },
    { ...p, usageLimits: { ...usageLimits!, checkedAt: new Date(Date.now() + 60_000).toISOString() } },
    { ...p, usageLimits: { ...usageLimits!, unavailable: true } }]) assert.equal(hasQuota(value), false);
});
test("pinned reset credits and externalUsage do not expose spendable purchased credit capacity", () => {
  // These are the only credit/overage-related fields of ServerProviderUsageLimits.
  const p = { ...provider(), usageLimits: { checkedAt: new Date().toISOString(), windows: [{ usedPercent: 100 }],
    resetCredits: { availableCount: 3 }, externalUsage: { label: "Usage", url: "https://example.invalid/usage" } } };
  assert.equal(hasQuota(p), false, "unredeemed resets and a link cannot prove active overage");
});
test("routing requires exact model, driver and supported effort", () => {
  assert.equal(equivalentTarget(from, [provider("codex", "other")], config), null);
  assert.equal(equivalentTarget(from, [{ ...provider(), driver: "other" }], config), null);
  assert.equal(equivalentTarget({ ...from, options: [{ id: "effort", value: "max" }] }, [provider()], config), null);
});
test("IDs are deterministic, bounded and unambiguous", () => {
  assert.deepEqual(switchIds("a", "b"), switchIds("a", "b"));
  assert.notEqual(switchIds("a:b", "c").dispatch, switchIds("a", "b:c").dispatch);
  assert.equal(switchIds("x".repeat(1000), "r").dispatch.length, 88);
});
test("switching waits for synchronization, holds once and caches the catalog per batch", async () => {
  const h = harness(), s = h.make();
  await s.handle(h.event()); assert.equal(h.calls.length, 0);
  await s.handle({ kind: "synchronized" });
  assert.deepEqual(h.calls.map((c) => c.kind), ["recovery", "continue"]);
  assert.equal(h.catalogCalls, 1);
  assert.equal(h.records.filter((r) => r.kind === "provider_switched").length, 1);
});
test("a 20-day stop whose reset passed 19 days ago is never admitted on snapshots or reconnects", async () => {
  const h = harness(); h.current = limited("old", h.now() - 20 * DAY_MS, new Date(h.now() - 19 * DAY_MS).toISOString(), { modelSelection: from });
  const s = h.make(); await h.start(s); s.reconnect(h.port, false); await h.start(s);
  assert.equal(h.state.switches.size, 0); assert.equal(h.calls.length, 0);
});
test("resetless history is ignored; a fresh resetless stop seen live can switch", async () => {
  const h = harness(); h.current = limited("old", h.now() - DAY_MS, null, { modelSelection: from });
  const s = h.make(); await h.start(s); assert.equal(h.calls.length, 0);
  h.current = limited("fresh", h.now(), null, { modelSelection: from });
  await s.handle(h.event());
  assert.deepEqual(h.calls.map((c) => c.kind), ["continue"]);
});
test("default off, exhausted target, pending and settled stops preserve native recovery", async () => {
  const h = harness(); await h.start(h.make(false)); assert.equal(h.calls.length, 0);
  for (const patch of [{ pendingRequest: true }, { settled: true }, { activeRunId: "active" }]) {
    const t = harness(); t.current = { ...t.current!, ...patch }; await t.start(t.make()); assert.equal(t.calls.length, 0);
  }
  const t = harness(); t.port.catalog = async () => ({ providers: [], autoResume: true });
  await t.start(t.make()); assert.equal(t.calls.length, 0);
});
test("a human autoResume:false opt-out wins, but an orphaned Chaldea hold uses global restoration", async () => {
  const h = harness();
  h.current = { ...h.current!, limitRecovery: { runId: "run-a", resetAt: h.current!.usageLimitResetAt!, autoResume: false, requestId: "human" } };
  await h.start(h.make()); assert.equal(h.calls.length, 0);
  const t = harness(); t.seed(); t.state.switches.clear(); t.acceptDispatch = false;
  await t.start(t.make());
  assert.equal(t.current!.limitRecovery!.autoResume, true);
});
test("hold and rejected-dispatch release preserve native snooze", async () => {
  const h = harness();
  h.current = { ...h.current!, limitRecovery: { runId: "run-a", resetAt: h.current!.usageLimitResetAt!, autoResume: true, snooze: true } };
  h.acceptDispatch = false; await h.start(h.make());
  assert.equal(h.calls[0]!.input.snooze, true);
  assert.equal(h.calls.at(-1)!.input.snooze, true);
  assert.equal(h.current!.limitRecovery!.snooze, true);
});
test("restart in dispatching checks delivered before touching human state", async () => {
  for (const phase of ["dispatching", "releasing"] as const) {
    const h = harness(); h.seed(phase); h.delivered = true;
    h.current = { ...h.current!, latestRunId: "continued", status: "completed", providerInstanceId: "codex" };
    await h.start(h.make());
    assert.equal(h.calls.length, 0);
    assert.equal(h.records[0]!.kind, "provider_switched");
  }
});
test("restart never overrides a human provider/model edit during an outage", async () => {
  const h = harness(); const intent = h.seed();
  h.current = { ...h.current!, modelSelection: { ...from, model: "claude-sonnet-5-5" } };
  await h.start(h.make());
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0);
  assert.equal(h.current!.modelSelection!.model, "claude-sonnet-5-5");
  assert.equal(h.current!.limitRecovery!.autoResume, true);
  assert.equal(intent.phase, "cancelled");
});
test("saved dispatching intents repeat every source and target preflight", async () => {
  for (const change of ["run", "provider", "archive", "settle", "pending", "reset", "quota"] as const) {
    const h = harness(); h.seed();
    const patches = { run: { latestRunId: "human", status: "completed" }, provider: { providerInstanceId: "other" },
      archive: { archived: true }, settle: { settled: true }, pending: { pendingRequest: true },
      reset: { usageLimitResetAt: new Date(h.now() - 1).toISOString() }, quota: {} };
    h.current = { ...h.current!, ...patches[change] };
    if (change === "quota") h.port.catalog = async () => ({ providers: [], autoResume: true });
    await h.start(h.make());
    assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0, change);
  }
});
test("an ambiguous accepted dispatch checks delivered and posts one switch without releasing", async () => {
  const h = harness();
  h.onContinue = () => { h.delivered = true; throw new Error("response lost"); };
  await h.start(h.make());
  assert.deepEqual(h.calls.map((c) => c.kind), ["recovery", "continue"]);
  assert.equal(h.records.filter((r) => r.kind === "provider_switched").length, 1);
});
test("an ambiguous undelivered dispatch releases and falls back with one loud warning", async () => {
  const h = harness(); h.onContinue = () => { throw new Error("send lost"); };
  const s = h.make(); await h.start(s); await s.handle(h.event());
  assert.equal(h.current!.limitRecovery!.autoResume, true);
  assert.equal(h.records.filter((r) => r.kind === "provider_switch_failed").length, 1);
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 1);
});
test("missing operate and switch-path protocol errors never escape to observation", async () => {
  for (const error of [new AuthenticationError("forbidden"), new ProtocolIncompatibleError("drift")]) {
    const h = harness(); const original = h.current!;
    h.port.recovery = async () => { throw error; };
    const s = h.make(); await h.start(s); await s.handle(h.event());
    assert.equal(h.records.filter((r) => r.kind === "provider_switch_failed").length, 1);
    assert.equal(observe(h.state, { kind: "thread", sequence: 2, thread: original }, h.now())[0]!.kind, "quota_parked");
    assert.equal(h.logs.length, 1);
  }
});
test("a failed save prevents new holds and dispatches", async () => {
  const h = harness(); h.durable = false; await h.start(h.make());
  assert.equal(h.calls.length, 0);
});
test("a failure releases previously owned holds where the credential still permits it", async () => {
  const h = harness(); h.seed("holding");
  h.port.catalog = async () => { throw new ProtocolIncompatibleError("catalog drift"); };
  await h.start(h.make());
  assert.equal(h.current!.limitRecovery!.autoResume, true);
  assert.equal(h.records.filter((r) => r.kind === "provider_switch_failed").length, 1);
});
test("a human recovery choice superseding a hold is not overwritten on release", async () => {
  const h = harness(); h.seed("releasing");
  h.current = { ...h.current!, limitRecovery: { ...h.current!.limitRecovery!, requestId: "human", autoResume: false } };
  await h.start(h.make()); assert.equal(h.calls.length, 0);
});
test("reset plus grace bounds all active phases and archived/settled cleanup frees slots", async () => {
  for (const phase of ["holding", "dispatching", "releasing"] as const) {
    for (const flags of [{ archived: true }, { settled: true }, { pendingRequest: true }, {}]) {
      const h = harness(); const intent = h.seed(phase);
      h.advance(60_000 + HOLD_GRACE_MS + 1);
      h.current = { ...h.current!, ...flags };
      await h.start(h.make());
      assert.equal(intent.phase, "cancelled", phase);
      assert.ok(h.current!.limitRecovery === null || h.current!.limitRecovery!.autoResume);
      assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0);
    }
  }
});
test("resetless saved intents have a short fixed deadline", async () => {
  const h = harness(); h.current = { ...h.current!, usageLimitResetAt: null };
  const intent = h.seed(); h.advance(RESETLESS_BOUND_MS + 1);
  await h.start(h.make()); assert.equal(intent.phase, "cancelled");
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0);
  assert.ok(holdDeadline(intent) <= intent.createdAt + RESETLESS_BOUND_MS);
});
test("a single deadline timer releases a parked hold without another shell event", async () => {
  const h = harness(); const intent = h.seed("releasing");
  Object.assign(intent, { expiresAt: h.now() + 30 });
  h.current = { ...h.current!, archived: true };
  await h.start(h.make());
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(intent.phase, "cancelled"); assert.equal(h.current!.limitRecovery, null);
});
test("release rejections use a new saved attempt; uncertain retries preserve the ID", async () => {
  const h = harness(); h.seed("releasing"); h.acceptRelease = false;
  const s = h.make(); await h.start(s); const id = h.calls.at(-1)!.input.commandId;
  h.acceptRelease = true; await s.handle(h.event());
  assert.notEqual(h.calls.at(-1)!.input.commandId, id);
  assert.equal(h.current!.limitRecovery!.autoResume, true);
});
test("a new Codex usage-limit run may switch back to Claude; a working run is never moved", async () => {
  const h = harness(); const s = h.make(); await h.start(s);
  h.port.catalog = async () => ({ providers: [provider("claudeAgent", from.model, "effort")], autoResume: true });
  await s.handle(h.event()); assert.equal(h.calls.filter((c) => c.kind === "continue").length, 1);
  h.current = limited("codex-stop", h.now(), new Date(h.now() + 60_000).toISOString(),
    { providerInstanceId: "codex", modelSelection: { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "reasoningEffort", value: "high" }] } });
  await s.handle(h.event());
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 2);
  assert.equal(h.current!.providerInstanceId, "claudeAgent");
});
test("full slots warn once; count eviction uses stop time instead of creation time", async () => {
  const h = harness(); const sample = h.seed("releasing"); h.state.switches.clear();
  for (let i = 0; i < MAX_ACTIVE_SWITCHES; i++) h.state.switches.set(String(i), { ...sample, threadId: String(i) });
  h.port.thread = async (id) => id === "thread-a" ? h.current : { ...h.current!, id, pendingRequest: true,
    limitRecovery: { runId: "run-a", resetAt: sample.resetAt!, autoResume: false, requestId: switchIds(id, "run-a").hold } };
  const s = h.make(); await h.start(s); await s.handle(h.event());
  assert.equal(h.logs.filter((l) => l.includes("cap reached")).length, 1);
  h.state.switches.clear();
  for (let i = 0; i < 1_001; i++) h.state.switches.set(String(i), {
    ...sample, phase: "cancelled", createdAt: h.now() - i, stopAt: h.now() + i,
  });
  prune(h.state, h.now());
  assert.equal(h.state.switches.has("0"), false); assert.equal(h.state.switches.has("1000"), true);
});
test("completed intent retention still expires and raises the watermark", async () => {
  const h = harness(); await h.start(h.make()); const intent = [...h.state.switches.values()][0]!;
  prune(h.state, intent.createdAt + KEY_TTL_MS + 1);
  assert.equal(h.state.switches.size, 0); assert.equal(h.state.evictedThrough, intent.stopAt);
});
