// Disposable Codex app-server peer: no credentials or network.
// Response shapes follow pinned upstream CodexAdapterV2 replay/probe tests.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-V")) { console.log("codex-cli 0.162.1"); process.exit(0); }
const home = process.env.CODEX_HOME;
const log = (event) => appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
const emit = (frame) => process.stdout.write(JSON.stringify(frame) + "\n");
const notify = (method, params) => emit({ method, params });
const models = ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-astra"].map((model) => ({
  id: model, model, displayName: model, description: "Disposable test model", hidden: false,
  isDefault: model === "gpt-6.1-sol", defaultReasoningEffort: "high",
  supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({ reasoningEffort, description: "" })),
}));
mkdirSync(home, { recursive: true });
writeFileSync(join(home, "models_cache.json"), JSON.stringify({ fetched_at: new Date().toISOString(), models }));
let nativeId = randomUUID();
function thread(id = nativeId) {
  return { id, sessionId: id, forkedFromId: null, preview: "", ephemeral: false, modelProvider: "openai",
    createdAt: Math.floor(Date.now()/1000), updatedAt: Math.floor(Date.now()/1000), status: { type: "idle" },
    path: join(home, id + ".jsonl"), cwd: process.cwd(), cliVersion: "0.162.1", source: "vscode",
    threadSource: null, projectId: null, parentThreadId: null, historyMode: "legacy", recencyAt: Math.floor(Date.now()/1000), canAcceptDirectInput: true, extra: null, agentNickname: null, agentRole: null, gitInfo: null, name: null, turns: [] };
}
function threadResponse(id) {
  return { thread: thread(id), model: "gpt-6.1-sol", modelProvider: "openai", serviceTier: null,
    cwd: process.cwd(), runtimeWorkspaceRoots: [process.cwd()], activePermissionProfile: null, multiAgentMode: "explicitRequestOnly", instructionSources: [], approvalPolicy: "never", approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" }, reasoningEffort: "high" };
}
function turn(id, status = "inProgress") {
  return { id, items: [], itemsView: "notLoaded", status, error: null,
    startedAt: Math.floor(Date.now()/1000), completedAt: status === "completed" ? Math.floor(Date.now()/1000) : null, durationMs: null };
}
createInterface({ input: process.stdin }).on("line", (line) => {
  let frame; try { frame = JSON.parse(line); } catch { return; }
  const { id, method, params } = frame;
  if (id === undefined) return;
  log({ kind: "request", method });
  let result;
  if (method === "initialize") result = { userAgent: "codex/0.162.1", codexHome: home, platformFamily: "unix", platformOs: "linux" };
  else if (method === "account/read") result = { account: { type: "chatgpt", email: "fixture@example.invalid", planType: "pro" }, requiresOpenaiAuth: false };
  else if (method === "model/list") result = { data: models, nextCursor: null };
  else if (method === "skills/list") result = { data: [] };
  else if (method === "account/rateLimits/read") result = { rateLimits: {
    limitId: "codex", limitName: "Codex", planType: "pro", credits: null,
    primary: { usedPercent: process.env.FAKE_CODEX_EXHAUSTED === "1" ? 100 : 10, windowDurationMins: 300, resetsAt: Math.floor(Date.now()/1000) + 3600 },
    secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: Math.floor(Date.now()/1000) + 86400 },
  } };
  else if (method === "thread/start") { nativeId = randomUUID(); result = threadResponse(nativeId); }
  else if (method === "thread/resume") { nativeId = params.threadId; result = threadResponse(nativeId); }
  else if (method === "thread/read") result = { thread: thread(params.threadId) };
  else if (method === "thread/inject_items") { log({ kind: "handoff", items: params.items?.length ?? 0 }); result = {}; }
  else if (method === "turn/start") {
    const tid = randomUUID();
    log({ kind: "turn", model: params.model, effort: params.effort,
      continuation: params.input?.some((i) => i.text?.includes("Continue where you left off.")) });
    emit({ id, result: { turn: turn(tid) } });
    // Let T3 associate the returned turn ID before provider notifications arrive.
    setTimeout(()=>{
    notify("turn/started", { threadId: params.threadId, turn: turn(tid) });
    notify("item/completed", { threadId: params.threadId, turnId: tid,completedAtMs:Date.now(),
      item: { type: "agentMessage", id: randomUUID(), text: "Done on Codex.", phase: "final_answer",
        ...(params.input?.some(i=>i.text?.includes("chaldea-native-async")) ? {delivery:"async",questions:[{title:"Deploy async fixture?",options:["Approve","Hold"]}]} : {}) } });
    if(params.input?.some(i=>i.text?.includes("chaldea-native-burst"))){
      for(let n=0;n<90;n++)notify("item/completed",{threadId:params.threadId,turnId:tid,completedAtMs:Date.now(),
        item:{type:"agentMessage",id:randomUUID(),text:"Background fixture "+n,phase:"commentary"}});
    }
    notify("turn/completed", { threadId: params.threadId, turn: turn(tid, "completed") });
    },30);
    return;
  } else if (method === "thread/loaded/list") result = { data: [] };
  else if (method === "thread/unsubscribe" || method === "thread/unarchive") result = {};
  else { emit({ id, error: { code: -32601, message: "unsupported disposable request" } }); return; }
  emit({ id, result });
});
