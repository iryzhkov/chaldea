// Synthetic preset-bound Jocasta token acquisition through the real wait engine and
// WakeStore, a fake official T3 and an injected transport serving a jose RS256
// issuer. No real credential, Authentik, Jocasta, provider, T3 or network is used:
// this proves Chaldea's local release control only, not Authentik behavior.
import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { chmodSync, chownSync, existsSync, linkSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { SignJWT, exportJWK, generateKeyPair, type JWTPayload } from "jose";
import { WakeStore } from "../../src/wake/store.ts";
import { WaitEngine } from "../../src/waits/engine.ts";
import { callService, ServiceRefusal, startWaitService } from "../../src/waits/service.ts";
import type { WaitConfig } from "../../src/waits/config.ts";
import { enrollmentDigest, parsePolicy, presetHash, type SessionPolicy } from "../../src/session/policy.ts";
import { CredentialRefusal, FETCH_BUDGET_MS, type Transport } from "../../src/session/credential.ts";
import { finalAssistant, type LaunchResult, type SessionT3 } from "../../src/session/t3.ts";
import { NATIVE_ONLY_METHODS, SESSION_TOOLS, WAIT_TOOLS } from "../../src/mcp.ts";
import type { WaitT3, WaitSnapshot, WaitRun } from "../../src/t3/waits.ts";
import { scratchDir, SCRATCH_ROOT } from "../helpers/scratch.ts";
import { testSocketPath } from "../helpers/socket.ts";

function insideScratch(path: string): boolean {
  const rel = relative(resolvePath(SCRATCH_ROOT), resolvePath(path));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(probe: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!probe()) { if (Date.now() > end) throw new Error("Timed out"); await sleep(5); }
}

const ISSUER = "https://auth.example.test/application/o/jocasta/";
const TOKEN_URL = "https://auth.example.test/application/o/token/";
const JWKS_URL = "https://auth.example.test/application/o/jocasta/jwks/";
const RESOURCE = "https://jocasta.example.test/mcp";
const SECRET = "fixture-app-password-" + randomUUID();
const GRANTS = [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get", "history", "list", "search"] }] }];
const CEILING = { project: "projectA", maxSeconds: 3600, services: GRANTS, destinations: ["caller-project"] };
const preset = (over: Record<string, unknown> = {}) => ({ instanceId: "reporter-instance", model: "reporter-model",
  runtimeMode: "approval-required", interactionMode: "default", projectId: "reporter-project", title: "Jocasta projectA reporter",
  prompt: "Report projectA status.", project: "projectA", services: GRANTS, maxSeconds: 900, delegate: false,
  destinations: ["caller-project"], ...over });
const enrollment = (secretFile: string, over: Record<string, unknown> = {}) => ({ form: "app_password", issuer: ISSUER,
  tokenUrl: TOKEN_URL, jwksUrl: JWKS_URL, clientId: "jocasta-client-id", username: "chaldea-laptop-reporter", scope: "jocasta.read",
  resource: RESOURCE, project: "projectA", maxTokenSeconds: 300, secretFile, ...over });
interface Shape { presets?: Record<string, unknown>; ceilings?: unknown[]; enrollments?: unknown }
const document = (secretFile: string, s: Shape = {}) => ({ version: 1, environment: "env", presets: s.presets ?? { reporter: preset() },
  ceilings: s.ceilings ?? [CEILING], ...(s.enrollments === null ? {} : { enrollments: s.enrollments ?? { reporter: enrollment(secretFile) } }) });
const policyOf = (secretFile: string, s: Shape = {}) => parsePolicy(document(secretFile, s), "env");

async function refused(p: Promise<unknown>, code: string, label = code): Promise<void> {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof CredentialRefusal, label + ": " + String(e));
    assert.equal(e.code, code, label); assert.equal(e.message, code, label);
    return true;
  });
}

// --- synthetic issuer behind the injected transport ---
interface Reply { status?: number; body?: string; headers?: Record<string, string> }
interface SignOptions { claims?: Record<string, unknown>; omit?: string[]; iat?: number; exp?: number; header?: Record<string, unknown>; key?: CryptoKey }
interface Seen { url: string; method: string; headers: Record<string, string>; body?: string }
class Issuer {
  readonly now: () => number;
  privateKey!: CryptoKey;
  jwk!: Record<string, unknown>;
  requests: Seen[] = [];
  minted: string[] = [];
  onJwks: () => Reply = () => ({ body: JSON.stringify({ keys: [this.jwk] }) });
  onToken: () => Reply | Promise<Reply> = () => this.reply();
  fail: "GET" | "POST" | null = null;
  hang: "GET" | "POST" | null = null;
  private paused: { method: string; promise: Promise<void>; resume: () => void } | null = null;
  constructor(now: () => number) { this.now = now; }
  static async make(now: () => number): Promise<Issuer> {
    const issuer = new Issuer(now), keys = await generateKeyPair("RS256", { extractable: true });
    issuer.privateKey = keys.privateKey;
    issuer.jwk = { ...await exportJWK(keys.publicKey), kid: "k1", alg: "RS256", use: "sig" };
    return issuer;
  }
  claims(o: SignOptions = {}): Record<string, unknown> {
    const at = Math.floor(this.now() / 1000), iat = o.iat ?? at;
    const c: Record<string, unknown> = { iss: ISSUER, aud: RESOURCE, sub: "chaldea-laptop-reporter", iat, exp: o.exp ?? iat + 300,
      scope: "jocasta.read", jocasta_projects: ["projectA"], jti: randomUUID(), ...o.claims };
    for (const k of o.omit ?? []) delete c[k];
    return c;
  }
  sign(o: SignOptions = {}): Promise<string> {
    return new SignJWT(this.claims(o) as JWTPayload).setProtectedHeader({ alg: "RS256", kid: "k1", ...o.header }).sign(o.key ?? this.privateKey);
  }
  async reply(o: SignOptions = {}): Promise<Reply> { return this.wrap(await this.sign(o)); }
  wrap(token: string): Reply {
    this.minted.push(token);
    return { body: JSON.stringify({ access_token: token, token_type: "Bearer", expires_in: 300, scope: "jocasta.read", id_token: "ignored" }) };
  }
  pause(method: "GET" | "POST"): void {
    let resume!: () => void;
    const promise = new Promise<void>(r => { resume = r; });
    this.paused = { method, promise, resume };
  }
  resume(): void { const p = this.paused; this.paused = null; p?.resume(); }
  posts(): Seen[] { return this.requests.filter(r => r.method === "POST"); }
  transport: Transport = async (url, init) => {
    this.requests.push({ url, method: init.method, headers: { ...init.headers }, ...(init.body === undefined ? {} : { body: init.body }) });
    if (this.paused && this.paused.method === init.method) await this.paused.promise;
    if (this.fail === init.method) throw new Error("connect ECONNREFUSED " + url);
    if (this.hang === init.method) return new Promise<Response>(() => {});
    const r = url === JWKS_URL ? this.onJwks() : url === TOKEN_URL ? await this.onToken() : { status: 404 };
    return new Response(r.body ?? null, { status: r.status ?? 200, headers: { "Content-Type": "application/json", ...r.headers } });
  };
}

