// Synthetic fixed-preset sessions through the real wait engine and WakeStore, with a
// fake official T3 (launchThread, thread projection, wake dispatch). This proves the
// local lifecycle only: no real T3, provider, Authentik or Jocasta ACL is involved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine, type EngineOptions } from "../../src/waits/engine.ts";
import { parsePolicy, type SessionPolicy } from "../../src/session/policy.ts";
import { finalAssistant, type LaunchResult, type SessionT3 } from "../../src/session/t3.ts";
import { scratchDir, SCRATCH_ROOT } from "../helpers/scratch.ts";
import type { WaitT3, WaitSnapshot, WaitRun } from "../../src/t3/waits.ts";

function insideScratch(path: string): boolean {
  const rel = relative(resolve(SCRATCH_ROOT), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(probe: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!probe()) { if (Date.now() > end) throw new Error("Timed out"); await sleep(10); }
}
const GRANTS = [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get", "history", "list", "search"] }] }];
function preset(over: Record<string, unknown> = {}) {
  return { instanceId: "reporter-instance", model: "reporter-model", runtimeMode: "approval-required", interactionMode: "default",
    projectId: "reporter-project", title: "Jocasta projectA reporter", prompt: "Report projectA status with citations.",
    inputs: { scope: "status" }, project: "projectA", services: GRANTS, maxSeconds: 600, delegate: false,
    destinations: ["caller-project"], ...over };
}
const CEILING = { project: "projectA", maxSeconds: 3600, services: GRANTS, destinations: ["caller-project"] };
function policy(presets: Record<string, unknown> = { reporter: preset(), short: preset({ maxSeconds: 2 }) }, ceilings: unknown[] = [CEILING]): SessionPolicy {
  return parsePolicy({ version: 1, environment: "env", presets, ceilings }, "env");
}
type Lineage = { parent: string | null; root: string };
function thread(id: string, project: string, lineage?: Lineage): WaitSnapshot {
  return { id, project, archived: false, deleted: false, settled: false, runs: [], pendingRuns: [], children: [],
    lineage: lineage ?? { parent: null, root: id } };
}
function run(id: string, message: string, ordinal = 1): WaitRun {
  return { id, ordinal, status: "running", started: new Date(Date.now() + ordinal).toISOString(), workStarted: null,
    restartOf: null, failure: null, root: "node-root-" + id, message };
}
type TurnItem = { type: string; id: string; threadId: string; runId: string | null; nodeId: string | null; ordinal: number; streaming?: boolean; text?: string };
class FakeT3 {
  mode: "accept" | "hang" | "lost" | "lost_absent" | "reject" | "offline" = "accept";
  threads = new Map<string, WaitSnapshot>();
  items = new Map<string, TurnItem[]>();
  launches: string[] = [];
  wakes: string[] = [];
  wakeOffline = false;
  private listeners = new Map<string, Set<(s: WaitSnapshot | null) => void>>();
  private seq = 0;
  constructor() { this.put(thread("caller", "caller-project")); }
  put(s: WaitSnapshot) { this.threads.set(s.id, s); for (const l of this.listeners.get(s.id) ?? []) l(s); }
  get(id: string): WaitSnapshot { const s = this.threads.get(id); if (!s) throw new Error("fake thread " + id); return s; }
  run(threadId: string, patch: Partial<WaitRun>, index = 0) {
    const s = this.get(threadId);
    this.put({ ...s, runs: s.runs.map((r, i) => i === index ? { ...r, ...patch } : r) });
  }
  say(threadId: string, text: string, options: { node?: string; index?: number; streaming?: boolean } = {}) {
    const r = this.get(threadId).runs[options.index ?? 0]!, list = this.items.get(threadId) ?? [];
    list.push({ type: "assistant_message", id: "item-" + list.length, threadId, runId: r.id, nodeId: options.node ?? r.root,
      ordinal: list.length, streaming: options.streaming ?? false, text });
    this.items.set(threadId, list);
  }
  waits: WaitT3 = {
    environment: async () => "env",
    snapshot: async id => this.threads.get(id) ?? null,
    observe: async (id, signal, on) => {
      const listener = (s: WaitSnapshot | null) => { if (!signal.aborted) on(s, ++this.seq); };
      const set = this.listeners.get(id) ?? new Set(); set.add(listener); this.listeners.set(id, set);
      await Promise.resolve(); listener(this.threads.get(id) ?? null);
      await new Promise<void>(r => signal.addEventListener("abort", () => r(), { once: true }));
      set.delete(listener);
    },
    dispatch: async payload => { if (this.wakeOffline) throw new Error("T3 offline"); this.wakes.push(payload); },
  };
  sessions: SessionT3 = {
    launch: async (payload): Promise<LaunchResult> => {
      this.launches.push(payload);
      const input = JSON.parse(payload);
      if (this.mode === "reject") return { kind: "rejected", detail: "project not found" };
      if (this.mode === "offline") return { kind: "not_sent", detail: "TransientConnectionError" };
      // The server processes the command (creating the thread) before any lost answer.
      if (this.mode !== "lost_absent")
        this.put({ ...thread(input.threadId, input.projectId), runs: [run("run-" + this.launches.length, input.initialMessage.messageId)] });
      if (this.mode === "hang") return new Promise<LaunchResult>(() => {});
      if (this.mode === "lost" || this.mode === "lost_absent") throw new Error("socket closed after write");
      return { kind: "accepted", threadId: input.threadId, resumed: false };
    },
    result: async (threadId, runId) => {
      const s = this.get(threadId);
      return finalAssistant({ thread: { id: threadId }, runs: s.runs.map(r => ({ id: r.id, threadId, rootNodeId: r.root })),
        turnItems: this.items.get(threadId) ?? [] }, threadId, runId);
    },
  };
}
function fixture(name: string) {
  const dir = scratchDir("session-" + name), path = join(dir.path, "waits.sqlite");
  assert.ok(insideScratch(dir.path), "fixture writes stay in test scratch: " + dir.path + " under " + SCRATCH_ROOT);
  const t3 = new FakeT3(), ref: { policy: SessionPolicy | null } = { policy: policy() };
  let store = new WakeStore(path, "env"), engine!: WaitEngine;
  const make = (extra: Partial<EngineOptions> = {}) => {
    engine = new WaitEngine(store, t3.waits, { sessions: { policy: () => ref.policy, t3: t3.sessions, launchWaitMs: 200 }, ...extra });
    engine.start();
  };
  make();
  return {
    t3, ref, get store() { return store; }, get engine() { return engine; },
    async restart(extra: Partial<EngineOptions> = {}, down?: () => Promise<void>) {
      await engine.stop(); store.close(); await down?.(); store = new WakeStore(path, "env"); make(extra);
    },
    async close() { await engine.stop(); store.close(); dir.remove(); },
  };
}
let counter = 0;
const key = () => Date.now() + ":session-" + ++counter;
type Fixture = ReturnType<typeof fixture>;
const start = (f: Fixture, over: Record<string, unknown> = {}) =>
  f.engine.startSession({ threadId: "caller", requestId: key(), preset: "reporter", ...over });
const complete = (f: Fixture, threadId: string, status = "completed") => f.t3.run(threadId, { status });
const wake = (f: Fixture, id: string) => f.store.deliveries().filter(d => d.item === id && d.channel === "wake");

test("fixed preset launches once through the official seam; root result is stored exactly and wakes once after restart", async () => {
  const f = fixture("e2e");
  try {
    const requestId = key();
    const s = await f.engine.startSession({ threadId: "caller", requestId, preset: "reporter" });
    assert.equal(s.launch, "accepted"); assert.equal(s.state, "parked"); assert.equal(s.occupancy, "held");
    assert.equal(f.t3.launches.length, 1);
    const launch = JSON.parse(f.t3.launches[0]!);
    assert.deepEqual(Object.keys(launch).sort(), ["commandId", "creationSource", "initialMessage", "interactionMode", "modelSelection",
      "projectId", "runtimeMode", "threadId", "title", "workspaceStrategy"]);
    assert.equal(launch.commandId, "chaldea-session:" + s.sessionId + ":launch");
    assert.equal(launch.threadId, s.threadId);
    assert.deepEqual(launch.modelSelection, { instanceId: "reporter-instance", model: "reporter-model" });
    assert.deepEqual(launch.workspaceStrategy, { type: "root" });
    assert.equal(launch.initialMessage.text, 'Report projectA status with citations.\n\nFixed inputs (JSON): {"scope":"status"}');
    // Same requestId and arguments: same session, no second launch. Changed arguments are refused.
    assert.equal((await f.engine.startSession({ threadId: "caller", requestId, preset: "reporter" })).sessionId, s.sessionId);
    await assert.rejects(f.engine.startSession({ threadId: "caller", requestId, preset: "short" }), /changed payload/);
    assert.equal(f.t3.launches.length, 1);
    // A native child shares the run but not the root node; its later output must not become the result.
    const exact = "projectA: 3 open items [doc:a@4] — ok ✓\n\tend";
    f.t3.say(s.threadId, "draft"); f.t3.say(s.threadId, exact);
    f.t3.say(s.threadId, "CHILD OUTPUT", { node: "node-native-child" });
    f.t3.put({ ...f.t3.get(s.threadId), children: [{ id: "node-native-child", runId: "run-1", childThreadId: "child-thread", status: "completed" }] });
    f.t3.wakeOffline = true;
    complete(f, s.threadId);
    await until(() => f.engine.sessionStatus(s.sessionId).state === "resolved");
    const done = f.engine.sessionStatus(s.sessionId);
    assert.equal(done.result, exact); assert.equal(done.resultState, "stored");
    assert.deepEqual(done.outcome, { reason: "succeeded", runId: "run-1", bytes: Buffer.byteLength(exact), wake: "result_embedded" });
    await until(() => f.engine.sessionStatus(s.sessionId).occupancy === "released");
    assert.equal(f.engine.sessionStatus(s.sessionId).released, "runtime_stopped");
    assert.equal(f.t3.wakes.length, 0);
    // Restart before delivery: the stored wake is delivered exactly once with the same bytes.
    await f.restart(); f.t3.wakeOffline = false;
    await until(() => wake(f, s.sessionId)[0]?.state === "sent");
    await sleep(100);
    assert.equal(f.t3.wakes.length, 1); assert.equal(wake(f, s.sessionId).length, 1);
    const sent = JSON.parse(f.t3.wakes[0]!);
    assert.equal(sent.threadId, "caller"); assert.equal(sent.commandId, "chaldea-session:" + s.sessionId + ":wake");
    assert.ok(sent.text.includes("\n" + exact + "\n")); assert.ok(!sent.text.includes("CHILD OUTPUT"));
    assert.equal(f.engine.sessionStatus(s.sessionId).result, exact);
    assert.equal(f.t3.launches.length, 1);
  } finally { await f.close(); }
});

test("broader, unknown, explicit, misdirected, nondelegating and busy starts are refused before launch", async () => {
  const f = fixture("refusals");
  try {
    f.ref.policy = policy({
      reporter: preset(), long: preset({ maxSeconds: 7200 }), writer: preset({ services: [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get", "put"] }] }] }),
      other: preset({ services: [{ audience: "jocasta", grants: [{ resource: "project:projectB", actions: ["get"] }] }] }),
      akasha: preset({ services: [{ audience: "akasha", grants: [{ resource: "feed", actions: ["read"] }] }] }),
      delegating: preset({ delegate: true }), wide: preset({ destinations: ["caller-project", "elsewhere"] }),
    });
    const refused = async (over: Record<string, unknown>, pattern: RegExp) => await assert.rejects(start(f, over), pattern);
    await refused({ preset: "missing" }, /unknown_preset/);
    await refused({ maxSeconds: 60 }, /unsupported_reduction/);
    await refused({ services: [] }, /unsupported_reduction/);
    await refused({ extra: 1 }, /unsupported_field/);
    await refused({ preset: "long" }, /preset_exceeds_ceiling/);
    await refused({ preset: "other" }, /preset_exceeds_ceiling/);
    await refused({ preset: "wide" }, /preset_exceeds_ceiling/);
    await refused({ preset: "writer" }, /unsupported_grant/);
    await refused({ preset: "akasha" }, /unsupported_audience/);
    await refused({ preset: "delegating" }, /delegation_unsupported/);
    f.t3.put(thread("foreign", "other-project"));
    await refused({ threadId: "foreign" }, /destination_not_allowed/);
    f.t3.put({ ...thread("archived", "caller-project"), archived: true });
    await refused({ threadId: "archived" }, /caller_inactive/);
    assert.equal(f.t3.launches.length, 0);
    const s = await start(f);
    assert.equal(f.t3.launches.length, 1);
    // The reporter itself, a native child thread and a deeper descendant are limited lineage.
    f.t3.put(thread("native-child", "caller-project", { parent: s.threadId, root: s.threadId }));
    // The grandchild's root claim is wrong on purpose: the parent walk still finds the session.
    f.t3.put(thread("grandchild", "caller-project", { parent: "native-child", root: "native-child" }));
    f.ref.policy = policy({ reporter: preset(), second: preset() });
    for (const threadId of [s.threadId, "native-child", "grandchild"]) await refused({ threadId, preset: "second" }, /caller_not_delegating/);
    await refused({}, /preset_busy/);
    f.ref.policy = null;
    await refused({ preset: "second" }, /sessions_disabled/);
    assert.equal(f.t3.launches.length, 1);
  } finally { await f.close(); }
});

test("uncertain dispatch and crashes reconcile the known thread and never launch a second reporter", async () => {
  const f = fixture("uncertain");
  try {
    // Lost answer after the server processed the command: uncertain, then observed.
    f.t3.mode = "lost";
    const lost = await start(f);
    assert.ok(["uncertain", "accepted"].includes(lost.launch));
    await until(() => f.engine.sessionStatus(lost.sessionId).launch === "accepted");
    complete(f, lost.threadId, "failed");
    await until(() => f.engine.sessionStatus(lost.sessionId).occupancy === "released");
    assert.equal(f.t3.launches.length, 1);
    // Crash while the launch RPC is in flight: restart treats it as uncertain and never resends.
    f.t3.mode = "hang";
    const hung = await start(f);
    assert.equal(hung.launch, "dispatching");
    await f.restart(); f.t3.mode = "accept";
    await until(() => f.engine.sessionStatus(hung.sessionId).launch === "accepted");
    assert.equal(f.t3.launches.length, 2);
    complete(f, hung.threadId, "cancelled");
    await until(() => f.engine.sessionStatus(hung.sessionId).occupancy === "released");
    // Crash after commit and before dispatch: nothing was sent, so the restarted service sends it once.
    const requestId = key();
    await f.restart({ boundary: (name: string) => { if (name === "session_committed") throw new Error("crash"); } });
    await assert.rejects(f.engine.startSession({ threadId: "caller", requestId, preset: "reporter" }), /crash/);
    assert.equal(f.t3.launches.length, 2);
    await f.restart();
    await until(() => f.t3.launches.length === 3);
    const again = await f.engine.startSession({ threadId: "caller", requestId, preset: "reporter" });
    await until(() => f.engine.sessionStatus(again.sessionId).launch === "accepted");
    assert.equal(f.t3.launches.length, 3);
    complete(f, again.threadId, "failed");
    await until(() => f.engine.sessionStatus(again.sessionId).occupancy === "released");
    // T3 offline before the request is written: retried later with the identical bytes.
    f.t3.mode = "offline";
    const offline = await start(f);
    assert.equal(offline.launch, "intent");
    f.t3.mode = "accept";
    await until(() => f.engine.sessionStatus(offline.sessionId).launch === "accepted");
    assert.equal(f.t3.launches.at(-1), f.t3.launches.at(-2));
    complete(f, offline.threadId, "failed");
    await until(() => f.engine.sessionStatus(offline.sessionId).occupancy === "released");
    // Lost answer and no thread: still uncertain at the deadline, the slot stays held, no relaunch.
    f.t3.mode = "lost_absent";
    const absent = await start(f, { preset: "short" });
    const launches = f.t3.launches.length;
    await until(() => f.engine.sessionStatus(absent.sessionId).state === "resolved");
    const status = f.engine.sessionStatus(absent.sessionId);
    assert.equal((status.outcome as { reason: string }).reason, "launch_uncertain");
    assert.equal(status.occupancy, "held"); assert.equal(status.launch, "uncertain");
    f.t3.mode = "accept";
    await assert.rejects(start(f, { preset: "short" }), /preset_busy/);
    assert.equal((await f.engine.reconcileSession(absent.sessionId)).occupancy, "held");
    assert.deepEqual(f.engine.authorizeIssue("short", "jocasta"), { ok: false, refusal: "run_inactive" });
    assert.equal(f.t3.launches.length, launches);
  } finally { await f.close(); }
});

test("a surviving reporter keeps its preset quarantined after deadline and cancel; issuance never crosses runs", async () => {
  const f = fixture("quarantine");
  try {
    const a = await start(f, { preset: "short" });
    const grant = f.engine.authorizeIssue("short", "jocasta");
    if (!grant.ok) throw new Error(grant.refusal);
    assert.equal(grant.runId, a.sessionId); assert.equal(grant.threadId, a.threadId);
    assert.deepEqual(grant.grants, GRANTS[0]!.grants);
    await until(() => f.engine.sessionStatus(a.sessionId).state === "resolved");
    assert.equal((f.engine.sessionStatus(a.sessionId).outcome as { reason: string }).reason, "deadline");
    // The old root still runs: no issuance for it and no new run that a preset-bound helper could serve.
    assert.equal(f.engine.sessionStatus(a.sessionId).occupancy, "held");
    assert.deepEqual(f.engine.authorizeIssue("short", "jocasta"), { ok: false, refusal: "run_inactive" });
    await assert.rejects(start(f, { preset: "short" }), /preset_busy/);
    assert.equal((await f.engine.reconcileSession(a.sessionId)).occupancy, "held");
    // Logical cancel/deadline and retention cannot free the slot; only runtime evidence does.
    f.store.maintain(Date.now() + 50 * 86_400_000);
    assert.equal(f.engine.sessionStatus(a.sessionId).occupancy, "held");
    f.t3.say(a.threadId, "late report");
    complete(f, a.threadId);
    await until(() => f.engine.sessionStatus(a.sessionId).occupancy === "released");
    const late = f.engine.sessionStatus(a.sessionId);
    assert.equal((late.outcome as { reason: string }).reason, "deadline"); assert.equal(late.result, null);
    const b = await start(f, { preset: "short" });
    const next = f.engine.authorizeIssue("short", "jocasta");
    if (!next.ok) throw new Error(next.refusal);
    assert.equal(next.runId, b.sessionId); assert.notEqual(next.threadId, a.threadId);
    // Cancel: issuance stops at once; a second run typed into the reporter thread keeps the slot held.
    f.engine.cancelSession(b.sessionId);
    assert.deepEqual(f.engine.authorizeIssue("short", "jocasta"), { ok: false, refusal: "run_inactive" });
    const t = f.t3.get(b.threadId);
    f.t3.put({ ...t, runs: [...t.runs, run("human-run", "typed-by-someone", 2)] });
    complete(f, b.threadId);
    await sleep(200);
    assert.equal(f.engine.sessionStatus(b.sessionId).occupancy, "held");
    await assert.rejects(start(f, { preset: "short" }), /preset_busy/);
    f.t3.run(b.threadId, { status: "completed" }, 1);
    await until(() => f.engine.sessionStatus(b.sessionId).occupancy === "released");
    assert.equal((f.engine.sessionStatus(b.sessionId).outcome as { reason: string }).reason, "operator_cancelled");
    assert.equal(wake(f, a.sessionId).length, 1); assert.equal(wake(f, b.sessionId).length, 1);
  } finally { await f.close(); }
});

test("failed, rejected, deleted and child-only outcomes carry no misleading success", async () => {
  const f = fixture("outcomes");
  try {
    const reason = (id: string) => (f.engine.sessionStatus(id).outcome as { reason: string } | null)?.reason;
    const failed = await start(f);
    f.t3.say(failed.threadId, "partial text");
    complete(f, failed.threadId, "failed");
    await until(() => reason(failed.sessionId) === "failed");
    assert.equal(f.engine.sessionStatus(failed.sessionId).result, null);
    await until(() => f.engine.sessionStatus(failed.sessionId).occupancy === "released");
    // Only a native child spoke: the root has no final message, so no result is invented.
    const child = await start(f);
    f.t3.say(child.threadId, "CHILD ONLY", { node: "node-native-child" });
    complete(f, child.threadId);
    await until(() => reason(child.sessionId) === "result_unavailable");
    assert.equal(f.engine.sessionStatus(child.sessionId).result, null);
    await until(() => f.engine.sessionStatus(child.sessionId).occupancy === "released");
    // A typed rejection is definitive; the slot is freed once T3 shows no such thread.
    f.t3.mode = "reject";
    const rejected = await start(f);
    assert.equal(rejected.launch, "rejected"); assert.equal(reason(rejected.sessionId), "launch_rejected");
    await until(() => f.engine.sessionStatus(rejected.sessionId).occupancy === "released");
    f.t3.mode = "accept";
    const deleted = await start(f);
    f.t3.put({ ...f.t3.get(deleted.threadId), deleted: true });
    await until(() => reason(deleted.sessionId) === "thread_deleted");
    await until(() => f.engine.sessionStatus(deleted.sessionId).occupancy === "released");
    for (const id of [failed.sessionId, child.sessionId, rejected.sessionId, deleted.sessionId]) {
      await until(() => wake(f, id)[0]?.state === "sent");
      assert.equal(wake(f, id).length, 1);
    }
    const texts = f.t3.wakes.map(p => JSON.parse(p).text as string);
    assert.ok(texts.every(t => !t.includes("stored result")));
    assert.ok(!texts.some(t => t.includes("CHILD ONLY") || t.includes("partial text")));
  } finally { await f.close(); }
});

test("edited, removed and wrong-audience presets refuse issuance; terminal runs refuse it too", async () => {
  const f = fixture("gate");
  try {
    assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "no_active_run" });
    const s = await start(f);
    assert.ok(f.engine.authorizeIssue("reporter", "jocasta").ok);
    assert.deepEqual(f.engine.authorizeIssue("reporter", "akasha"), { ok: false, refusal: "audience_not_admitted" });
    assert.deepEqual(f.engine.authorizeIssue("reporter", "nope"), { ok: false, refusal: "invalid_audience" });
    const original = f.ref.policy;
    f.ref.policy = policy({ reporter: preset({ prompt: "Report projectA and more." }), short: preset({ maxSeconds: 2 }) });
    assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "preset_changed" });
    f.ref.policy = policy({ short: preset({ maxSeconds: 2 }) });
    assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "preset_removed" });
    // The preset is unchanged but the admitting ceiling narrows or disappears: issuance stops.
    const presets = { reporter: preset(), short: preset({ maxSeconds: 2 }) };
    const narrowed = (over: Record<string, unknown>) => policy(presets, [{ ...CEILING, ...over }]);
    for (const p of [
      narrowed({ services: [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get", "list", "search"] }] }] }),
      narrowed({ services: [{ audience: "jocasta", grants: [{ resource: "project:projectB", actions: ["get", "history", "list", "search"] }] }] }),
      narrowed({ maxSeconds: 300 }),
      narrowed({ destinations: ["elsewhere"] }),
      narrowed({ project: "projectB" }),
    ]) {
      f.ref.policy = p;
      assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "preset_exceeds_ceiling" });
    }
    // A compatible ceiling and unrelated policy edits keep issuance working.
    f.ref.policy = policy({ reporter: preset(), other: preset({ title: "other" }) }, [
      { ...CEILING, project: "projectB" }, { ...CEILING, maxSeconds: 600, destinations: ["caller-project", "elsewhere"] }]);
    assert.ok(f.engine.authorizeIssue("reporter", "jocasta").ok);
    f.ref.policy = original;
    assert.ok(f.engine.authorizeIssue("reporter", "jocasta").ok);
    assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta", Date.parse(s.deadline)), { ok: false, refusal: "run_expired" });
    f.t3.say(s.threadId, "done");
    complete(f, s.threadId);
    await until(() => f.engine.sessionStatus(s.sessionId).state === "resolved");
    assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "no_active_run" });
    f.ref.policy = null;
    assert.deepEqual(f.engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "sessions_disabled" });
  } finally { await f.close(); }
});

