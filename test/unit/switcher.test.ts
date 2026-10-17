import assert from "node:assert/strict";
import { test } from "node:test";
import { AuthenticationError, type ModelChoice, type ShellThread, type SwitchPort, type SwitchProvider } from "../../src/t3/adapter.ts";
import { DEFAULT_EQUIVALENCES, equivalentTarget, hasQuota, switchConfig } from "../../src/quota/routing.ts";
import { ProviderSwitcher, switchIds, type SwitchIntent, MAX_ACTIVE_SWITCHES } from "../../src/quota/switcher.ts";
import { emptyState, prune, KEY_TTL_MS, type ObserverState } from "../../src/quota/state.ts";
import { observe, type QuotaRecord } from "../../src/quota/observer.ts";
import { limited } from "../helpers/threads.ts";

const config = switchConfig({ enabled: true });
const from: ModelChoice = { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };
function provider(instanceId = "codex", model = "gpt-6.1-sol", effort = "reasoningEffort"): SwitchProvider {
  return { instanceId, driver: instanceId, enabled: true, installed: true, status: "ready",
    auth: { status: "authenticated" }, models: [{ slug: model, capabilities: {
      optionDescriptors: [{ id: effort, type: "select", options: [{ id: "high" }] }],
    } }], usageLimits: { checkedAt: new Date().toISOString(), windows: [{ usedPercent: 0 }, { usedPercent: 99 }] } };
}
function stopped(): ShellThread {
  return limited("run-a", Date.now(), new Date(Date.now() + 60_000).toISOString(), { modelSelection: from });
}
function harness(state: ObserverState = emptyState()) {
  let current: ShellThread | undefined = stopped();
  const calls: Array<{ kind: string; input: any }> = [];
  const records: QuotaRecord[] = [];
  const logs: string[] = [];
  let durable = true, acceptDispatch = true, acceptRelease = true;
  let onRecovery: (() => void) | undefined;
  let onContinue: (() => void) | undefined;
  const port: SwitchPort = {
    catalog: async () => ({ providers: [provider()], autoResume: true }),
    thread: async () => current,
    recovery: async (input) => {
      assert.ok(durable, "no side effect without persistence");
      calls.push({ kind: "recovery", input });
      if (input.autoResume && !acceptRelease) return false;
      if (current) current = { ...current, limitRecovery: { ...input, requestId: input.commandId } };
      onRecovery?.();
      return true;
    },
    delivered: async () => false,
    continue: async (input) => {
      assert.ok(durable, "no side effect without persistence");
      calls.push({ kind: "continue", input }); onContinue?.();
      return acceptDispatch;
    },
  };
  const make = (enabled = true) => new ProviderSwitcher({ state, port, config: { ...config, enabled },
    save: () => durable, record: (r) => records.push(r),
    logger: { info() {}, warn(message) { logs.push(message); }, error() {} } });
  const event = () => ({ kind: "thread" as const, sequence: 1, thread: current! });
  const start = async (s: ProviderSwitcher) => { await s.handle(event()); await s.handle({ kind: "synchronized" }); };
  return { state, port, calls, records, logs, make, start, event,
    get current() { return current; }, set current(value) { current = value; },
    set durable(value: boolean) { durable = value; }, set acceptDispatch(value: boolean) { acceptDispatch = value; },
    set acceptRelease(value: boolean) { acceptRelease = value; },
    set onRecovery(value: () => void) { onRecovery = value; }, set onContinue(value: () => void) { onContinue = value; } };
}


test("a model or effort edit during the hold prevents dispatch and restores native recovery", async () => {
  const h = harness();
  h.onRecovery = () => {
    h.current = { ...h.current!, modelSelection: { ...from, options: [{ id: "effort", value: "medium" }] } };
  };
  await h.start(h.make());
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0);
  assert.equal(h.current!.limitRecovery!.autoResume, true);
});
test("an expired uncertain dispatch checks delivery and releases instead of sending again", async () => {
  const h = harness();
  h.onContinue = () => { throw new Error("uncertain"); };
  await assert.rejects(h.start(h.make()));
  const intent = [...h.state.switches.values()][0]!;
  (intent as { expiresAt: number }).expiresAt = 0;
  h.calls.length = 0;
  await h.start(h.make());
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0);
  assert.equal(intent.phase, "cancelled");
  assert.equal(h.current!.limitRecovery!.autoResume, true);
});
test("resetless, delegated and scheduled stops use the same manual continuation path", async () => {
  for (const relationship of [null, "subagent"] as const) {
    const h = harness();
    h.current = { ...h.current!, usageLimitResetAt: null, relationshipToParent: relationship };
    await h.start(h.make());
    assert.equal(h.calls.filter((c) => c.kind === "recovery").length, 0);
    assert.equal(h.calls.filter((c) => c.kind === "continue").length, 1);
    assert.equal(h.records[0]!.subagent, relationship === "subagent");
  }
});

