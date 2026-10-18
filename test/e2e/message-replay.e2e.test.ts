import assert from "node:assert/strict";
import test from "node:test";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ShellWatcher, waitFor, dispatchMessage } from "../helpers/e2e.ts";
import { withClient, dispatchChaldeaWake } from "../../src/t3/adapter.ts";

test("message qualification: successful identical RPC replay survives a lost response and T3 restart", {timeout:120_000}, async () => {
  assert.equal(t3Version(), "t3 v0.1.0", "pinned T3 is a build gate, never a passing skip");
  assert.notEqual(homedir(),"/home/igor");assert.notEqual(homedir(),"/root");
  const base=join(homedir(),"message-replay-tests");mkdirSync(base,{recursive:true,mode:0o700});
  const fixture=mkdtempSync(join(base,"t-"));
  const dir={path:fixture,remove:()=>rmSync(fixture,{recursive:true,force:true})};
  const t3 = await startDisposableT3({scratchRoot:dir.path,scenario:"no-reset",autoResume:false});
  let watcher: ShellWatcher | undefined;
  try {
    const token = t3.issueToken(["orchestration:read","orchestration:operate"]);
    watcher = new ShellWatcher(t3.serverUrl, token);
    const threadId = await waitFor("bootstrap thread", () => watcher!.firstThreadId(), 30_000);
    const opts = () => ({serverUrl:t3.serverUrl,token});
    const projection = () => withClient(opts(), c => c["orchestration.getThreadProjection"]({threadId} as never));
    await dispatchMessage(t3, token, threadId, "active qualification chaldea-waits-delay:5000", "message-active");
    // Poll only fixture state, never a live server.
    const deadline = Date.now()+10_000;
    while (!(await projection()).runs.some(r=>r.status==="running")) {
      assert.ok(Date.now()<deadline); await new Promise(r=>setTimeout(r,30));
    }
    const before = await projection();
    const active = before.runs.find(r=>r.status==="running")!;
    const payload = JSON.stringify({type:"message.dispatch",commandId:"message-qualification-command",
      messageId:"message-qualification-message",threadId,text:"Chaldea message qualification",
      createdBy:"agent",creationSource:"server",attachments:[],dispatchMode:{type:"queue_after_active"}});
    await dispatchChaldeaWake(opts(), payload);
    await dispatchChaldeaWake(opts(), payload); // Assert RPC success itself, not merely projection presence.
    let after = await projection();
    assert.equal(after.messages.filter(m=>m.id==="message-qualification-message").length,1);
    assert.deepEqual(after.thread.modelSelection,before.thread.modelSelection);
    assert.equal(after.runs.find(r=>r.id===active.id)?.status,"running");
    assert.equal(after.runs.find(r=>r.userMessageId==="message-qualification-message")?.status,"queued");
    await watcher.close(); watcher=undefined;
    await t3.stopServer(); await t3.startServer();
    await dispatchChaldeaWake(opts(), payload); // Caller lost its earlier reply; exact command only.
    after=await projection();
    assert.equal(after.messages.filter(m=>m.id==="message-qualification-message").length,1);
  } finally { await watcher?.close(); await t3.stop(); dir.remove(); }
});