test("a completion first seen after the deadline is a deadline outcome; a timely one still reads its result late", async () => {
  const f = fixture("overdue");
  try {
    // Service down across the deadline while the root completes: no success and no result.
    const a = await start(f, { preset: "short" });
    await f.restart({}, async () => {
      f.t3.say(a.threadId, "finished while the service was down");
      complete(f, a.threadId);
      await sleep(Date.parse(a.deadline) - Date.now() + 50);
    });
    await until(() => f.engine.sessionStatus(a.sessionId).occupancy === "released");
    const late = f.engine.sessionStatus(a.sessionId);
    assert.equal((late.outcome as { reason: string }).reason, "deadline"); assert.equal(late.result, null);
    await until(() => wake(f, a.sessionId)[0]?.state === "sent");
    assert.ok(!f.t3.wakes.some(p => JSON.parse(p).text.includes("finished while the service was down")));
    // Completed before the deadline, but the result read fails until after it: still a success.
    const read = f.t3.sessions.result;
    let deadline = Infinity;
    f.t3.sessions.result = async (threadId, runId) => {
      if (Date.now() < deadline + 100) throw new Error("projection unavailable");
      return read(threadId, runId);
    };
    const b = await start(f, { preset: "short" });
    deadline = Date.parse(b.deadline);
    f.t3.say(b.threadId, "timely report");
    complete(f, b.threadId);
    await until(() => f.engine.sessionStatus(b.sessionId).state === "resolved");
    const timely = f.engine.sessionStatus(b.sessionId);
    assert.ok(Date.now() > deadline);
    assert.equal((timely.outcome as { reason: string }).reason, "succeeded"); assert.equal(timely.result, "timely report");
    f.t3.sessions.result = read;
    // A cancel while the timely read is in flight wins; the late read cannot overwrite it.
    let release!: () => void;
    f.t3.sessions.result = async (threadId, runId) => { await new Promise<void>(r => { release = r; }); return read(threadId, runId); };
    await until(() => f.engine.sessionStatus(b.sessionId).occupancy === "released");
    const c = await start(f, { preset: "short" });
    f.t3.say(c.threadId, "raced report");
    complete(f, c.threadId);
    await until(() => release !== undefined);
    f.engine.cancelSession(c.sessionId);
    release();
    await sleep(100);
    const raced = f.engine.sessionStatus(c.sessionId);
    assert.equal((raced.outcome as { reason: string }).reason, "operator_cancelled"); assert.equal(raced.result, null);
    f.t3.sessions.result = read;
  } finally { await f.close(); }
});