// --- fake official T3 (launch, projection, observation and wake) ---
type TurnItem = { type: string; id: string; threadId: string; runId: string | null; nodeId: string | null; ordinal: number; streaming?: boolean; text?: string };
function thread(id: string, project: string): WaitSnapshot {
  return { id, project, archived: false, deleted: false, settled: false, runs: [], pendingRuns: [], children: [], lineage: { parent: null, root: id } };
}
function run(id: string, message: string): WaitRun {
  return { id, ordinal: 1, status: "running", started: new Date().toISOString(), workStarted: null, restartOf: null, failure: null,
    root: "node-root-" + id, message };
}
class FakeT3 {
  threads = new Map<string, WaitSnapshot>();
  items = new Map<string, TurnItem[]>();
  launches: string[] = [];
  wakes: string[] = [];
  private listeners = new Map<string, Set<(s: WaitSnapshot | null) => void>>();
  private seq = 0;
  constructor() { this.put(thread("caller", "caller-project")); }
  put(s: WaitSnapshot) { this.threads.set(s.id, s); for (const l of this.listeners.get(s.id) ?? []) l(s); }
  get(id: string): WaitSnapshot { const s = this.threads.get(id); if (!s) throw new Error("fake thread " + id); return s; }
  finish(threadId: string) {
    const s = this.get(threadId), r = s.runs[0]!;
    this.items.set(threadId, [{ type: "assistant_message", id: "item-0", threadId, runId: r.id, nodeId: r.root, ordinal: 0, streaming: false, text: "done" }]);
    this.put({ ...s, runs: s.runs.map(x => ({ ...x, status: "completed" })) });
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
    dispatch: async payload => { this.wakes.push(payload); },
  };
  sessions: SessionT3 = {
    launch: async (payload): Promise<LaunchResult> => {
      this.launches.push(payload);
      const input = JSON.parse(payload);
      this.put({ ...thread(input.threadId, input.projectId), runs: [run("run-" + this.launches.length, input.initialMessage.messageId)] });
      return { kind: "accepted", threadId: input.threadId, resumed: false };
    },
    result: async (threadId, runId) => {
      const s = this.get(threadId);
      return finalAssistant({ thread: { id: threadId }, runs: s.runs.map(r => ({ id: r.id, threadId, rootNodeId: r.root })),
        turnItems: this.items.get(threadId) ?? [] }, threadId, runId);
    },
  };
}

