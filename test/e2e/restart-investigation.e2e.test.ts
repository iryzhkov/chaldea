// Reproducible evidence for docs/restart-resume.md. Only disposable T3.
import assert from "node:assert/strict";
import { test } from "node:test";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { ShellWatcher, dispatchMessage, sleep, waitFor } from "../helpers/e2e.ts";
import { SCRATCH_ROOT } from "../helpers/scratch.ts";
import { switchPort, withClient } from "../../src/t3/adapter.ts";

const skip = t3Version() === "t3 v0.1.0" ? false : "needs pinned T3";
if (skip && process.env.CHALDEA_REQUIRE_E2E === "1") throw new Error(skip);
test("record pinned T3 restart, interrupt, quota and provider-exit outcomes", { skip, timeout: 180_000 }, async () => {
  for (const mode of ["SIGTERM", "SIGKILL", "interrupt", "stop", "quota", "provider"] as const) {
    for (const restartContinuation of [false, true]) {
    const t3 = await startDisposableT3({ scratchRoot: SCRATCH_ROOT, scenario: "no-reset", autoResume: false, restartContinuation });
    let watcher: ShellWatcher | undefined;
    try {
      const token = t3.issueToken(["orchestration:read", "orchestration:operate"]);
      watcher = new ShellWatcher(t3.serverUrl, token);
      const threadId = await waitFor("bootstrap", () => watcher!.firstThreadId(), 30_000);
      const rpc = <A>(f: Parameters<typeof withClient<A>>[1]) => withClient({ serverUrl: t3.serverUrl, token }, f);
      const projection = () => rpc(c => c["orchestration.getThreadProjection"]({ threadId } as never));
      const command = (value: unknown) => rpc(c => c["orchestration.dispatchCommand"](value as never));
      const text = mode === "quota" ? t3.trigger : mode === "provider" ? "chaldea-provider-crash" : "chaldea-restart-hold";
      await dispatchMessage(t3, token, threadId, text, mode);
      await waitFor("provider receives message", () => t3.fakeClaudeEvents().some(e => e.kind === "turn"), 30_000);
      const before = await projection();
      const runId = before.runs.at(-1)!.id;
      if (mode === "interrupt" || mode === "stop") {
        await command({ type: "run.interrupt", holdQueue: mode === "stop",
          commandId: "probe-interrupt", threadId, runId, reason: "probe explicit cancellation" });
      }
      if (mode === "SIGTERM" || mode === "SIGKILL") {
        await watcher.close();
        await t3.stopServer(mode);
        await t3.startServer();
      }
      await sleep(1500);
      const p = await projection();
      const shell = await switchPort({ serverUrl: t3.serverUrl, token }).thread(threadId);
      const source = p.runs.find(r => r.id === runId)!;
      const expected = mode === "SIGTERM" || mode === "SIGKILL" ? "cancelled" :
        mode === "interrupt" || mode === "stop" ? "interrupted" : "failed";
      assert.equal(source.status, expected);
      assert.equal(p.runs.length, restartContinuation && expected === "cancelled" ? 2 : 1);
      assert.equal(shell?.lastErrorClass, mode === "quota" ? "usage_limit" : mode === "provider" ? "transport_error" : null);
      console.log(JSON.stringify({ mode, restartContinuation, statuses: p.runs.map(r => r.status),
        lastErrorClass: shell?.lastErrorClass,
        causes: p.turnItems.filter(i => ["error", "run_interrupt_request", "run_interrupt_result"].includes(i.type)) }));
    } finally {
      await watcher?.close();
      await t3.stop();
    }
    }
  }
});
