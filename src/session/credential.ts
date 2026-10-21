// Preset-bound service token acquisition inside the wait service. The issuance
// gate runs before any credential read or network request, and again after
// every await before a token is cached or released. Tokens live only in this
// bounded in-memory cache: never in SQLite, logs, status, outcomes or files.
//
// Binding a token to a run is Chaldea release control. The signed token carries
// no run or thread claim, so a token already released stays valid at the resource
// until its own exp (at most 300 s, never past the run deadline).
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify, type JWK, type JWTPayload } from "jose";
import { privateFile } from "../config/files.ts";
import { identifier, strictJson } from "../access/token.ts";
import { ENROLLMENT_SCOPE, ENROLLMENT_TOKEN_SECONDS, enrollmentDigest, type Enrollment, type SessionPolicy } from "./policy.ts";
import { claimsEqual, enrollmentGrant, isNew, SERVICE_AUDIENCES, type ServiceAudience } from "./service-grant.ts";
import type { IssueDecision } from "./lifecycle.ts";

export const HEADERS_AUDIENCE = "jocasta";
/** Whole acquisition budget (JWKS and token request); the native helper allows 10 s end to end. */
export const FETCH_BUDGET_MS = 8000;
/** A cached or fresh token is released only with at least this much life left. */
export const MIN_REMAINING_SECONDS = 30;
export const MAX_SKEW_SECONDS = 30;
const MAX_ENTRIES = 16;
const MAX_TOKEN_BODY = 32 * 1024, MAX_JWKS_BODY = 64 * 1024, MAX_JWT_BYTES = 8192, MAX_KEYS = 16;
const COMPACT_JWT = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UNSAFE_HEADERS = ["jku", "x5u", "jwk", "x5c", "crit"];

/** A fixed refusal code. Messages never carry response bodies, headers, secrets or tokens. */
export class CredentialRefusal extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "CredentialRefusal"; }
}
const refusal = (code: string) => new CredentialRefusal(code);

export interface TransportRequest { method: "GET" | "POST"; headers: Record<string, string>; body?: string; signal: AbortSignal }
/** One HTTPS request. Production uses fetch with manual redirects, so a 3xx is answered, never followed. */
export type Transport = (url: string, init: TransportRequest) => Promise<Response>;
export const httpsTransport: Transport = (url, init) => fetch(url, { ...init, redirect: "manual" });
export type Gate = (preset: string, audience: string, now: number) => { decision: IssueDecision; policy: SessionPolicy | null };
export interface CredentialOptions {
  /** Test seam for a synthetic issuer; URLs are still required to be HTTPS. */
  transport?: Transport;
  /** Test seam for the clock; epoch milliseconds. */
  now?: () => number;
}

type Admitted = Extract<IssueDecision, { ok: true }>;
interface Identity { key: string; decision: Admitted; enrollment: Enrollment; secret: string }
interface Minted { token: string; exp: number }
interface Entry extends Minted { key: string }
interface Flight { preset: string; discarded: boolean; promise: Promise<Minted> }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const seconds = (ms: number) => Math.floor(ms / 1000);