test("defaults route all three pairs in both directions and preserve a supported effort", () => {
  assert.equal(switchConfig().enabled, false);
  for (const [claude, codex] of DEFAULT_EQUIVALENCES) {
    const target = equivalentTarget({ ...from, model: claude }, [provider("codex", codex)], config)!;
    assert.equal(target.model, codex);
    assert.deepEqual(target.options, [{ id: "reasoningEffort", value: "high" }]);
    assert.deepEqual(equivalentTarget(target, [provider("claudeAgent", claude, "effort")], config),
      { ...from, model: claude });
  }
});
test("configuration replaces defaults and rejects ambiguous, invalid and oversized maps", () => {
  assert.equal(switchConfig({ equivalences: [["c", "g"]] }).equivalences.length, 1);
  for (const raw of [null, [], { enabled: "yes" }, { equivalences: [["c"]] },
    { equivalences: [["c", "g"], ["c", "x"]] }, { equivalences: [[" ", "g"]] },
    { equivalences: Array(129).fill(["c", "g"]) }]) assert.throws(() => switchConfig(raw));
});
test("quota admission requires healthy authenticated installed instances and known nonempty windows", () => {
  const p = provider();
  assert.equal(hasQuota(p), true);
  const bad: Array<SwitchProvider | undefined> = [undefined, { ...p, enabled: false }, { ...p, installed: false },
    { ...p, status: "warning" }, { ...p, status: "error" }, { ...p, availability: "unavailable" },
    { ...p, auth: { status: "unknown" } }, { ...p, usageLimits: { checkedAt: "", windows: [] } },
    { ...p, usageLimits: { checkedAt: "", windows: [{ usedPercent: 100 }] } },
    { ...p, usageLimits: { checkedAt: "", windows: [{ usedPercent: NaN }] } },
    { ...p, usageLimits: { checkedAt: "", windows: [{ usedPercent: 1 }], unavailable: true } }];
  const { usageLimits, ...unknown } = p; bad.push(unknown);
  for (const value of bad) assert.equal(hasQuota(value), false);
});
test("routing requires exact live model, correct driver, and supported target effort", () => {
  assert.equal(equivalentTarget(from, [provider("codex", "other")], config), null);
  assert.equal(equivalentTarget(from, [{ ...provider(), driver: "other" }], config), null);
  assert.equal(equivalentTarget({ ...from, options: [{ id: "effort", value: "max" }] }, [provider()], config), null);
  assert.equal(equivalentTarget({ ...from, instanceId: "other" }, [provider()], config), null);
  assert.equal(equivalentTarget({ ...from, model: "unmapped" }, [provider()], config), null);
});
test("IDs are deterministic, bounded and unambiguous for thread/run tuples", () => {
  assert.deepEqual(switchIds("a", "b"), switchIds("a", "b"));
  assert.notEqual(switchIds("a:b", "c").dispatch, switchIds("a", "b:c").dispatch);
  assert.notEqual(switchIds("a", "b").hold, switchIds("a", "b").release);
  assert.equal(switchIds("x".repeat(1000), "r").dispatch.length, 88);
});
test("switching waits for synchronization, holds exact recovery, then sends one guarded continuation", async () => {
  const h = harness(), s = h.make();
  await s.handle(h.event()); assert.equal(h.calls.length, 0);
  await s.handle({ kind: "synchronized" }); await s.handle(h.event());
  assert.deepEqual(h.calls.map((c) => c.kind), ["recovery", "continue"]);
  assert.equal(h.calls[0]!.input.autoResume, false);
  assert.equal(h.calls[0]!.input.runId, "run-a");
  assert.equal(h.records.length, 1); assert.equal(h.records[0]!.kind, "provider_switched");
});
test("default off, unavailable targets, pending, settled and other failures leave native recovery untouched", async () => {
  const h = harness(); await h.start(h.make(false)); assert.equal(h.calls.length, 0);
  for (const patch of [{ pendingRequest: true }, { settled: true }, { status: "idle" }, { activeRunId: "active" }]) {
    const t = harness(); t.current = { ...t.current!, ...patch }; await t.start(t.make()); assert.equal(t.calls.length, 0);
  }
  const t = harness(); t.port.catalog = async () => ({ providers: [], autoResume: true });
  await t.start(t.make()); assert.equal(t.calls.length, 0);
});
test("guard rejection releases our hold and does not emit a switch", async () => {
  const h = harness(); h.acceptDispatch = false; await h.start(h.make());
  assert.deepEqual(h.calls.map((c) => [c.kind, c.input.autoResume]), [["recovery", false], ["continue", undefined], ["recovery", true]]);
  assert.equal(h.records.length, 0);
  assert.equal([...h.state.switches.values()][0]!.phase, "cancelled");
});
test("a temporarily rejected release stays durable and retries on a later thread event", async () => {
  const h = harness(); h.acceptDispatch = false; h.acceptRelease = false;
  const s = h.make(); await h.start(s);
  assert.equal([...h.state.switches.values()][0]!.phase, "releasing");
  const rejectedReleaseId = h.calls.at(-1)!.input.commandId;
  h.acceptRelease = true; await s.handle(h.event());
  assert.notEqual(h.calls.at(-1)!.input.commandId, rejectedReleaseId, "T3 caches rejected command IDs");
  assert.equal([...h.state.switches.values()][0]!.phase, "cancelled");
});
test("release preserves a human recovery choice that superseded the observer hold", async () => {
  const h = harness(); h.acceptDispatch = false;
  h.onContinue = () => { h.current = { ...h.current!, limitRecovery: { runId: "run-a", resetAt: h.current!.usageLimitResetAt!, autoResume: false, requestId: "human" } }; };
  await h.start(h.make());
  assert.equal(h.calls.filter((c) => c.kind === "recovery").length, 1);
  assert.equal(h.current!.limitRecovery!.requestId, "human");
});
test("a failed intent save prevents all side effects", async () => {
  const h = harness(); h.durable = false;
  await assert.rejects(h.start(h.make()), /not durable/); assert.equal(h.calls.length, 0);
});
test("missing operate scope logs once and keeps consuming events; new credential permits retry", async () => {
  const h = harness(); h.port.recovery = async () => { throw new AuthenticationError("forbidden"); };
  const s = h.make(); await h.start(s); await s.handle(h.event());
  assert.equal(h.logs.length, 1);
  s.reconnect(h.port, false); await h.start(s); assert.equal(h.logs.length, 1);
  s.reconnect(h.port, true); await h.start(s); assert.equal(h.logs.length, 2);
});
test("restart after a lost hold response reuses the hold ID before exactly one continuation", async () => {
  const h = harness(); let first = true;
  h.onRecovery = () => { if (first) { first = false; throw new Error("lost hold response"); } };
  await assert.rejects(h.start(h.make()), /lost hold/);
  await h.start(h.make());
  assert.equal(h.calls.filter((c) => c.kind === "continue").length, 1);
  assert.equal(h.calls[0]!.input.commandId, h.calls[1]!.input.commandId);
});
test("restart after a lost dispatch response retries identical payload and claims one switch", async () => {
  const h = harness(); let first = true;
  h.onContinue = () => { if (first) { first = false; throw new Error("lost dispatch response"); } };
  await assert.rejects(h.start(h.make()), /lost dispatch/);
  h.current = { ...h.current!, latestRunId: "continued", status: "idle", providerInstanceId: "codex" };
  await h.start(h.make());
  const sends = h.calls.filter((c) => c.kind === "continue");
  assert.equal(sends.length, 2); assert.deepEqual(sends[0]!.input, sends[1]!.input);
  assert.equal(h.records.length, 1);
  const records = observe(h.state, { kind: "snapshot", sequence: 2, threads: [h.current] }, Date.now());
  assert.equal(records.filter((r) => r.kind === "quota_resumed").length, 0);
});
test("expired or stale holding intent releases without dispatch and active intents survive pruning", async () => {
  const h = harness(); let first = true;
  h.onRecovery = () => { if (first) { first = false; throw new Error("crash"); } };
  await assert.rejects(h.start(h.make()));
  const intent = [...h.state.switches.values()][0]!;
  (intent as { expiresAt: number }).expiresAt = 0;
  prune(h.state, Date.now() + KEY_TTL_MS * 2); assert.equal(h.state.switches.size, 1);
  await h.start(h.make()); assert.equal(h.calls.filter((c) => c.kind === "continue").length, 0);
});
test("switch intents have bounded admission and completed records expire", async () => {
  const h = harness(); await h.start(h.make());
  const intent = [...h.state.switches.values()][0]!;
  prune(h.state, intent.createdAt + KEY_TTL_MS + 1); assert.equal(h.state.switches.size, 0);
  assert.equal(h.state.evictedThrough, intent.stopAt);
  for (let i = 0; i < MAX_ACTIVE_SWITCHES; i++) h.state.switches.set(String(i), { ...intent, threadId: String(i), phase: "releasing" } as SwitchIntent);
  h.state.evictedThrough = null;
  h.port.thread = async (threadId) => ({ ...h.current!, id: threadId, latestRunId: "run-a", pendingRequest: true,
    limitRecovery: { runId: "run-a", resetAt: intent.resetAt!, autoResume: false, requestId: switchIds(threadId, "run-a").hold } });
  h.calls.length = 0;
  await h.start(h.make());
  assert.equal(h.state.switches.size, MAX_ACTIVE_SWITCHES);
  assert.equal(h.calls.length, 0, "full intent slots leave the next stop on native recovery");
  h.state.switches.clear();
  for (let i = 0; i < 1_200; i++) h.state.switches.set(String(i), { ...intent, createdAt: Date.now() + i });
  prune(h.state, Date.now()); assert.equal(h.state.switches.size, 1_000);
});
