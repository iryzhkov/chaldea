// First Da Vinci proof gate: the maintained admission seam against official T3.
// Synthetic provider and policy only. No Authentik enrollment or live credentials.
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { Coordinator, Worker, BODY, result, type Assignment } from "./proof.ts";
import { broker } from "./broker.ts";
import { webhook } from "./webhook.ts";
import type { SessionStatus } from "../../src/session/lifecycle.ts";
import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import { loadSessionPolicy } from "../../src/session/policy.ts";
import { createSessionT3 } from "../../src/session/t3.ts";
import { createWaitT3 } from "../../src/t3/waits.ts";
import { withClient } from "../../src/t3/adapter.ts";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { ShellWatcher, waitFor } from "../helpers/e2e.ts";
import { scratchDir } from "../helpers/scratch.ts";

for (const interrupt of [false, true]) test(`signed occurrence survives reply loss and durable reopen, restart T3 during run=${interrupt}`, { timeout: 150_000 }, async () => {
  assert.equal(t3Version(), "t3 v0.1.0", "install the pinned fixture, never skip this proof");
  assert.equal(process.getuid!(), 0, "proof runs inside the isolated Chaldea user namespace");
  const proofPath = interrupt ? "davinci-restarted.json" : "davinci-proof.json";
  writeFileSync(proofPath, JSON.stringify({ proof: "signed-occurrence", passed: false }) + "\n");
  const dir = scratchDir("davinci-admission");
  const t3 = await startDisposableT3({ scratchRoot: dir.path, scenario: "no-reset", autoResume: false,
    claudeModel: "claude-opus-5-5" });
  const token = t3.issueToken(["orchestration:read", "orchestration:operate"]);
  let watcher: ShellWatcher | undefined = new ShellWatcher(t3.serverUrl, token);
  let store: WakeStore | undefined, engine: WaitEngine | undefined;
  let bus: Awaited<ReturnType<typeof broker>> | undefined, ingress: Awaited<ReturnType<typeof webhook>> | undefined;
  let coordinator: Coordinator | undefined, worker: Worker | undefined;
  try {
    const caller = await waitFor("bootstrap caller", () => watcher!.firstThreadId(), 30_000);
    const options = () => ({ serverUrl: t3.serverUrl, token });
    const environment = String((await withClient(options(), c => c["server.getConfig"]({}))).environment.environmentId);
    const project = String((await withClient(options(), c =>
      c["orchestration.getThreadProjection"]({ threadId: caller } as never))).thread.projectId);
    const services = [{ audience: "jocasta", grants: [{ resource: "project:source-report", actions: ["get"] }] }];
    const preset = { instanceId: "claudeAgent", model: "claude-opus-5-5", runtimeMode: "approval-required",
      interactionMode: "default", projectId: project, title: "Da Vinci fixed source report fixture",
      prompt: interrupt ? "chaldea-restart-hold" : "Synthetic read-only source status for published Chaldea 1c806a18fbff6717981df40f108ef1c73927acff.",
      inputs: { scope: "status" }, project: "source-report", services, maxSeconds: 600, delegate: false,
      destinations: [project] };
    const policyPath = join(dir.path, "policy.json");
    writeFileSync(policyPath, JSON.stringify({ version: 1, environment, presets: { reporter: preset },
      ceilings: [{ project: "source-report", services, maxSeconds: 600, destinations: [project] }] }), { mode: 0o644 });
    const policy = () => loadSessionPolicy(policyPath, environment);
    assert.equal(policy().presets.reporter!.projectId, project);
    chmodSync(policyPath, 0o666);
    assert.throws(policy, /session_policy_unsafe/);
    chmodSync(policyPath, 0o644);
    const journal = join(dir.path, "waits.sqlite");
    let launches = 0;
    const actual = createSessionT3(options, environment);
    const startEngine = () => {
      store = new WakeStore(journal, environment);
      engine = new WaitEngine(store, createWaitT3(options, environment), {
        sessions: { policy, t3: { result: actual.result, launch: async payload => {
          launches++;
          const result = await actual.launch(payload);
          assert.equal(result.kind, "accepted");
          // T3 committed its thread before the worker lost the RPC answer.
          throw new Error("fixture: reply lost after T3 accepted");
        } } },
      });
      engine.start();
    };
    startEngine();
    const binding = { worker: "agent-a", environment, preset: "reporter" };
    const coordinatorPath = join(dir.path, "coordinator.sqlite"), workerPath = join(dir.path, "worker.sqlite");
    coordinator = new Coordinator(coordinatorPath, binding);
    worker = new Worker(workerPath, { ...binding, caller });
    bus = await broker(dir.path);
    let sender = await bus.client("coordinator"), receiver = await bus.client("worker");
    ingress = await webhook(() => coordinator!, randomBytes(32));
    const post = async (body = BODY, bad = false) => {
      const response = await ingress!.post("delivery-1", body, bad);
      const code = response.status, text = await response.text();
      return { code, text };
    };
    assert.equal((await post(BODY, true)).code, 403);
    assert.equal(coordinator.row("delivery-1"), undefined);
    const accepted = await post();
    assert.equal(accepted.code, 202);
    // Lose the HTTP response and reopen the coordinator from its committed journal.
    coordinator.close(); coordinator = new Coordinator(coordinatorPath, binding);
    assert.deepEqual(await post(), accepted);
    assert.equal((await post(BODY + " ")).code, 409);
    const a: Assignment = JSON.parse(coordinator.row("delivery-1")!.assignment);
    const input = { threadId: caller, requestId: a.requestId, preset: a.preset };
    assert.equal(engine!.sessionLookup(input),null,"lookup never admits an absent request");
    await assert.rejects(engine!.startSession({ ...input, prompt: "arbitrary command" }), /unsupported_reduction/);
    const bytes = JSON.stringify(a);
    await assert.rejects(bus.publish(receiver, "command", bytes)); // worker has no assignment-publish authority
    await bus.publish(sender, "command", bytes);
    const command = await bus.take(receiver, "command");
    let first!: SessionStatus;
    await assert.rejects(worker.accept(command.string(), { startSession: async value => {
      first = await engine!.startSession(value);
      throw new Error("fixture: admission reply lost before worker recorded its handle");
    } }), /admission reply lost/);
    assert.equal(launches, 1);
    assert.equal(engine!.sessionLookup(input)!.sessionId,first.sessionId,"lookup recovers lost admission reply");
    await engine!.stop(); store!.close(); engine = undefined; store = undefined;
    await watcher.close(); watcher = undefined;
    if (interrupt) {
      await waitFor("fixture provider running", () => t3.fakeClaudeEvents().some(e => e.kind === "turn" && e.outcome === "held"), 30_000);
      await t3.stopServer(); await t3.startServer();
    }
    worker.close(); worker = new Worker(workerPath, { ...binding, caller });
    await bus.restart();
    sender = await bus.client("coordinator"); receiver = await bus.client("worker");
    startEngine();
    // Original unacked command survives a real broker process restart.
    const redelivery = await bus.take(receiver, "command");
    assert.equal(redelivery.string(), bytes);
    assert.equal(engine!.sessionLookup(input)!.sessionId,first.sessionId,"lookup survives service reopen");
    const replay = await worker.accept(redelivery.string(), engine!);
    await bus.ack(receiver, "command", redelivery);
    await assert.rejects(worker.accept(JSON.stringify({ ...a, preset: "operator" }), engine!), /assignment_binding/);
    assert.equal(replay.sessionId, first.sessionId);
    assert.equal(replay.threadId, first.threadId);
    await assert.rejects(engine!.startSession({ ...input, preset: "other" }), /changed payload/);
    const end = Date.now() + 45_000;
    let status = engine!.sessionStatus(first.sessionId);
    while (status.state === "parked" || !status.delivery.some(d => d.state === "sent")) {
      if (Date.now() > end) throw new Error("session did not resolve: " + JSON.stringify(status));
      await new Promise(r => setTimeout(r, 100));
      status = engine!.sessionStatus(first.sessionId);
    }
    assert.equal(launches, 1, "uncertain launch must never redispatch");
    assert.equal(status.launch, "accepted");
    assert.equal(status.state, "resolved");
    const resultProjection = await withClient(options(), c =>
      c["orchestration.getThreadProjection"]({ threadId: first.threadId } as never));
    const outcome = status.outcome as {reason:string;runId:string};
    const final = resultProjection.turnItems.filter(i => i.type === "assistant_message" && i.runId === outcome.runId).at(-1);
    const completedRun = resultProjection.runs.find(r => r.id === outcome.runId);
    assert.ok(final && completedRun);
    assert.ok(resultProjection.nodes.some(n => n.id === final.nodeId && n.kind === "assistant_message" &&
      n.parentNodeId === completedRun.rootNodeId && n.runId === outcome.runId));
    assert.equal(outcome.reason, "succeeded", JSON.stringify(status));
    assert.equal(status.resultState, "stored", JSON.stringify(status));
    assert.ok(status.result && Buffer.byteLength(status.result) <= 2048);
    assert.equal(status.occupancy, "released");
    assert.equal(status.delivery.filter(d => d.state === "sent").length, 1);
    const projection = await withClient(options(), c =>
      c["orchestration.getThreadProjection"]({ threadId: first.threadId } as never));
    assert.equal(projection.thread.id, first.threadId);
    assert.equal(projection.runs.length, interrupt ? 2 : 1);
    if (interrupt) assert.equal(projection.runs[1]!.restartContinuationOfRunId, projection.runs[0]!.id, "native continuation in the same thread");
    assert.equal(store!.db.prepare("SELECT count(*) AS n FROM sessions").get()!.n, 1);
    assert.equal(status.result, "Done.");
    const receipt = result(a, status);
    await bus.publish(receiver, "result", JSON.stringify(receipt));
    const resultMessage = await bus.take(sender, "result");
    coordinator.commitResult("delivery-1", JSON.parse(resultMessage.string()));
    // Result commit precedes ACK. Its replay after reopen is identical.
    coordinator.close(); coordinator = new Coordinator(coordinatorPath, binding);
    await bus.restart();
    sender = await bus.client("coordinator"); receiver = await bus.client("worker");
    const repeatedResult = await bus.take(sender, "result");
    coordinator.commitResult("delivery-1", JSON.parse(repeatedResult.string()));
    await assert.rejects(async () => coordinator!.commitResult("delivery-1", { ...receipt, thread: "changed" }), /result_conflict/);
    await bus.ack(sender, "result", repeatedResult);
    const persisted = engine!.sessionStatus(first.sessionId);
    await engine!.stop(); store!.close(); engine = undefined; store = undefined;
    await t3.stopServer();
    await t3.startServer();
    startEngine();
    assert.equal(engine!.sessionStatus(first.sessionId).result, persisted.result);
    assert.equal(launches, 1);
    const evidence = { passed: true, restartDuringRun: interrupt, proof: "signed-occurrence", environment, caller, assignment: a, session: first.sessionId,
      thread: first.threadId, run: status.runId, launchAttempts: launches, outcome: status.outcome,
      resultBytes: status.resultBytes, wake: status.delivery, result: receipt };
    writeFileSync(proofPath, JSON.stringify(evidence, null, 2) + "\n");
    console.log(JSON.stringify(evidence));
  } finally {
    await ingress?.close(); coordinator?.close(); worker?.close(); await bus?.close();
    await engine?.stop(); store?.close(); await watcher?.close(); await t3.stop(); dir.remove();
  }
});