test("launch retries and ambiguous result reads have separate budgets", async () => {
  const f = fixture("budgets");
  try {
    f.t3.mode = "offline";
    const s = await start(f);
    assert.equal(s.launch, "intent");
    await until(() => f.t3.launches.length === 3);
    f.t3.mode = "accept";
    await until(() => f.engine.sessionStatus(s.sessionId).launch === "accepted");
    assert.equal(f.t3.launches.length, 4);
    // Three ambiguous reads are retried even after three not_sent launch attempts.
    const read = f.t3.sessions.result;
    let reads = 0;
    f.t3.sessions.result = async (threadId, runId) => ++reads <= 3 ? { kind: "ambiguous", detail: "two final messages" } : read(threadId, runId);
    f.t3.say(s.threadId, "report after retries");
    complete(f, s.threadId);
    await until(() => f.engine.sessionStatus(s.sessionId).state === "resolved");
    const done = f.engine.sessionStatus(s.sessionId);
    assert.equal((done.outcome as { reason: string }).reason, "succeeded"); assert.equal(done.result, "report after retries");
    assert.equal(reads, 4);
  } finally { await f.close(); }
});

test("result bounds: exact bytes, pointer-only wake within 4096, oversize and invalid store nothing", async () => {
  const f = fixture("sizes");
  try {
    const cases: Array<[string, string, string]> = [
      ["a".repeat(2048), "stored", "result_embedded"],
      ["\u0001".repeat(2048), "stored", "result_in_status"],
      ["é".repeat(1024), "stored", "result_embedded"],
      ["a".repeat(2049), "result_oversize", "no_result"],
      ["bad\u0000text", "result_invalid", "no_result"],
      ["bad\ud800text", "result_invalid", "no_result"],
    ];
    for (const [text, state, delivery] of cases) {
      const s = await start(f);
      f.t3.say(s.threadId, text);
      complete(f, s.threadId);
      await until(() => f.engine.sessionStatus(s.sessionId).state === "resolved");
      await until(() => f.engine.sessionStatus(s.sessionId).occupancy === "released");
      const status = f.engine.sessionStatus(s.sessionId), outcome = status.outcome as { reason: string; wake: string; bytes: number };
      assert.equal(outcome.wake, delivery, state);
      assert.equal(outcome.bytes, Buffer.byteLength(text));
      const payload = wake(f, s.sessionId)[0]!.payload;
      assert.ok(Buffer.byteLength(payload) <= 4096);
      if (state === "stored") {
        assert.equal(status.result, text); assert.equal(outcome.reason, "succeeded");
        assert.equal(JSON.parse(payload).text.includes(text), delivery === "result_embedded");
        if (delivery === "result_in_status") assert.ok(JSON.parse(payload).text.includes("result_in_status"));
      } else {
        assert.equal(status.result, null); assert.equal(status.resultState, state); assert.equal(outcome.reason, state);
        assert.ok(f.t3.threads.has(status.threadId), "thread stays inspectable");
      }
    }
  } finally { await f.close(); }
});

