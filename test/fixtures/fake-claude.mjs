// Fake `claude` CLI for the disposable T3 used by the end-to-end tests.
//
// It speaks the Claude Agent SDK stream-json protocol well enough for T3 0.1.0:
// it answers control requests, announces a session, and answers each user
// message. The first message that contains FAKE_CLAUDE_TRIGGER is refused with
// a rejected five-hour rate limit (resetsAt FAKE_CLAUDE_RESET_DELAY_S seconds
// ahead, or no reset when FAKE_CLAUDE_SCENARIO=no-reset) followed by a
// `blocking_limit` result, which T3 classifies as `usage_limit`. Every other
// message completes normally. No network, credentials or real transcripts.
//
// State shared across processes (T3 may respawn the CLI with --resume) lives
// in FAKE_CLAUDE_STATE; one JSON line per event is appended to FAKE_CLAUDE_LOG.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_CLAUDE_STATE;
const logPath = process.env.FAKE_CLAUDE_LOG;
const trigger = process.env.FAKE_CLAUDE_TRIGGER ?? "chaldea-quota-trigger";
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "reset";
const resetDelaySeconds = Number(process.env.FAKE_CLAUDE_RESET_DELAY_S ?? "10");
const model = process.env.FAKE_CLAUDE_MODEL ?? "claude-sonnet-4-6";

function log(event) {
  if (logPath) appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...event })}\n`);
}

function readState() {
  if (!statePath || !existsSync(statePath)) return { limited: false };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  if (statePath) writeFileSync(statePath, JSON.stringify(state));
}

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("2.1.301 (Claude Code)\n");
  process.exit(0);
}

log({ kind: "spawn", args });

const resumeIndex = args.indexOf("--resume");
const sessionId = resumeIndex >= 0 && args[resumeIndex + 1] ? args[resumeIndex + 1] : randomUUID();

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function usage() {
  return { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

function systemInit() {
  emit({
    type: "system",
    subtype: "init",
    cwd: process.cwd(),
    session_id: sessionId,
    tools: [],
    mcp_servers: [],
    model,
    permissionMode: "default",
    slash_commands: [],
    apiKeySource: "none",
    claude_code_version: "2.1.301",
    output_style: "default",
    agents: [],
    skills: [],
    plugins: [],
    uuid: randomUUID(),
  });
}

function result(text, terminalReason) {
  emit({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: text,
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: usage(),
    modelUsage: {},
    permission_denials: [],
    uuid: randomUUID(),
    session_id: sessionId,
    terminal_reason: terminalReason,
  });
}

function assistant(text) {
  emit({
    type: "assistant",
    message: {
      model,
      id: `msg_${randomUUID()}`,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: null,
      stop_sequence: null,
      usage: usage(),
    },
    parent_tool_use_id: null,
    uuid: randomUUID(),
    session_id: sessionId,
  });
}

function messageText(message) {
  const content = message?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  }
  return "";
}

function answerControl(request) {
  const subtype = request.request?.subtype;
  let response = {};
  if (subtype === "initialize") {
    response = {
      commands: [],
      agents: [],
      output_style: "default",
      available_output_styles: ["default"],
      models: [{ value: model, displayName: "Sonnet", description: "Fake model" }],
      account: { tokenSource: "claude.ai", subscriptionType: "max", apiProvider: "firstParty" },
    };
  } else if (subtype === "mcp_set_servers") {
    response = { added: Object.keys(request.request?.servers ?? {}), removed: [], errors: {} };
  }
  log({ kind: "control", subtype });
  emit({ type: "control_response", response: { subtype: "success", request_id: request.request_id, response } });
}

function answerUser(message) {
  const text = messageText(message);
  systemInit();
  const state = readState();
  if (!state.limited && text.includes(trigger)) {
    writeState({ ...state, limited: true });
    const resetsAt = Math.floor(Date.now() / 1000) + resetDelaySeconds;
    const info = scenario === "no-reset"
      ? { status: "rejected", rateLimitType: "five_hour" }
      : { status: "rejected", rateLimitType: "five_hour", resetsAt };
    log({ kind: "turn", outcome: "limited", resetsAt: scenario === "no-reset" ? null : resetsAt });
    emit({ type: "rate_limit_event", rate_limit_info: info, uuid: randomUUID(), session_id: sessionId });
    result("Usage limit reached.", "blocking_limit");
    return;
  }
  log({ kind: "turn", outcome: "completed", continuation: text.includes("Continue where you left off.") });
  assistant("Done.");
  result("Done.", "completed");
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type === "control_request") answerControl(message);
  else if (message.type === "user") {
    const delay = /chaldea-waits-delay:(\d+)/.exec(messageText(message));
    if (delay) setTimeout(() => answerUser(message), Number(delay[1]));
    else answerUser(message);
  }
  else log({ kind: "ignored", type: message.type });
});
lines.on("close", () => {
  log({ kind: "stdin_closed" });
  process.exit(0);
});
