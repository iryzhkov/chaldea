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

test("equal and narrow legacy presets preserve the admission envelope and canonical services", () => {
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

const typedGrants: Array<Record<string, unknown>> = [
  { audience: "ov", scope: "ov.read", ov_namespaces: ["viking://resources/team/reports"] },
  { audience: "homelab", scope: "homelab.read", homelab_services: ["dns"], homelab_hosts: ["host-a"] },
  { audience: "ha", scope: "ha.read", ha_entities: ["sensor.qualified_example"], ha_actions: ["state.read"] },
];
function typedDocument(service: Record<string, unknown>, ceiling: Record<string, unknown> = service) {
  return { version: 1, environment: "env", presets: { equal: preset({ services: [service] }) },
    ceilings: [{ project: "projectA", maxSeconds: 3600, services: [ceiling], destinations: ["caller-project"] }],
    enrollments: { equal: { form: "app_password", issuer: "https://auth.example.test/application/o/" + service.audience + "/",
      tokenUrl: "https://auth.example.test/application/o/token/", jwksUrl: "https://auth.example.test/application/o/" + service.audience + "/jwks/",
      clientId: "client-" + service.audience, username: "ordinary-" + service.audience,
      resource: "https://" + service.audience + ".mcp.ryzhkov.dev/mcp", ...service, maxTokenSeconds: 300, secretFile: "/etc/chaldea/" + service.audience + ".secret" } as Record<string, unknown> } };
}
test("closed service parsing enforces exact fields, explicit bounds and canonical grants", () => {
  for (const s of typedGrants) {
    const p = parsePolicy(typedDocument(s), "env");
    assert.deepEqual(admit(p, "equal", "run-typed", Date.now()).admission.services, [s]);
    for (const field of Object.keys(s)) {
      const missing = { ...s }; delete missing[field];
      assert.throws(() => parsePolicy(typedDocument(missing), "env"), /session_policy_invalid/, field);
      assert.throws(() => parsePolicy(typedDocument({ ...s, [field]: null }), "env"), /session_policy_invalid/, field);
    }
    for (const extra of [{ grants: [] }, { project: "synthetic" }, { unrelated: true }])
      assert.throws(() => parsePolicy(typedDocument({ ...s, ...extra }), "env"), /session_policy_invalid/);
    const d = typedDocument(s); delete (d as Partial<typeof d>).enrollments;
    assert.throws(() => parsePolicy(d, "env"), /require enrollment/);
  }
  const [ov, homelab, ha] = typedGrants;
  const invalid: Record<string, unknown>[] = [
    ...["viking://resources/a/", "viking://resources/a//b", "viking://resources/.", "viking://resources/a/..",
      "viking://resources/a%2fb", "viking://resources/*", "viking://resources/é", "viking://resources/a?x",
      "viking://resources/" + "x".repeat(1006)].map(r => ({ ...ov, ov_namespaces: [r] })),
    ...[[], ["viking://resources/a", "viking://resources/a"], ["viking://resources/a/b", "viking://resources/a"],
      Array.from({ length: 17 }, (_, i) => "viking://resources/n" + i)].map(v => ({ ...ov, ov_namespaces: v })),
    ...[["*"], ["a", "a"], ["-bad"], ["a.b"], ["x".repeat(65)], Array.from({ length: 129 }, (_, i) => "h" + i)]
      .map(v => ({ ...homelab, homelab_hosts: v })),
    ...[[], ["sensor.a", "sensor.a"], ["climate.a"], ["sensor.*"], ["lightXa"], ["sensor." + "a".repeat(97)],
      Array.from({ length: 65 }, (_, i) => "sensor.s" + i)].map(v => ({ ...ha, ha_entities: v })),
    ...[[], ["state.read", "state.read"], ["light.control"], ["*"]].map(v => ({ ...ha, ha_actions: v })),
    ...["ha.read ha.read", "ha.read ", " ha.read", "ha.admin", "ha.read  ha.control"].map(scope => ({ ...ha, scope })),
  ];
  for (const s of invalid) assert.throws(() => parsePolicy(typedDocument(s), "env"), /session_policy_invalid/, JSON.stringify(s));
  for (const s of [
    { ...ov, ov_namespaces: ["viking://resources/" + "x".repeat(1005)] },
    { ...ov, ov_namespaces: ["viking://resources/a", "viking://resources/ab"] },
    { ...homelab, homelab_services: [], homelab_hosts: [] },
    { ...homelab, homelab_hosts: Array.from({ length: 128 }, (_, i) => "h" + i) },
    { ...ha, ha_entities: ["light." + "a".repeat(96)] },
    { ...ha, scope: "ha.control ha.read", ha_actions: ["switch.control", "state.read"] },
    { ...ha, scope: "ha.control", ha_actions: ["light.control"] },
  ]) assert.ok(parsePolicy(typedDocument(s), "env"));
});

test("new enrollment binds the exact literal and ordered payload, one service, account and provider", () => {
  const [ov, homelab, ha] = typedGrants;
  for (const s of [ov!, homelab!, ha!]) {
    const d = typedDocument(s), original = structuredClone(d);
    for (const over of [{ project: "projectA" }, { resource: "https://other.test/mcp" },
      { issuer: "https://auth.example.test/application/o/x" }, { jwksUrl: "https://auth.example.test/other/" },
      { tokenUrl: "https://auth.example.test/token/" }, { audience: "jocasta" }, { maxTokenSeconds: 301 }]) {
      d.enrollments.equal = { ...original.enrollments.equal, ...over };
      assert.throws(() => parsePolicy(d, "env"), /session_policy_invalid/);
    }
  }
  const two = { ...ov, ov_namespaces: ["viking://resources/b", "viking://resources/a"] };
  const d = typedDocument(two);
  d.enrollments.equal.ov_namespaces = ["viking://resources/a", "viking://resources/b"];
  assert.throws(() => parsePolicy(d, "env"), /exactly match/);
  const h = typedDocument({ ...ha, scope: "ha.read ha.control", ha_actions: ["state.read", "light.control"] });
  h.enrollments.equal.scope = "ha.control ha.read";
  assert.throws(() => parsePolicy(h, "env"), /exactly match/);
  const multi = typedDocument(ov!); multi.presets.equal = preset({ services: [ov, homelab] });
  assert.throws(() => parsePolicy(multi, "env"), /exactly match/);
  const base = typedDocument(ov!);
  const combined = { ...base, presets: { ...base.presets, second: preset({ services: [ov!] }) },
    enrollments: { ...base.enrollments, second: { ...base.enrollments.equal } } };
  assert.throws(() => parsePolicy(combined, "env"), /distinct secret/);
  combined.enrollments.second.secretFile = "/etc/chaldea/second.secret";
  assert.throws(() => parsePolicy(combined, "env"), /distinct secret/);
  combined.enrollments.second.username = "second-account";
  assert.ok(parsePolicy(combined, "env"));
  const hb = typedDocument(homelab!);
  const cross = { ...base, presets: { ...base.presets, second: hb.presets.equal },
    enrollments: { ...base.enrollments, second: { ...hb.enrollments.equal, clientId: base.enrollments.equal.clientId } } };
  assert.throws(() => parsePolicy(cross, "env"), /distinct providers/);
});

test("typed ceilings use static component subsets and never merge, reduce, or reinterpret legacy grants", () => {
  const [ov, homelab, ha] = typedGrants;
  assert.ok(admit(parsePolicy(typedDocument(ov!, { ...ov, ov_namespaces: ["viking://resources/team"] }), "env"), "equal", "r", Date.now()));
  for (const [s, c] of [
    [ov!, { ...ov, ov_namespaces: ["viking://resources/tea"] }],
    [homelab!, { ...homelab, homelab_hosts: [] }],
    [homelab!, { ...homelab, homelab_services: [] }],
    [ha!, { ...ha, ha_entities: ["sensor.other"] }],
    [ha!, { ...ha, scope: "ha.control", ha_actions: ["light.control"] }],
    [ov!, { audience: "ov", grants: [{ resource: "viking://resources/team", actions: ["read"] }] }],
  ]) assert.throws(() => admit(parsePolicy(typedDocument(s!, c!), "env"), "equal", "r", Date.now()), /preset_exceeds_ceiling/);
  const s = { ...homelab, homelab_services: ["dns", "pve"] }, d = typedDocument(s, homelab!);
  d.ceilings.push({ ...d.ceilings[0]!, services: [{ ...homelab, homelab_services: ["pve"] }] });
  assert.throws(() => admit(parsePolicy(d, "env"), "equal", "r", Date.now()), /preset_exceeds_ceiling/);
  const legacy = document({ equal: preset({ services: [{ audience: "ov", grants: [{ resource: "viking://resources/a", actions: ["read"] }] }] }) });
  assert.throws(() => admit(parsePolicy(legacy, "env"), "equal", "r", Date.now()), /unsupported_audience/);
  const compat = document(); compat.ceilings[0]!.services = [...GRANTS, { audience: "ov", grants: [{ resource: "unused", actions: ["read"] }] }];
  const parsed = parsePolicy(compat, "env");
  assert.ok(admit(parsed, "equal", "r", Date.now()));
  assert.equal(JSON.stringify(parsed.presets.equal!.services), JSON.stringify(GRANTS));
  const oversize = document(Object.fromEntries(Array.from({ length: 16 }, (_, i) => ["p" + i, preset({ prompt: "x".repeat(8000) })])));
  assert.throws(() => parsePolicy(oversize, "env"), /64 KiB/);
});
