import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import * as Effect from "effect/Effect";
import { loadState, saveState } from "../../src/quota/state.ts";
import { switchPort, withClient } from "../../src/t3/adapter.ts";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { ObserverProcess, ShellWatcher, dispatchMessage, readFeed, sleep, waitFor, writePrivateFile } from "../helpers/e2e.ts";
import { SCRATCH_ROOT, scratchDir } from "../helpers/scratch.ts";

const version = t3Version(), skip = version === "t3 v0.1.0" ? false : `needs t3 v0.1.0, found ${version}`;
if (skip && process.env.CHALDEA_REQUIRE_E2E === "1") throw new Error(skip);
for (const scenario of ["available", "exhausted", "crash", "crash-before-reset", "expired-archived", "read-only"] as const) {
  test(`provider switch: ${scenario}`, { skip, timeout: 180_000 }, async () => {
    const scratch = scratchDir("switch-e2e");
    const t3 = await startDisposableT3({ scratchRoot: SCRATCH_ROOT, scenario: "reset", autoResume: true,
      resetDelaySeconds: scenario === "crash-before-reset" ? 20 : 12, codex: scenario === "exhausted" ? "exhausted" : "available", claudeModel: "claude-opus-5-5" });
    let watcher: ShellWatcher | undefined;
    const observers: ObserverProcess[] = [];
    try {
      const token = t3.issueToken(["orchestration:read", "orchestration:operate"]);
      const readToken = t3.issueToken(["orchestration:read"]);
      const tokenFile = join(scratch.path, "token"), statePath = join(scratch.path, "state.json"), feedLog = join(scratch.path, "feed.jsonl");
      writePrivateFile(tokenFile, scenario === "read-only" ? readToken : token);
      const port = () => switchPort({ serverUrl: t3.serverUrl, token });
      const waitCatalog = async () => {
        for (let tries = 0; tries < 60; tries++) {
          const catalog = await port().catalog();
          const p = catalog.providers.find((p) => p.instanceId === "codex");
          if (p?.status === "ready" && p.usageLimits?.windows.length && p.models.some((m) => m.slug === "gpt-6.1-sol")) return;
          await sleep(250);
        }
        throw new Error("fake Codex did not become ready with model and usage windows");
      };
      await waitCatalog();
      watcher = new ShellWatcher(t3.serverUrl, readToken);
      const threadId = await waitFor("bootstrap", () => watcher!.firstThreadId(), 30_000);
      await withClient({ serverUrl: t3.serverUrl, token }, (client) => client["orchestration.dispatchCommand"]({
        type: "thread.model-selection.set", commandId: "switch-test-selection", threadId,
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] },
      } as never) as Effect.Effect<unknown, unknown>);
      const start = async (crashAfterHold = false) => {
        const o = new ObserverProcess({ serverUrl: t3.serverUrl, tokenFile, statePath, feedLog,
          scratch: scratch.path, switching: true, crashAfterHold });
        observers.push(o);
        await waitFor("observer subscription", () => o.subscriptions(), 30_000);
        return o;
      };
      const crashes = ["crash", "crash-before-reset", "expired-archived"].includes(scenario);
      const first = await start(crashes);
      await dispatchMessage(t3, token, threadId, `Fixture work. ${t3.trigger}`, "switch-trigger");
      const stopped = await waitFor("quota stop", () => {
        const t = watcher!.threads.get(threadId); return t?.status === "failed" && t.lastErrorClass === "usage_limit" && t;
      }, 30_000);
      const reset = Date.parse(stopped.usageLimitResetAt!);
      if (crashes) {
        await waitFor("observer SIGKILL after hold", () => first.signalCode === "SIGKILL", 30_000);
        const raw = JSON.parse(readFileSync(statePath, "utf8"));
        assert.equal(Object.values(raw.switches).length, 1);
        assert.equal((Object.values(raw.switches)[0] as { phase: string }).phase, "holding");
        await watcher.close(); await t3.stopServer(); await t3.startServer();
        await waitCatalog();
        watcher = new ShellWatcher(t3.serverUrl, readToken);
        await waitFor("restored held thread", () => watcher!.threads.get(threadId), 30_000);
        if (scenario === "crash") {
          await sleep(Math.max(0, reset + 5_500 - Date.now()));
          assert.equal(watcher.threads.get(threadId)!.latestRunId, stopped.latestRunId, "hold survives observer and T3 restart");
        }
        if (scenario === "expired-archived") {
          await withClient({ serverUrl: t3.serverUrl, token }, (client) => client["orchestration.dispatchCommand"]({
            type: "thread.archive", commandId: "archive-held-stop", threadId,
          } as never));
          const state = loadState(statePath, Date.now());
          for (const intent of state.switches.values()) Object.assign(intent, { expiresAt: Date.now() - 1 });
          saveState(statePath, state, Date.now());
        }
        await start();
        if (scenario === "expired-archived") {
          await waitFor("deadline cleanup feed warning", () => readFeed(feedLog).some((e) =>
            e.body.kind === "provider_switch_failed" && e.body.reason === "hold_expired"), 15_000);
          // The public metadata RPC rejects non-null recovery updates on archived
          // threads; the production expiry path must clear the owned hold.
          for (let attempt = 0; attempt < 100 && (await port().thread(threadId))?.limitRecovery; attempt++) await sleep(100);
          assert.equal((await port().thread(threadId))!.limitRecovery, null);
          // Clearing the remote hold precedes the local final checkpoint.
          await waitFor("expired archived switch final local phase", () =>
            [...loadState(statePath, Date.now()).switches.values()][0]?.phase === "cancelled", 10_000);
          assert.equal([...loadState(statePath, Date.now()).switches.values()][0]!.phase, "cancelled");
          await withClient({ serverUrl: t3.serverUrl, token }, (client) => client["orchestration.dispatchCommand"]({
            type: "thread.unarchive", commandId: "unarchive-cleaned-stop", threadId,
          } as never));
        }
      }
      const expectsSwitch = scenario === "available" || scenario === "crash-before-reset";
      await waitFor(expectsSwitch ? "provider_switched" : "quota_resumed", () =>
        readFeed(feedLog).some((e) => e.body.kind === (expectsSwitch ? "provider_switched" : "quota_resumed")), 40_000);
      await waitFor("completed continuation", () => {
        const t = watcher!.threads.get(threadId);
        return t?.latestRunId !== stopped.latestRunId && t?.status === "completed" && t;
      }, 30_000);
      await sleep(Math.max(0, reset + 6_000 - Date.now()));
      await first.stop(); await start(); await sleep(1_000);
      const feed = readFeed(feedLog), switched = feed.filter((e) => e.body.kind === "provider_switched");
      const codexLog = join(t3.root, "fake-codex.jsonl");
      const events: Array<Record<string, unknown>> = existsSync(codexLog) ? readFileSync(codexLog, "utf8").trim().split("\n").map((s) => JSON.parse(s)) : [];
      if (expectsSwitch) {
        assert.equal(switched.length, 1);
        assert.equal(switched[0]!.body.fromModel, "claude-opus-5-5");
        assert.equal(switched[0]!.body.toModel, "gpt-6.1-sol");
        assert.equal(switched[0]!.body.runId, stopped.latestRunId);
        assert.equal(feed.filter((e) => e.body.kind === "quota_resumed").length, 0);
        assert.equal(events.filter((e) => e.kind === "turn").length, 1);
        assert.equal(events.find((e) => e.kind === "turn")!.model, "gpt-6.1-sol");
        assert.equal(events.find((e) => e.kind === "turn")!.effort, "high");
        assert.ok(events.some((e) => e.kind === "handoff" && Number(e.items) > 0), "T3 delivers portable history");
        assert.equal(t3.fakeClaudeEvents().filter((e) => e.kind === "turn" && e.outcome === "completed").length, 0);
        if (scenario === "available") {
          const delay = (Date.parse(watcher.threads.get(threadId)!.latestRunStartedAt!) - Date.parse(stopped.latestRunCompletedAt!)) / 1000;
          assert.ok(delay < 5, `switch took ${delay}s`);
          console.log(`switch latency ${delay}s; exactly one Codex continuation, no native reset resume`);
        }
      } else {
        assert.equal(switched.length, 0);
        assert.equal(events.filter((e) => e.kind === "turn").length, 0);
        assert.equal(t3.fakeClaudeEvents().filter((e) => e.kind === "turn" && e.outcome === "completed").length, 1);
        assert.equal(feed.filter((e) => e.body.kind === "quota_resumed").length, 1);
        if (scenario === "read-only") assert.ok(observers[0]!.lines.some((l) => String(l.message).includes("orchestration:operate")));
      }
      const projection = await withClient({ serverUrl: t3.serverUrl, token }, (client) =>
        client["orchestration.getThreadProjection"]({ threadId } as never));
      assert.equal(projection.runs.length, 2);
      assert.equal(await port().continue({ threadId, runId: stopped.latestRunId!, commandId: "stale-manual-guard-probe",
        target: { instanceId: "codex", model: "gpt-6.1-sol" } }), false, "pinned T3 rejects a superseded source run");
      assert.equal(projection.messages.filter((m) => m.role === "user" && m.text === "Continue where you left off.").length, 1);
      const publicOutput = JSON.stringify([feed, observers.flatMap((o) => o.lines)]);
      for (const secret of [token, readToken, `Fixture work. ${t3.trigger}`]) assert.ok(!publicOutput.includes(secret));
    } finally {
      for (const o of observers) await o.stop("SIGKILL");
      await watcher?.close(); await t3.stop(); scratch.remove();
    }
  });
}
