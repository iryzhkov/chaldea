import assert from "node:assert/strict";
import { test } from "node:test";
import { isAbsolute, join, relative, resolve } from "node:path";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { loadSessionPolicy, parsePolicy, presetHash } from "../../src/session/policy.ts";
import { admit, startInput } from "../../src/session/admit.ts";
import { checkResult, sessionWake, MAX_WAKE_BYTES } from "../../src/session/result.ts";
import { finalAssistant, launchPayload } from "../../src/session/t3.ts";
import { loadConfig } from "../../src/waits/config.ts";
import { WAIT_TOOLS, SESSION_TOOLS } from "../../src/mcp.ts";
import { scratchDir, SCRATCH_ROOT } from "../helpers/scratch.ts";

function insideScratch(path: string): boolean {
  const rel = relative(resolve(SCRATCH_ROOT), resolve(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

const GRANTS = [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get", "history", "list", "search"] }] }];
const preset = (over: Record<string, unknown> = {}) => ({ instanceId: "reporter-instance", model: "m", runtimeMode: "approval-required",
  interactionMode: "default", projectId: "reporter-project", title: "Reporter", prompt: "Report.", project: "projectA",
  services: GRANTS, maxSeconds: 3600, delegate: false, destinations: ["caller-project"], ...over });
const document = (presets: Record<string, unknown> = { equal: preset() }) => ({ version: 1, environment: "env", presets,
  ceilings: [{ project: "projectA", maxSeconds: 3600, services: GRANTS, destinations: ["caller-project", "second-project"] }] });
const uid = process.getuid!();

test("protected public policy: owner and ancestor modes are enforced, strict JSON, no 0600 requirement", () => {
  const dir = scratchDir("session-policy");
  assert.ok(insideScratch(dir.path));
  try {
    const root = join(dir.path, "etc"), file = join(root, "sessions.json");
    mkdirSync(root, { mode: 0o755 }); chmodSync(root, 0o755); chmodSync(dir.path, 0o755);
    writeFileSync(file, JSON.stringify(document()), { mode: 0o644 }); chmodSync(file, 0o644);
    const rules = { owners: [uid], stopAt: dir.path };
    assert.ok(loadSessionPolicy(file, "env", rules).presets.equal);
    assert.throws(() => loadSessionPolicy(file, "env", { owners: [uid + 1], stopAt: dir.path }), /session_policy_unsafe/);
    assert.throws(() => loadSessionPolicy("relative.json", "env", rules), /session_policy_unsafe/);
    assert.throws(() => loadSessionPolicy(file, "other-env", rules), /session_policy_environment/);
    chmodSync(file, 0o664); assert.throws(() => loadSessionPolicy(file, "env", rules), /session_policy_unsafe/);
    chmodSync(file, 0o644); chmodSync(root, 0o775);
    assert.throws(() => loadSessionPolicy(file, "env", rules), /session_policy_unsafe/);
    chmodSync(root, 0o755);
    const link = join(root, "link.json"); symlinkSync(file, link);
    assert.throws(() => loadSessionPolicy(link, "env", rules), /session_policy_unsafe/);
    writeFileSync(file, '{"version":1,"version":1}');
    assert.throws(() => loadSessionPolicy(file, "env", rules), /session_policy_invalid/);
    writeFileSync(file, JSON.stringify({ ...document(), token: "x" }));
    assert.throws(() => loadSessionPolicy(file, "env", rules), /session_policy_invalid: policy has unknown key/);
    assert.throws(() => loadSessionPolicy(join(root, "absent.json"), "env", rules), /session_policy_unsafe/);
  } finally { dir.remove(); }
  for (const bad of [{ argv: ["x"] }, { workspaceStrategy: { type: "worktree" } }, { maxSeconds: 0 }, { runtimeMode: "root" }, { prompt: "" }])
    assert.throws(() => parsePolicy(document({ p: preset(bad) }), "env"), /session_policy_invalid/);
});

test("equal and narrow presets fit the ceiling; admission shape reuses run-lease validation", () => {
  const now = Date.parse("2026-10-20T00:00:00Z");
  const policy = parsePolicy(document({ equal: preset(),
    narrow: preset({ maxSeconds: 60, destinations: ["second-project"], services: [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get"] }] }] }) }), "env");
  const equal = admit(policy, "equal", "run-1", now), narrow = admit(policy, "narrow", "run-2", now);
  assert.deepEqual(equal.admission, { runId: "run-1", profile: "equal", project: "projectA", expiresAt: now / 1000 + 3600, services: GRANTS });
  assert.equal(narrow.admission.expiresAt, now / 1000 + 60);
  assert.equal(equal.hash, presetHash(policy.presets.equal!));
  assert.notEqual(equal.hash, narrow.hash);
  assert.throws(() => startInput({ threadId: "t", requestId: "bad", preset: "equal" }, now), /requestId/);
  const a = startInput({ threadId: "t", requestId: now + ":a", preset: "equal" }, now), b = startInput({ threadId: "t", requestId: now + ":a", preset: "narrow" }, now);
  assert.notEqual(a.hash, b.hash);
  const launch = JSON.parse(launchPayload("s1", "thread-1", policy.presets.equal!).payload);
  assert.equal(launch.initialMessage.messageId, "chaldea-session:s1:message");
  assert.equal(launch.initialMessage.text, "Report.");
});

test("result text is exact or refused, and the full escaped wake respects 4096 bytes", () => {
  assert.deepEqual(checkResult("a".repeat(2048)), { state: "stored", text: "a".repeat(2048), bytes: 2048 });
  assert.equal(checkResult("a".repeat(2049)).state, "result_oversize");
  assert.equal(checkResult("\u0001".repeat(2048)).state, "stored");
  assert.equal(checkResult("x\u0000").state, "result_invalid");
  assert.equal(checkResult("x\udc00").state, "result_invalid");
  assert.equal(checkResult("😀").state, "stored");
  const base = { id: "0b8f2c5e-6c43-4f55-9c1e-7c7d6c3d2a10", parent: "caller", preset: "reporter", thread: "7c2b1f9e-1d8a-4a0c-8f6d-3b2a1c0d9e8f" };
  const ascii = sessionWake({ ...base, outcome: { reason: "succeeded", runId: "run-1", bytes: 2048 }, result: "a".repeat(2048) });
  assert.equal(ascii.wake, "result_embedded"); assert.ok(Buffer.byteLength(ascii.payload) <= MAX_WAKE_BYTES);
  assert.ok(JSON.parse(ascii.payload).text.includes("a".repeat(2048)));
  const control = "\u0001\u001b".repeat(1024);
  assert.equal(checkResult(control).state, "stored");
  const pointer = sessionWake({ ...base, outcome: { reason: "succeeded", runId: "run-1", bytes: 2048 }, result: control });
  assert.equal(pointer.wake, "result_in_status"); assert.ok(Buffer.byteLength(pointer.payload) <= MAX_WAKE_BYTES);
  assert.ok(!JSON.parse(pointer.payload).text.includes("\u0001"));
  const none = sessionWake({ ...base, outcome: { reason: "failed", runId: "run-1" }, result: null });
  assert.equal(none.wake, "no_result"); assert.match(JSON.parse(none.payload).text, /root run failed; no result/);
});

test("final result is the root node's last non-streaming assistant message of that run", () => {
  const item = (id: string, runId: string, nodeId: string, text: string, streaming = false, ordinal = 0) =>
    ({ type: "assistant_message", id, threadId: "t", runId, nodeId, ordinal, streaming, text });
  const p = (items: ReturnType<typeof item>[]) => ({ thread: { id: "t" }, runs: [{ id: "r1", threadId: "t", rootNodeId: "root" },
    { id: "r2", threadId: "t", rootNodeId: "root2" }], turnItems: items });
  assert.deepEqual(finalAssistant(p([item("a", "r1", "root", "one", false, 1), item("b", "r1", "root", "two", false, 2),
    item("c", "r1", "child", "child", false, 3), item("d", "r2", "root2", "other run", false, 4)]), "t", "r1"), { kind: "found", text: "two", itemId: "b" });
  assert.deepEqual(finalAssistant(p([item("c", "r1", "child", "child")]), "t", "r1"), { kind: "missing" });
  assert.deepEqual(finalAssistant(p([item("a", "r1", "root", "partial", true)]), "t", "r1"), { kind: "ambiguous", detail: "streaming" });
  assert.deepEqual(finalAssistant(p([]), "other", "r1"), { kind: "ambiguous", detail: "thread_mismatch" });
  assert.deepEqual(finalAssistant(p([]), "t", "r9"), { kind: "missing" });
});

test("waits config enables sessions only with an absolute policy path; MCP lists session tools only then", () => {
  const dir = scratchDir("session-config");
  assert.ok(insideScratch(dir.path));
  try {
    const write = (value: unknown) => { const file = join(dir.path, "waits.json"); writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return file; };
    assert.equal(loadConfig(write({ environment: "env" })).sessionPolicy, undefined);
    assert.equal(loadConfig(write({ environment: "env", sessionPolicy: "/etc/chaldea/sessions.json" })).sessionPolicy, "/etc/chaldea/sessions.json");
    assert.throws(() => loadConfig(write({ environment: "env", sessionPolicy: "sessions.json" })));
  } finally { dir.remove(); }
  assert.ok(!WAIT_TOOLS.some(t => t.name.startsWith("chaldea_session_")));
  assert.deepEqual(SESSION_TOOLS.map(t => t.name), ["chaldea_session_start", "chaldea_session_status"]);
  assert.deepEqual(SESSION_TOOLS[0]!.inputSchema.required, ["threadId", "requestId", "preset"]);
  assert.equal(SESSION_TOOLS[0]!.inputSchema.additionalProperties, false);
});