/** Exactly {preset, audience}; no caller-selected claims or endpoint. */
function request(input: unknown): { preset: string; audience: ServiceAudience } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw refusal("invalid_request");
  const v = input as Record<string, unknown>, keys = Object.keys(v);
  if (keys.length !== 2 || !Object.hasOwn(v, "preset") || !Object.hasOwn(v, "audience")) throw refusal("invalid_request");
  if (!(SERVICE_AUDIENCES as readonly unknown[]).includes(v.audience)) throw refusal("unsupported_audience");
  try { identifier(v.preset); } catch { throw refusal("invalid_request"); }
  return { preset: v.preset as string, audience: v.audience as ServiceAudience };
}
function aborted(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) reject(refusal("timeout"));
    else signal.addEventListener("abort", () => reject(refusal("timeout")), { once: true });
  });
}
function json(bytes: Uint8Array, integersOnly = false): Record<string, unknown> | null {
  try {
    const v = strictJson(bytes, integersOnly);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch { return null; }
}
/** Public RSA signing keys only; private members, other types and other algorithms are dropped. */
function signingKeys(v: Record<string, unknown> | null, holonet = false): JWK[] {
  if (!v || !Array.isArray(v.keys) || v.keys.length < 1 || v.keys.length > MAX_KEYS) throw refusal("jwks_unavailable");
  if (holonet && v.keys.length > 8) throw refusal("jwks_unavailable");
  const out: JWK[] = [];
  const seen = new Set<string>();
  for (const k of v.keys as unknown[]) {
    if (!k || typeof k !== "object" || Array.isArray(k)) throw refusal("jwks_unavailable");
    const j = k as Record<string, unknown>;
    if (holonet) {
      if (["d", "p", "q", "dp", "dq", "qi", "oth"].some(key => Object.hasOwn(j, key)) ||
        j.kty !== "RSA" || (j.alg !== undefined && j.alg !== "RS256") || (j.use !== undefined && j.use !== "sig") ||
        typeof j.kid !== "string" || !j.kid || Buffer.byteLength(j.kid) > 128 || seen.has(j.kid) ||
        (j.key_ops !== undefined && (!Array.isArray(j.key_ops) ||
          (j.key_ops.length !== 0 && (j.key_ops.length !== 1 || j.key_ops[0] !== "verify"))))) throw refusal("jwks_unavailable");
      seen.add(j.kid);
      if (typeof j.n !== "string" || typeof j.e !== "string" || j.n.length > 1024 || j.e.length > 8) throw refusal("jwks_unavailable");
      const n = Buffer.from(j.n, "base64url"), e = Buffer.from(j.e, "base64url");
      if (!n.length || !e.length || n.toString("base64url") !== j.n || e.toString("base64url") !== j.e ||
        e.length > 4) throw refusal("jwks_unavailable");
      const modulus = BigInt("0x" + n.toString("hex")), exponent = Number(BigInt("0x" + e.toString("hex")));
      if (modulus % 2n !== 1n || modulus.toString(2).length < 2048 || modulus.toString(2).length > 4096 ||
        exponent < 3 || exponent > 2147483647 || exponent % 2 !== 1) throw refusal("jwks_unavailable");
    }
    if (j.kty !== "RSA" || (j.use !== undefined && j.use !== "sig") || (j.alg !== undefined && j.alg !== "RS256")) continue;
    if (typeof j.n !== "string" || typeof j.e !== "string" || j.n.length > 2048 || j.e.length > 16) throw refusal("jwks_unavailable");
    if (j.kid !== undefined && (typeof j.kid !== "string" || j.kid.length > 256)) throw refusal("jwks_unavailable");
    out.push({ kty: "RSA", n: j.n, e: j.e, alg: "RS256", use: "sig", ...(j.kid === undefined ? {} : { kid: j.kid as string }) });
  }
  if (!out.length) throw refusal("jwks_unavailable");
  return out;
}
const integer = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/**
 * Releases one Authorization header for the preset's currently active session.
 * One cache entry per preset (at most 16), keyed by session, run, thread,
 * preset hash, enrollment digest, secret content digest, audience and deadline.
 * Expired entries are pruned on each call; there are no timers.
 */
export class SessionCredentials {
  private readonly gate: Gate;
  private readonly transport: Transport;
  private readonly clock: () => number;
  private readonly cache = new Map<string, Entry>();
  private readonly flights = new Map<string, Flight>();
  constructor(gate: Gate, options: CredentialOptions = {}) {
    this.gate = gate; this.transport = options.transport ?? httpsTransport; this.clock = options.now ?? Date.now;
  }
  async headers(input: unknown): Promise<{ Authorization: string }> {
    const { preset, audience } = request(input);
    try { return { Authorization: "Bearer " + await this.release(preset, audience) }; }
    catch (error) {
      // Any refusal for a preset drops its cached token and orphans its in-flight fetch.
      this.purge(preset);
      throw error instanceof CredentialRefusal ? error : refusal("headers_unavailable");
    }
  }
  /** Cached entries currently held; for tests and bounds checks, never the tokens. */
  get size(): number { return this.cache.size; }
  private purge(preset: string): void {
    this.cache.delete(preset);
    for (const flight of this.flights.values()) if (flight.preset === preset) flight.discarded = true;
  }
  private usable(entry: Minted, decision: Admitted, now: number): boolean {
    return entry.exp - seconds(now) >= MIN_REMAINING_SECONDS && entry.exp <= decision.expiresAt;
  }
  /** Gate, then public enrollment, then the ordinary secret. Throws before any network I/O. */
  private identity(preset: string, audience: string, now: number): Identity {
    const { decision, policy } = this.gate(preset, audience, now);
    if (!decision.ok) throw refusal(decision.refusal);
    const enrollments = policy?.enrollments;
    const enrollment = enrollments && Object.hasOwn(enrollments, preset) ? enrollments[preset] : undefined;
    if (!enrollment) throw refusal("enrollment_missing");
    if (decision.profile !== preset || decision.audience !== audience || decision.service.audience !== audience) throw refusal("enrollment_mismatch");
    if ("audience" in enrollment) {
      if (!isNew(decision.service) || !isDeepStrictEqual(enrollmentGrant(enrollment), decision.service)) throw refusal("enrollment_mismatch");
    } else if (audience !== HEADERS_AUDIENCE || enrollment.project !== decision.project || isNew(decision.service) ||
      !decision.service.grants.every(g => g.resource === "project:" + enrollment.project)) throw refusal("enrollment_mismatch");
    let secret: string;
    try { secret = privateFile(enrollment.secretFile); } catch { throw refusal("credential_unavailable"); }
    const key = sha256(JSON.stringify([preset, decision.sessionId, decision.runId, decision.threadId, decision.presetHash,
      enrollmentDigest(enrollment), sha256(secret), audience, decision.service, decision.expiresAt]));
    return { key, decision, enrollment, secret };
  }
  private async release(preset: string, audience: string): Promise<string> {
    const now = this.clock();
    for (const [name, entry] of this.cache) if (entry.exp - seconds(now) < MIN_REMAINING_SECONDS) this.cache.delete(name);
    const id = this.identity(preset, audience, now);
    const cached = this.cache.get(preset);
    // A hit is released synchronously right after the gate check above.
    if (cached && cached.key === id.key && this.usable(cached, id.decision, now)) return cached.token;
    this.cache.delete(preset);
    // No fresh mint late in a run, so a new token cannot outlive it.
    if (id.decision.expiresAt - seconds(now) < ENROLLMENT_TOKEN_SECONDS) throw refusal("run_ending");
    let flight = this.flights.get(id.key);
    if (!flight || flight.discarded) {
      if (this.flights.size >= MAX_ENTRIES) throw refusal("issuer_busy");
      const created = { preset, discarded: false } as Flight;
      created.promise = this.mint(preset, id, created).finally(() => { if (this.flights.get(id.key) === created) this.flights.delete(id.key); });
      this.flights.set(id.key, created);
      flight = created;
    }
    const minted = await flight.promise;
    const after = this.recheck(preset, id, flight);
    if (!this.usable(minted, after.decision, this.clock())) throw refusal("token_expired");
    this.cache.delete(preset);
    this.cache.set(preset, { key: id.key, ...minted });
    while (this.cache.size > MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    return minted.token;
  }
  /**
   * After any await: the gate, protected policy, enrollment and secret must still
   * give the same session, run, thread, preset hash, digests and deadline, and no
   * refusal may have orphaned this fetch meanwhile.
   */
  private recheck(preset: string, id: Identity, flight: Flight): Identity {
    const after = this.identity(preset, id.decision.audience, this.clock());
    if (flight.discarded || after.key !== id.key) throw refusal("session_changed");
    return after;
  }
  /** One bounded HTTPS exchange: public JWKS first (no side effect), then a single unretried token request. */
  private async mint(preset: string, id: Identity, flight: Flight): Promise<Minted> {
    const signal = AbortSignal.timeout(FETCH_BUDGET_MS), e = id.enrollment;
    const keys = signingKeys(json(await this.fetch(e.jwksUrl, { method: "GET", headers: { Accept: "application/json" }, signal },
      MAX_JWKS_BODY, "jwks_unavailable")), "audience" in e && e.audience === "holonet");
    // A run cancelled or changed while the keys loaded never causes a token request.
    this.recheck(preset, id, flight);
    const body = new URLSearchParams({ grant_type: "client_credentials", client_id: e.clientId, username: e.username,
      password: id.secret, scope: e.scope }).toString();
    const response = json(await this.fetch(e.tokenUrl, { method: "POST", signal, body,
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" } }, MAX_TOKEN_BODY, "token_request_failed"));
    this.recheck(preset, id, flight);
    const token = response?.access_token;
    if (!response || typeof response.token_type !== "string" || response.token_type.toLowerCase() !== "bearer" ||
      typeof token !== "string" || token.length > MAX_JWT_BYTES || !COMPACT_JWT.test(token)) throw refusal("token_response_invalid");
    return { token, exp: await this.verify(token, keys, id) };
  }
  private async fetch(url: string, init: TransportRequest, max: number, code: string): Promise<Uint8Array> {
    // Production has no plain-HTTP override; policy parsing refuses it too.
    if (new URL(url).protocol !== "https:") throw refusal(code);
    // One abort listener per request; its later rejection is always handled.
    const stop = aborted(init.signal);
    stop.catch(() => {});
    let response: Response;
    try { response = await Promise.race([this.transport(url, init), stop]); }
    catch { throw refusal(code); }
    try {
      if (response.status !== 200 || response.redirected || !response.body) throw refusal(code);
      const reader = response.body.getReader(), parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await Promise.race([reader.read(), stop]);
          if (part.done) break;
          size += part.value.byteLength;
          if (size > max) throw refusal(code);
          parts.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      return Buffer.concat(parts);
    } catch { void response.body?.cancel().catch(() => {}); throw refusal(code); }
  }
  private async verify(token: string, keys: JWK[], id: Identity): Promise<number> {
    const e = id.enrollment, decision = id.decision, now = this.clock(), at = seconds(now);
    const typed = "audience" in e, skew = typed && e.audience === "holonet" ? 30 : typed && e.audience !== "ov" ? 10 : MAX_SKEW_SECONDS;
    if (typed) {
      // jose parses JSON after signature verification; reject duplicate names first as well.
      try {
        if (e.audience === "holonet" && (Buffer.byteLength(token) > 8192 ||
          Buffer.from(token.split(".")[1] ?? "", "base64url").length > 4096 ||
          Buffer.from(token.split(".")[0] ?? "", "base64url").length > 2048)) throw new Error();
        for (const [index, part] of token.split(".").slice(0, 2).entries()) {
          const bytes = Buffer.from(part, "base64url");
          if (bytes.toString("base64url") !== part || !json(bytes, e.audience === "holonet" && index === 1)) throw new Error();
        }
      } catch { throw refusal("token_invalid"); }
    }
    let header: ReturnType<typeof decodeProtectedHeader>;
    try { header = decodeProtectedHeader(token); } catch { throw refusal("token_invalid"); }
    // Keys come only from the pinned JWKS URL; token-selected key locations are refused.
    if (header.alg !== "RS256" || UNSAFE_HEADERS.some(k => Object.hasOwn(header, k))) throw refusal("token_invalid");
    if (typed) {
      if (typeof header.kid !== "string" || !header.kid || Buffer.byteLength(header.kid) > 128 ||
        Object.hasOwn(header, "b64")) throw refusal("token_invalid");
      if (e.audience === "ha" ? /[\x00-\x1f\x7f]/.test(header.kid) :
        Object.keys(header).some(k => !["alg", "kid", "typ"].includes(k))) throw refusal("token_invalid");
      if (e.audience === "holonet" && header.typ !== undefined &&
        (typeof header.typ !== "string" || Buffer.byteLength(header.typ) > 32)) throw refusal("token_invalid");
      if (e.audience === "ov" && (!/^[A-Za-z0-9_.-]{1,128}$/.test(header.kid) ||
        (header.typ !== undefined && !["JWT", "at+jwt"].includes(header.typ)))) throw refusal("token_invalid");
    }
    let c: JWTPayload;
    try {
      ({ payload: c } = await jwtVerify(token, createLocalJWKSet({ keys }), { algorithms: ["RS256"], issuer: e.issuer,
        clockTolerance: skew, currentDate: new Date(now) }));
    } catch { throw refusal("token_invalid"); }
    if (typed && e.audience === "holonet" && (typeof c.sub !== "string" || c.sub.length < 1 || c.sub.length > 128 || /[^\x21-\x7e]/.test(c.sub) ||
      (c.nbf !== undefined && (!integer(c.nbf) || !integer(c.iat) || c.nbf < c.iat)))) throw refusal("token_claims_invalid");
    if (typed && e.audience === "ov" && Object.keys(c).length > 32) throw refusal("token_claims_invalid");
    const aud = !typed && Array.isArray(c.aud) && c.aud.length === 1 ? c.aud[0] : c.aud;
    if (aud !== e.resource || typeof c.sub !== "string" || !c.sub || (typed && e.audience === "ov" ? [...c.sub].length : c.sub.length) > 256) throw refusal("token_claims_invalid");
    if (typed && (e.audience === "ov" ? [...c.sub!].some(ch => ch.codePointAt(0)! < 32) :
      Buffer.byteLength(c.sub!) > 256 || (e.audience === "ha" && /[\x00-\x1f\x7f]/.test(c.sub!)))) throw refusal("token_claims_invalid");
    if (!integer(c.iat) || !integer(c.exp) || (c.nbf !== undefined && !integer(c.nbf))) throw refusal("token_claims_invalid");
    if (c.iat > at + skew || (c.nbf !== undefined && (c.nbf > at + skew || (typed && e.audience !== "ov" && c.nbf >= c.exp)))) throw refusal("token_claims_invalid");
    if (c.exp <= c.iat || c.exp - c.iat > e.maxTokenSeconds || c.exp - at < MIN_REMAINING_SECONDS) throw refusal("token_claims_invalid");
    if (typed ? !claimsEqual(c, enrollmentGrant(e)) :
      c.scope !== ENROLLMENT_SCOPE || !isDeepStrictEqual(c.jocasta_projects, [decision.project])) throw refusal("token_claims_invalid");
    if (c.exp > decision.expiresAt) throw refusal("token_outlives_run");
    return c.exp;
  }
}