test("disabled sessions leave waits and decisions unchanged and refuse starts", async () => {
  const dir = scratchDir("session-disabled"), t3 = new FakeT3();
  const store = new WakeStore(join(dir.path, "waits.sqlite"), "env"), engine = new WaitEngine(store, t3.waits, {});
  try {
    engine.start();
    await assert.rejects(engine.startSession({ threadId: "caller", requestId: key(), preset: "reporter" }), /sessions_disabled/);
    const wait = await engine.register("wait", { threadId: "caller", requestId: key(), condition: { kind: "time", at: new Date(Date.now() - 1).toISOString() } });
    await until(() => store.deliveries().find(d => d.item === wait.id)?.state === "sent");
    assert.match(JSON.parse(t3.wakes[0]!).text, /^Chaldea wake \(wait /);
    const decision = await engine.register("decision", { threadId: "caller", requestId: key(), question: "Continue?", options: ["Defer", "Continue"],
      dependentAction: "continue", defaultAction: "defer", deadline: new Date(Date.now() + 60_000).toISOString() });
    assert.equal(store.get(decision.id).state, "parked");
    assert.equal(store.liveSessions().length, 0); assert.equal(t3.launches.length, 0);
    assert.deepEqual(engine.authorizeIssue("reporter", "jocasta"), { ok: false, refusal: "sessions_disabled" });
  } finally { await engine.stop(); store.close(); dir.remove(); }
});