async function fixture(name: string) {
  const dir = scratchDir("cred-" + name);
  assert.ok(insideScratch(dir.path), "fixture writes stay in test scratch: " + dir.path + " under " + SCRATCH_ROOT);
  const secretFile = join(dir.path, "reporter.secret");
  writeFileSync(secretFile, SECRET + "\n", { mode: 0o600 }); chmodSync(secretFile, 0o600);
  const clock = { offset: 0 }, now = () => Date.now() + clock.offset;
  const issuer = await Issuer.make(now), t3 = new FakeT3(), events: string[] = [];
  const ref: { policy: SessionPolicy | null } = { policy: policyOf(secretFile) };
  const store = new WakeStore(join(dir.path, "waits.sqlite"), "env");
  const engine = new WaitEngine(store, t3.waits, { report: e => { events.push(e); },
    sessions: { policy: () => ref.policy, t3: t3.sessions, launchWaitMs: 200, credentials: { transport: issuer.transport, now } } });
  engine.start();
  let closed = false;
  const shut = async () => { if (!closed) { closed = true; await engine.stop(); store.close(); } };
  return {
    dir, secretFile, clock, now, issuer, t3, ref, events, store, engine, shut,
    headers: (over: Record<string, unknown> = {}) => engine.sessionHeaders({ preset: "reporter", audience: "jocasta", ...over }),
    async close() { await shut(); dir.remove(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
let counter = 0;
const start = (f: Fixture) => f.engine.startSession({ threadId: "caller", requestId: Date.now() + ":cred-" + ++counter, preset: "reporter" });
const resetSecret = (f: Fixture) => {
  rmSync(f.secretFile, { recursive: true, force: true }); rmSync(join(f.dir.path, "second"), { force: true });
  writeFileSync(f.secretFile, SECRET + "\n", { mode: 0o600 }); chmodSync(f.secretFile, 0o600);
};

test("enrollments are optional public policy: strict keys, canonical HTTPS endpoints, one project, digest over every field", () => {
  const file = "/etc/chaldea/authentik/reporter.secret";
  const legacy = policyOf(file, { enrollments: null });
  assert.equal(Object.hasOwn(legacy, "enrollments"), false);
  const p = policyOf(file), e = p.enrollments!.reporter!;
  assert.deepEqual(Object.keys(e), ["form", "issuer", "tokenUrl", "jwksUrl", "clientId", "username", "scope", "resource", "project",
    "maxTokenSeconds", "secretFile"]);
  assert.deepEqual({ ...e }, enrollment(file));
  // Enrollments never change the preset hash that admitted sessions are bound to.
  assert.equal(presetHash(p.presets.reporter!), presetHash(legacy.presets.reporter!));
  const digest = enrollmentDigest(e);
  assert.equal(digest, enrollmentDigest(policyOf(file).enrollments!.reporter!));
  for (const over of [{ clientId: "other" }, { username: "u2" }, { secretFile: "/etc/x" }, { issuer: "https://auth.example.test/application/o/other/" },
    { resource: "https://jocasta.example.test/mcp2" }, { tokenUrl: "https://auth.example.test/token2/" }, { jwksUrl: "https://auth.example.test/jwks2/" }])
    assert.notEqual(enrollmentDigest(policyOf(file, { enrollments: { reporter: enrollment(file, over) } }).enrollments!.reporter!), digest, JSON.stringify(over));
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ form: "client_secret" }, /form must be app_password/],
    [{ extra: 1 }, /unknown key extra/],
    [{ issuer: "http://auth.example.test/application/o/jocasta/" }, /canonical HTTPS/],
    [{ tokenUrl: "https://user:pw@auth.example.test/application/o/token/" }, /canonical HTTPS/],
    [{ jwksUrl: JWKS_URL + "#keys" }, /canonical HTTPS/],
    [{ tokenUrl: TOKEN_URL + "?debug=1" }, /canonical HTTPS/],
    [{ resource: "https://JOCASTA.example.test/mcp" }, /canonical HTTPS/],
    [{ resource: "https://jocasta.example.test:443/mcp" }, /canonical HTTPS/],
    [{ resource: "jocasta" }, /absolute URL/],
    [{ tokenUrl: "https://elsewhere.example.test/application/o/token/" }, /share the issuer origin/],
    [{ jwksUrl: "https://auth.example.test:8443/jwks/" }, /share the issuer origin/],
    [{ scope: "jocasta.read jocasta.write" }, /scope must be jocasta.read/],
    [{ maxTokenSeconds: 600 }, /maxTokenSeconds must be 300/],
    [{ project: "projectB" }, /project must equal the preset project/],
    [{ secretFile: "relative.secret" }, /normalized absolute path/],
    [{ secretFile: "/etc/chaldea/../x.secret" }, /normalized absolute path/],
    [{ clientId: "has space" }, /printable ASCII/],
    [{ username: "" }, /printable ASCII/],
  ];
  for (const [over, pattern] of bad)
    assert.throws(() => policyOf(file, { enrollments: { reporter: enrollment(file, over) } }), pattern, JSON.stringify(over));
  const { username: _username, ...missing } = enrollment(file);
  assert.throws(() => policyOf(file, { enrollments: { reporter: missing } }), /requires username/);
  assert.throws(() => policyOf(file, { enrollments: { ghost: enrollment(file) } }), /names no preset/);
  assert.throws(() => policyOf(file, { enrollments: [] }), /enrollments must be an object/);
  const wide = preset({ services: [{ audience: "jocasta", grants: [{ resource: "project:projectA", actions: ["get"] }, { resource: "project:projectB", actions: ["get"] }] }] });
  assert.throws(() => policyOf(file, { presets: { reporter: wide } }), /exactly project:projectA/);
  const akasha = preset({ services: [{ audience: "akasha", grants: [{ resource: "feed", actions: ["read"] }] }] });
  assert.throws(() => policyOf(file, { presets: { reporter: akasha } }), /exactly project:projectA/);
});

test("every gate and request refusal happens before any credential read or network request", async () => {
  const f = await fixture("gate");
  try {
    // With the secret absent, any credential read would surface as credential_unavailable instead.
    unlinkSync(f.secretFile);
    await refused(f.headers(), "no_active_run");
    await refused(f.headers({ audience: "akasha" }), "unsupported_audience");
    await refused(f.headers({ threadId: "caller" }), "invalid_request");
    await refused(f.headers({ preset: "../reporter" }), "invalid_request");
    await refused(f.engine.sessionHeaders(null), "invalid_request");
    await refused(f.engine.sessionHeaders({ preset: "reporter" }), "invalid_request");
    const s = await start(f);
    await refused(f.headers({ audience: "ov" }), "unsupported_audience");
    const original = f.ref.policy;
    const cases: Array<[SessionPolicy | null, string]> = [
      [policyOf(f.secretFile, { enrollments: null }), "enrollment_missing"],
      [policyOf(f.secretFile, { presets: { reporter: preset({ title: "edited" }) } }), "preset_changed"],
      [policyOf(f.secretFile, { presets: {}, enrollments: {} }), "preset_removed"],
      [policyOf(f.secretFile, { ceilings: [{ ...CEILING, maxSeconds: 600 }] }), "preset_exceeds_ceiling"],
      [policyOf(f.secretFile, { ceilings: [{ ...CEILING, destinations: ["elsewhere"] }] }), "preset_exceeds_ceiling"],
      [null, "sessions_disabled"],
    ];
    for (const [p, code] of cases) { f.ref.policy = p; await refused(f.headers(), code); }
    f.ref.policy = original;
    await refused(f.headers(), "credential_unavailable");
    f.clock.offset = Date.parse(s.deadline) - Date.now();
    await refused(f.headers(), "run_expired");
    f.clock.offset = 0;
    f.engine.cancelSession(s.sessionId);
    await refused(f.headers(), "run_inactive");
    assert.equal(f.issuer.requests.length, 0);
  } finally { await f.close(); }
});

test("admitted session: exact token request, verified claims, header-only reply, cache reuse, and no token in storage or reports", async () => {
  const f = await fixture("happy");
  try {
    const s = await start(f);
    const gate = f.engine.authorizeIssue("reporter", "jocasta");
    if (!gate.ok) throw new Error(gate.refusal);
    assert.equal(gate.presetHash, presetHash(f.ref.policy!.presets.reporter!));
    const reply = await f.headers();
    assert.deepEqual(Object.keys(reply), ["Authorization"]);
    assert.equal(reply.Authorization, "Bearer " + f.issuer.minted[0]);
    assert.deepEqual(f.issuer.requests.map(r => r.method + " " + r.url), ["GET " + JWKS_URL, "POST " + TOKEN_URL]);
    const [jwks, token] = f.issuer.requests;
    assert.equal(jwks!.body, undefined);
    assert.deepEqual(token!.headers, { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" });
    assert.deepEqual([...new URLSearchParams(token!.body)], [["grant_type", "client_credentials"], ["client_id", "jocasta-client-id"],
      ["username", "chaldea-laptop-reporter"], ["password", SECRET], ["scope", "jocasta.read"]]);
    // Cache hit: same token, no request; an unrelated policy edit keeps it.
    assert.deepEqual(await f.headers(), reply);
    f.ref.policy = policyOf(f.secretFile, { presets: { reporter: preset(), other: preset({ title: "other" }) } });
    assert.deepEqual(await f.headers(), reply);
    assert.equal(f.issuer.requests.length, 2);
    // Refusals carry fixed codes only.
    f.issuer.onToken = () => ({ status: 400, body: JSON.stringify({ error: "invalid_grant", detail: SECRET }) });
    f.clock.offset = 280_000;
    await refused(f.headers(), "token_request_failed");
    f.clock.offset = 0; f.issuer.onToken = () => f.issuer.reply();
    const status = JSON.stringify(f.engine.sessionStatus(s.sessionId));
    f.engine.cancelSession(s.sessionId);
    await refused(f.headers(), "run_inactive");
    await f.shut();
    const files = readdirSync(f.dir.path).filter(n => n.startsWith("waits.sqlite"));
    assert.ok(files.includes("waits.sqlite"));
    for (const secret of [...f.issuer.minted, SECRET]) {
      for (const n of files) assert.ok(!readFileSync(join(f.dir.path, n)).includes(secret), "secret material in " + n);
      assert.ok(!status.includes(secret)); assert.ok(!JSON.stringify(f.events).includes(secret));
    }
  } finally { await f.close(); }
});

test("wrong issuer, audience, scope, projects, algorithm, times or response shape are refused once, never retried and never cached", async () => {
  const f = await fixture("claims");
  try {
    await start(f);
    const at = () => Math.floor(f.now() / 1000);
    const other = await generateKeyPair("RS256", { extractable: true });
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const sign = (o: SignOptions) => () => f.issuer.reply(o);
    const raw = (body: string) => () => ({ body });
    const cases: Array<[string, () => Reply | Promise<Reply>, string]> = [
      ["wrong issuer", sign({ claims: { iss: "https://auth.example.test/application/o/other/" } }), "token_invalid"],
      ["wrong audience", sign({ claims: { aud: "https://jocasta.example.test/other" } }), "token_claims_invalid"],
      ["client id audience", sign({ claims: { aud: "jocasta-client-id" } }), "token_claims_invalid"],
      ["two audiences", sign({ claims: { aud: [RESOURCE, "https://other.example.test/"] } }), "token_claims_invalid"],
      ["extra scope", sign({ claims: { scope: "jocasta.read jocasta.write" } }), "token_claims_invalid"],
      ["missing scope", sign({ omit: ["scope"] }), "token_claims_invalid"],
      ["projects A and B", sign({ claims: { jocasta_projects: ["projectA", "projectB"] } }), "token_claims_invalid"],
      ["project B", sign({ claims: { jocasta_projects: ["projectB"] } }), "token_claims_invalid"],
      ["projects as text", sign({ claims: { jocasta_projects: "projectA" } }), "token_claims_invalid"],
      ["missing projects", sign({ omit: ["jocasta_projects"] }), "token_claims_invalid"],
      ["missing sub", sign({ omit: ["sub"] }), "token_claims_invalid"],
      ["missing iat", sign({ omit: ["iat"] }), "token_claims_invalid"],
      ["missing exp", sign({ omit: ["exp"] }), "token_claims_invalid"],
      ["lifetime over 300 s", () => f.issuer.reply({ iat: at() - 10, exp: at() + 291 }), "token_claims_invalid"],
      ["iat beyond skew", () => f.issuer.reply({ iat: at() + 120, exp: at() + 300 }), "token_claims_invalid"],
      ["not yet valid", () => f.issuer.reply({ claims: { nbf: at() + 120 } }), "token_invalid"],
      ["expired", () => f.issuer.reply({ iat: at() - 400, exp: at() - 100 }), "token_invalid"],
      ["under 30 s left", () => f.issuer.reply({ iat: at() - 280, exp: at() + 20 }), "token_claims_invalid"],
      ["foreign signing key", sign({ key: other.privateKey }), "token_invalid"],
      ["unknown kid", sign({ header: { kid: "k2" } }), "token_invalid"],
      ["token-selected jku", sign({ header: { jku: "https://evil.example.test/jwks" } }), "token_invalid"],
      ["HS256", async () => f.issuer.wrap(await new SignJWT(f.issuer.claims() as JWTPayload).setProtectedHeader({ alg: "HS256" })
        .sign(new TextEncoder().encode("k".repeat(32)))), "token_invalid"],
      ["alg none", () => f.issuer.wrap(b64({ alg: "none" }) + "." + b64(f.issuer.claims()) + ".c2ln"), "token_invalid"],
      ["not JSON", raw("not json"), "token_response_invalid"],
      ["duplicate member", raw('{"access_token":"a.b.c","access_token":"d.e.f","token_type":"Bearer"}'), "token_response_invalid"],
      ["not bearer", raw(JSON.stringify({ access_token: "a.b.c", token_type: "DPoP" })), "token_response_invalid"],
      ["no access token", raw(JSON.stringify({ token_type: "Bearer" })), "token_response_invalid"],
      ["not compact", raw(JSON.stringify({ access_token: "opaque-token", token_type: "Bearer" })), "token_response_invalid"],
      ["oversized JWT", raw(JSON.stringify({ access_token: "a".repeat(8200) + ".b.c", token_type: "Bearer" })), "token_response_invalid"],
    ];
    for (const [name, make, code] of cases) {
      f.issuer.onToken = make;
      const before = f.issuer.requests.length;
      await refused(f.headers(), code, name);
      // One JWKS read and one token request: never retried.
      assert.deepEqual(f.issuer.requests.slice(before).map(r => r.method), ["GET", "POST"], name);
    }
    f.issuer.onToken = () => f.issuer.reply();
    const before = f.issuer.requests.length;
    assert.equal((await f.headers()).Authorization, "Bearer " + f.issuer.minted.at(-1));
    assert.equal(f.issuer.requests.length, before + 2, "nothing refused was cached");
  } finally { await f.close(); }
});

test("cancel, policy, ceiling, enrollment, secret or deadline changes during either await discard the token for every waiter", async () => {
  type Mutation = (f: Fixture, s: { sessionId: string; deadline: string }) => void | Promise<void>;
  const narrow = (f: Fixture) => policyOf(f.secretFile, { ceilings: [{ ...CEILING, maxSeconds: 600 }] });
  const cases: Array<[string, "GET" | "POST", Mutation, string]> = [
    ["operator cancel", "GET", (f, s) => { f.engine.cancelSession(s.sessionId); }, "run_inactive"],
    ["operator cancel", "POST", (f, s) => { f.engine.cancelSession(s.sessionId); }, "run_inactive"],
    ["preset edit", "POST", f => { f.ref.policy = policyOf(f.secretFile, { presets: { reporter: preset({ title: "edited" }) } }); }, "preset_changed"],
    ["ceiling narrowed", "GET", f => { f.ref.policy = narrow(f); }, "preset_exceeds_ceiling"],
    ["ceiling narrowed", "POST", f => { f.ref.policy = narrow(f); }, "preset_exceeds_ceiling"],
    ["sessions disabled", "POST", f => { f.ref.policy = null; }, "sessions_disabled"],
    ["enrollment edit", "GET", f => { f.ref.policy = policyOf(f.secretFile, { enrollments: { reporter: enrollment(f.secretFile, { clientId: "rotated" }) } }); }, "session_changed"],
    ["enrollment edit", "POST", f => { f.ref.policy = policyOf(f.secretFile, { enrollments: { reporter: enrollment(f.secretFile, { clientId: "rotated" }) } }); }, "session_changed"],
    ["enrollment removed", "POST", f => { f.ref.policy = policyOf(f.secretFile, { enrollments: null }); }, "enrollment_missing"],
    ["secret rotation", "GET", f => { writeFileSync(f.secretFile, "rotated-secret\n"); }, "session_changed"],
    ["secret rotation", "POST", f => { writeFileSync(f.secretFile, "rotated-secret\n"); }, "session_changed"],
    ["secret made unsafe", "POST", f => { chmodSync(f.secretFile, 0o644); }, "credential_unavailable"],
    ["deadline passed", "POST", (f, s) => { f.clock.offset = Date.parse(s.deadline) - Date.now(); }, "run_expired"],
    // A refusal seen meanwhile orphans the fetch even if the operator restores the policy before it returns.
    ["narrowed and restored", "POST", async f => {
      const original = f.ref.policy; f.ref.policy = narrow(f);
      await refused(f.headers(), "preset_exceeds_ceiling"); f.ref.policy = original;
    }, "session_changed"],
  ];
  for (const [name, phase, mutate, code] of cases) {
    const f = await fixture("await");
    try {
      const s = await start(f), original = f.ref.policy;
      f.issuer.pause(phase);
      const first = f.headers(), second = f.headers();
      await until(() => f.issuer.requests.length === (phase === "GET" ? 1 : 2));
      await mutate(f, s);
      f.issuer.resume();
      await refused(first, code, name + " during " + phase);
      await refused(second, code, name + " during " + phase + " (second waiter)");
      // A change while the keys load never sends the token request.
      assert.equal(f.issuer.posts().length, phase === "GET" ? 0 : 1, name);
      // Nothing was cached: once the state is restored, a fresh fetch is needed.
      if (f.engine.sessionStatus(s.sessionId).state === "parked") {
        f.ref.policy = original; f.clock.offset = 0; resetSecret(f);
        const before = f.issuer.requests.length;
        assert.equal((await f.headers()).Authorization, "Bearer " + f.issuer.minted.at(-1), name);
        assert.equal(f.issuer.requests.length, before + 2, name);
      }
    } finally { await f.close(); }
  }
});

test("concurrent requests share one fetch; renewal, secret rotation and enrollment edits refetch; late runs never mint", async () => {
  const f = await fixture("cache");
  try {
    const s = await start(f);
    const replies = await Promise.all(Array.from({ length: 6 }, () => f.headers()));
    assert.equal(new Set(replies.map(r => r.Authorization)).size, 1);
    assert.equal(f.issuer.requests.length, 2);
    // Under 30 s left: a fresh token.
    f.clock.offset = 271_000;
    assert.equal((await f.headers()).Authorization, "Bearer " + f.issuer.minted[1]);
    assert.equal(f.issuer.requests.length, 4);
    writeFileSync(f.secretFile, "rotated-secret\n");
    assert.equal((await f.headers()).Authorization, "Bearer " + f.issuer.minted[2]);
    assert.equal(new URLSearchParams(f.issuer.posts().at(-1)!.body).get("password"), "rotated-secret");
    f.ref.policy = policyOf(f.secretFile, { enrollments: { reporter: enrollment(f.secretFile, { clientId: "client-2" }) } });
    assert.equal((await f.headers()).Authorization, "Bearer " + f.issuer.minted[3]);
    assert.equal(new URLSearchParams(f.issuer.posts().at(-1)!.body).get("client_id"), "client-2");
    assert.equal(f.issuer.requests.length, 8);
    // Within the last 300 s of the run a cached token whose exp fits is still released, but nothing new is minted.
    const deadline = Date.parse(s.deadline);
    f.clock.offset = deadline - 299_000 - Date.now();
    await refused(f.headers(), "run_ending");
    assert.equal(f.issuer.requests.length, 8);
    f.clock.offset = deadline - 310_000 - Date.now();
    const at = Math.floor(f.now() / 1000);
    f.issuer.onToken = () => f.issuer.reply({ iat: at + 20, exp: at + 320 });
    await refused(f.headers(), "token_outlives_run");
    f.issuer.onToken = () => f.issuer.reply();
    const late = await f.headers();
    assert.equal(f.issuer.requests.length, 12);
    f.clock.offset += 20_000;
    assert.deepEqual(await f.headers(), late);
    f.clock.offset = deadline - 35_000 - Date.now();
    await refused(f.headers(), "run_ending");
    assert.equal(f.issuer.requests.length, 12);
  } finally { await f.close(); }
});

test("an outstanding fetch for an old session is never delivered to the next run, and tokens are never reused across sessions", async () => {
  const f = await fixture("runs");
  try {
    const a = await start(f);
    const first = await f.headers();
    // Force a fresh fetch for session A and hold it while A ends and B starts.
    writeFileSync(f.secretFile, SECRET + "-2\n");
    f.issuer.pause("POST");
    const pending = f.headers();
    await until(() => f.issuer.requests.length === 4);
    f.t3.finish(a.threadId);
    await until(() => f.engine.sessionStatus(a.sessionId).occupancy === "released");
    const b = await start(f);
    assert.notEqual(b.sessionId, a.sessionId);
    f.issuer.resume();
    await refused(pending, "session_changed");
    const next = await f.headers();
    assert.notEqual(next.Authorization, first.Authorization);
    assert.equal(next.Authorization, "Bearer " + f.issuer.minted.at(-1));
    assert.equal(f.issuer.requests.length, 6);
    // After B ends, the slot's cached token is gone with it.
    f.t3.finish(b.threadId);
    await until(() => f.engine.sessionStatus(b.sessionId).occupancy === "released");
    await refused(f.headers(), "no_active_run");
    const c = await start(f);
    assert.notEqual((await f.headers()).Authorization, next.Authorization);
    assert.equal(f.issuer.requests.length, 8);
    assert.notEqual(c.sessionId, b.sessionId);
  } finally { await f.close(); }
});

test("unsafe secret files are refused before any request", async () => {
  const f = await fixture("secret");
  try {
    await start(f);
    const file = f.secretFile;
    const cases: Array<[string, () => void]> = [
      ["group readable", () => chmodSync(file, 0o640)],
      ["world readable", () => chmodSync(file, 0o644)],
      ["symlink", () => { const target = join(f.dir.path, "real.secret"); writeFileSync(target, SECRET, { mode: 0o600 }); unlinkSync(file); symlinkSync(target, file); }],
      ["missing", () => unlinkSync(file)],
      ["directory", () => { unlinkSync(file); mkdirSync(file, { mode: 0o700 }); }],
      ["empty", () => writeFileSync(file, "\n")],
      ["second hard link", () => linkSync(file, join(f.dir.path, "second"))],
    ];
    // Ownership is checked too; only a privileged test run can hand the file to another UID.
    if (process.getuid?.() === 0) cases.push(["other owner", () => chownSync(file, 65534, 65534)]);
    for (const [name, damage] of cases) {
      resetSecret(f);
      try { damage(); } catch (error) { if (name === "other owner") continue; throw error; }
      await refused(f.headers(), "credential_unavailable", name);
    }
    assert.equal(f.issuer.requests.length, 0);
    resetSecret(f);
    await f.headers();
    assert.equal(f.issuer.requests.length, 2);
  } finally { await f.close(); }
});

test("plain HTTP, redirects, oversized bodies, bad JWKS, transport failures and the time budget are refused without retry", async () => {
  const f = await fixture("transport");
  try {
    await start(f);
    const other = await generateKeyPair("ES256", { extractable: true });
    const ec = { ...await exportJWK(other.publicKey), kid: "e1" };
    const ok = f.issuer.onJwks;
    const cases: Array<[string, () => void, string, string[]]> = [
      ["JWKS redirect", () => { f.issuer.onJwks = () => ({ status: 302, headers: { Location: "https://evil.example.test/jwks" } }); }, "jwks_unavailable", ["GET"]],
      ["JWKS 500", () => { f.issuer.onJwks = () => ({ status: 500, body: "{}" }); }, "jwks_unavailable", ["GET"]],
      ["JWKS not JSON", () => { f.issuer.onJwks = () => ({ body: "<html>" }); }, "jwks_unavailable", ["GET"]],
      ["JWKS over 64 KiB", () => { f.issuer.onJwks = () => ({ body: JSON.stringify({ keys: [f.issuer.jwk], pad: "x".repeat(65 * 1024) }) }); }, "jwks_unavailable", ["GET"]],
      ["JWKS 17 keys", () => { f.issuer.onJwks = () => ({ body: JSON.stringify({ keys: Array(17).fill(f.issuer.jwk) }) }); }, "jwks_unavailable", ["GET"]],
      ["JWKS empty", () => { f.issuer.onJwks = () => ({ body: JSON.stringify({ keys: [] }) }); }, "jwks_unavailable", ["GET"]],
      ["JWKS without RSA keys", () => { f.issuer.onJwks = () => ({ body: JSON.stringify({ keys: [ec] }) }); }, "jwks_unavailable", ["GET"]],
      ["JWKS transport failure", () => { f.issuer.fail = "GET"; }, "jwks_unavailable", ["GET"]],
      ["token redirect", () => { f.issuer.onToken = () => ({ status: 307, headers: { Location: "https://evil.example.test/token" } }); }, "token_request_failed", ["GET", "POST"]],
      ["token 401", () => { f.issuer.onToken = () => ({ status: 401, body: JSON.stringify({ error: "invalid_client" }) }); }, "token_request_failed", ["GET", "POST"]],
      ["token body over 32 KiB", () => { f.issuer.onToken = () => ({ body: " ".repeat(33 * 1024) }); }, "token_request_failed", ["GET", "POST"]],
      ["token transport failure", () => { f.issuer.fail = "POST"; }, "token_request_failed", ["GET", "POST"]],
    ];
    for (const [name, arrange, code, methods] of cases) {
      f.issuer.onJwks = ok; f.issuer.onToken = () => f.issuer.reply(); f.issuer.fail = null;
      arrange();
      const before = f.issuer.requests.length;
      await refused(f.headers(), code, name);
      assert.deepEqual(f.issuer.requests.slice(before).map(r => r.method), methods, name);
    }
    f.issuer.onJwks = ok; f.issuer.onToken = () => f.issuer.reply(); f.issuer.fail = null;
    // An enrollment that reached the module without policy parsing is still never sent over plain HTTP.
    const original = f.ref.policy!;
    for (const field of ["jwksUrl", "tokenUrl"] as const) {
      const e = { ...original.enrollments!.reporter!, [field]: "http://auth.example.test/" + field + "/" };
      f.ref.policy = { ...original, enrollments: { reporter: e } };
      const before = f.issuer.requests.length;
      await refused(f.headers(), field === "jwksUrl" ? "jwks_unavailable" : "token_request_failed", field);
      assert.ok(f.issuer.requests.slice(before).every(r => r.url.startsWith("https://")), field);
    }
    f.ref.policy = original;
    // A hung issuer is cut off by the whole-acquisition budget.
    f.issuer.hang = "POST";
    const keepAlive = setTimeout(() => {}, FETCH_BUDGET_MS + 5000), began = Date.now();
    await refused(f.headers(), "token_request_failed", "hung token endpoint");
    const took = Date.now() - began;
    clearTimeout(keepAlive);
    assert.ok(took >= FETCH_BUDGET_MS - 200 && took < FETCH_BUDGET_MS + 2000, "budget " + took);
  } finally { await f.close(); }
});

// --- private IPC, native CLI and MCP exposure ---
function cli(args: string[], input?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(done => {
    const child = spawn(process.execPath, [resolvePath("src/cli.ts"), ...args], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    child.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    child.once("close", code => done({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}
async function fakeService(socket: string, answer: (body: { method: string; input: unknown }) => { status: number; body: unknown }) {
  const calls: Array<{ method: string; input: unknown }> = [];
  const server = createServer(async (req, res) => {
    let data = ""; for await (const part of req) data += part;
    const body = JSON.parse(data); calls.push(body);
    const a = answer(body); res.writeHead(a.status, { "Content-Type": "application/json" }); res.end(JSON.stringify(a.body));
  });
  await new Promise<void>(r => server.listen(socket, r));
  return { calls, close: () => new Promise<void>(r => server.close(() => r())) };
}

test("native CLI prints exactly the header JSON or one refusal code; the real service keeps headers disabled by default", async () => {
  const dir = scratchDir("cred-cli");
  assert.ok(insideScratch(dir.path));
  try {
    const socket = testSocketPath(join(dir.path, "s.sock")), configFile = join(dir.path, "waits.json");
    writeFileSync(configFile, JSON.stringify({ environment: "env", socket }), { mode: 0o600 });
    const args = ["session", "headers", "--preset", "reporter", "--audience", "jocasta", "--config", configFile];
    let reply: { status: number; body: unknown } = { status: 200, body: { Authorization: "Bearer aaa.bbb.ccc" } };
    const fake = await fakeService(socket, () => reply);
    try {
      assert.deepEqual(await cli(args), { code: 0, stdout: '{"Authorization":"Bearer aaa.bbb.ccc"}\n', stderr: "" });
      assert.deepEqual(fake.calls, [{ method: "chaldea_session_headers", input: { preset: "reporter", audience: "jocasta" } }]);
      const outcomes: Array<[{ status: number; body: unknown }, string]> = [
        [{ status: 400, body: { error: "run_expired" } }, "run_expired"],
        [{ status: 400, body: { error: "Unexpected token in " + SECRET } }, "service_unavailable"],
        [{ status: 200, body: { Authorization: "Bearer aaa.bbb.ccc", receipt: "x" } }, "invalid_response"],
        [{ status: 200, body: { Authorization: "Basic abc" } }, "invalid_response"],
      ];
      for (const [r, code] of outcomes) { reply = r; assert.deepEqual(await cli(args), { code: 1, stdout: "", stderr: code + "\n" }); }
      for (const bad of [["session", "headers", "--preset", "reporter"], ["session", "headers", "--preset", "reporter", "--audience", "jocasta", "--url", "https://x"],
        ["session", "tokens", "--preset", "reporter", "--audience", "jocasta"]])
        assert.deepEqual(await cli([...bad, "--config", configFile]), { code: 1, stdout: "", stderr: "invalid_request\n" });
      assert.equal(fake.calls.length, 5);
    } finally { await fake.close(); }
    assert.deepEqual(await cli(args), { code: 1, stdout: "", stderr: "service_unavailable\n" });
    // The real service: no sessionPolicy means sessions_disabled with no transport call.
    const answer = join(dir.path, "answer-token"); writeFileSync(answer, "fake-answer-token", { mode: 0o600 });
    const config: WaitConfig = { environment: "env", t3BaseDir: dir.path, tokenFile: join(dir.path, "t3-token"), database: join(dir.path, "w.sqlite"),
      socket, listenAddress: "127.0.0.1", port: 0, answerBaseUrl: "http://127.0.0.1:7385", answerTokenFile: answer, logFile: join(dir.path, "w.log") };
    const service = await startWaitService(config);
    try {
      await assert.rejects(callService(socket, "chaldea_session_headers", { preset: "reporter", audience: "jocasta" }),
        (e: unknown) => e instanceof ServiceRefusal && e.message === "sessions_disabled");
      await assert.rejects(callService(socket, "chaldea_session_headers", { preset: "reporter", audience: "jocasta", runId: "r" }),
        (e: unknown) => e instanceof ServiceRefusal && e.message === "invalid_request");
      assert.deepEqual(await cli(args), { code: 1, stdout: "", stderr: "sessions_disabled\n" });
    } finally { await service.stop(); }
    // With a policy but no active run: refused before any credential read or request.
    const issuer = await Issuer.make(Date.now), secretFile = join(dir.path, "absent.secret");
    const enabled = await startWaitService(config, { sessions: { policy: () => policyOf(secretFile), credentials: { transport: issuer.transport } } });
    try {
      assert.deepEqual(await cli(args), { code: 1, stdout: "", stderr: "no_active_run\n" });
      assert.equal(issuer.requests.length, 0);
    } finally { await enabled.stop(); }
    const log = existsSync(config.logFile) ? readFileSync(config.logFile, "utf8") : "";
    assert.ok(!log.includes("Bearer") && !log.includes(SECRET));
  } finally { dir.remove(); }
});

test("MCP never lists or forwards chaldea_session_headers, with or without a session policy", async () => {
  assert.deepEqual(NATIVE_ONLY_METHODS, ["chaldea_session_headers"]);
  assert.ok(![...WAIT_TOOLS, ...SESSION_TOOLS].some(t => NATIVE_ONLY_METHODS.includes(t.name)));
  const dir = scratchDir("cred-mcp");
  assert.ok(insideScratch(dir.path));
  try {
    const socket = testSocketPath(join(dir.path, "s.sock"));
    const fake = await fakeService(socket, () => ({ status: 200, body: { Authorization: "Bearer aaa.bbb.ccc" } }));
    try {
      for (const sessions of [false, true]) {
        const configFile = join(dir.path, "waits-" + sessions + ".json");
        writeFileSync(configFile, JSON.stringify({ environment: "env", socket, ...(sessions ? { sessionPolicy: "/etc/chaldea/sessions/policy.json" } : {}) }), { mode: 0o600 });
        const lines = [{ jsonrpc: "2.0", id: 1, method: "tools/list" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chaldea_session_headers", arguments: { preset: "reporter", audience: "jocasta" } } }];
        const out = await cli(["mcp", "--config", configFile], lines.map(l => JSON.stringify(l)).join("\n") + "\n");
        assert.equal(out.code, 0, out.stderr);
        const replies = out.stdout.trim().split("\n").map(l => JSON.parse(l));
        const names = (replies.find(r => r.id === 1).result.tools as Array<{ name: string }>).map(t => t.name);
        assert.ok(!names.includes("chaldea_session_headers"), "listed with sessions=" + sessions);
        assert.equal(names.includes("chaldea_session_start"), sessions);
        const call = replies.find(r => r.id === 2);
        assert.ok(call.error && !call.result, "called with sessions=" + sessions);
        assert.ok(!out.stdout.includes("Bearer"));
      }
      assert.equal(fake.calls.length, 0);
    } finally { await fake.close(); }
  } finally { dir.remove(); }
});
