import { compactVerify, importJWK } from "jose";
import type { TrustStore, TrustedKey, Clock } from "./trust.ts";

export const MAX_TOKEN_SECONDS = 13 * 60;
export const MAX_SKEW_SECONDS = 30;
export const TOKEN_TYPE = "chaldea-run+jwt";
export const AUDIENCES = ["homelab", "feed", "akasha", "jocasta", "ov", "huyang", "github-broker"] as const;
export type Audience = typeof AUDIENCES[number];
export interface Grant { resource: string; actions: string[] }
export interface RunClaims {
  v: 1; iss: string; sub: string; aud: Audience; run_id: string; project: string;
  iat: number; nbf: number; exp: number; jti: string; grants: Grant[];
  source?: string; host?: string;
}
export interface Operation { audience: Audience; resource: string; action: string }
export class AccessError extends Error {
  constructor(code: string) { super(code); this.name = "AccessError"; }
}
export function requireAccess(condition: unknown, code: string): asserts condition {
  if (!condition) throw new AccessError(code);
}
export function object(value: unknown): Record<string, unknown> {
  requireAccess(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_object");
  return value as Record<string, unknown>;
}
export function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  requireAccess(required.every(k => Object.hasOwn(value, k)) &&
    Object.keys(value).every(k => required.includes(k) || optional.includes(k)), "invalid_fields");
}
export function identifier(value: unknown): asserts value is string {
  requireAccess(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value), "invalid_identifier");
}
export function issuerName(value: unknown): asserts value is string {
  requireAccess(typeof value === "string" && /^chaldea:[a-z0-9][a-z0-9.-]{0,126}$/.test(value), "invalid_issuer");
}
export function seconds(value: unknown): asserts value is number {
  requireAccess(typeof value === "number" && Number.isSafeInteger(value) && value >= 0, "invalid_time");
}
export function resourceName(value: unknown): asserts value is string {
  requireAccess(typeof value === "string" && /^[\x21-\x7e]{1,512}$/.test(value) &&
    !value.includes("*") && !value.includes("\\"), "invalid_resource");
}
export function audienceName(value: unknown): asserts value is Audience {
  requireAccess(AUDIENCES.includes(value as Audience), "invalid_audience");
}
export function grants(value: unknown): asserts value is Grant[] {
  requireAccess(Array.isArray(value) && value.length > 0 && value.length <= 32, "invalid_grants");
  const resources = new Set<string>();
  for (const item of value) {
    const g = object(item); exact(g, ["resource", "actions"]); resourceName(g.resource);
    requireAccess(!resources.has(g.resource), "duplicate_resource"); resources.add(g.resource);
    requireAccess(Array.isArray(g.actions) && g.actions.length > 0 && g.actions.length <= 16, "invalid_actions");
    const actions = new Set<string>();
    for (const action of g.actions) {
      identifier(action); requireAccess(!action.includes("*") && !actions.has(action), "invalid_action");
      actions.add(action);
    }
  }
}
/** Strict JSON/UTF-8, duplicate names (including escaped names), and bounded nesting.
 * JSON.parse validates syntax; the scanner checks names and numeric lexemes. */
export function strictJson(bytes: Uint8Array, integersOnly = false): unknown {
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  const value: unknown = JSON.parse(text);
  const stack: Array<Set<string> | null> = [];
  const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (integersOnly && /^-?\d/.test(token))
      requireAccess(/^(?:0|[1-9][0-9]*)$/.test(token), "non_integer_literal");
    if (token === "{") stack.push(new Set());
    else if (token === "[") stack.push(null);
    else if (token === "}" || token === "]") stack.pop();
    else if (token.startsWith('"') && /^\s*:/.test(text.slice(match.index + token.length))) {
      const keys = stack.at(-1);
      requireAccess(keys, "invalid_json");
      const name = JSON.parse(token) as string;
      requireAccess(!keys.has(name), "duplicate_json_name"); keys.add(name);
    }
    requireAccess(stack.length <= 16, "json_too_deep");
  }
  return value;
}
export function segment(value: string): Uint8Array {
  requireAccess(/^[A-Za-z0-9_-]+$/.test(value), "invalid_base64url");
  const bytes = Buffer.from(value, "base64url");
  requireAccess(bytes.toString("base64url") === value, "invalid_base64url");
  return bytes;
}
export function compactParts(token: unknown, maxBytes = 16384): { header: Record<string, unknown>; payload: Uint8Array } {
  requireAccess(typeof token === "string" && token.length <= maxBytes, "invalid_token");
  const parts = token.split(".");
  requireAccess(parts.length === 3 && parts.every(Boolean), "invalid_compact");
  const header = object(strictJson(segment(parts[0]!), true));
  const payload = segment(parts[1]!);
  requireAccess(segment(parts[2]!).length === 64, "invalid_signature");
  return { header, payload };
}
export function validateClaims(value: unknown): RunClaims {
  const c = object(value);
  exact(c, ["v", "iss", "sub", "aud", "run_id", "project", "iat", "nbf", "exp", "jti", "grants"], ["source", "host"]);
  requireAccess(c.v === 1, "invalid_version"); issuerName(c.iss); identifier(c.sub);
  audienceName(c.aud); identifier(c.run_id); identifier(c.project);
  seconds(c.iat); seconds(c.nbf); seconds(c.exp);
  requireAccess(c.nbf >= c.iat && c.exp > c.nbf && c.exp - c.iat <= MAX_TOKEN_SECONDS, "invalid_lifetime");
  requireAccess(typeof c.jti === "string" && /^[A-Za-z0-9_-]{22,64}$/.test(c.jti), "invalid_jti");
  grants(c.grants);
  if (c.aud === "feed" || c.aud === "akasha") {
    identifier(c.source); identifier(c.host);
    requireAccess(c.host === c.iss.slice("chaldea:".length), "invalid_host");
  } else requireAccess(c.source === undefined && c.host === undefined, "unexpected_identity");
  return c as unknown as RunClaims;
}
export function subset(requested: Grant[], ceiling: Grant[]): boolean {
  return requested.every(g => g.actions.every(a =>
    ceiling.some(c => c.resource === g.resource && c.actions.includes(a))));
}
export function allows(claims: RunClaims, key: TrustedKey): boolean {
  return key.ceilings.some(c => c.audience === claims.aud && c.profile === claims.sub &&
    c.project === claims.project && c.source === claims.source && subset(claims.grants, c.grants));
}
export function checkTime(c: RunClaims, key: TrustedKey, now: number, skew: number): void {
  requireAccess(c.iat <= now + skew && c.nbf <= now + skew && now < c.exp + skew, "token_time");
  requireAccess(c.iat >= key.not_before && c.iat < key.issue_until &&
    c.exp + MAX_SKEW_SECONDS <= key.verify_until && now < key.verify_until, "key_time");
}
export interface VerifiedAccess {
  claims: RunClaims;
  /** No leeway for ongoing work: cancel streams/sessions at this wall deadline. */
  validUntil: number;
  /** Revalidate before every operation/chunk and after waits; observes trust removal and clocks. */
  recheck(): Promise<void>;
}
export async function verifyToken(
  token: unknown, operation: Operation, trust: TrustStore, clock: Clock, skew = MAX_SKEW_SECONDS,
): Promise<VerifiedAccess> {
  requireAccess(Number.isInteger(skew) && skew >= 0 && skew <= MAX_SKEW_SECONDS, "invalid_skew");
  operation = structuredClone(operation);
  audienceName(operation.audience); resourceName(operation.resource); identifier(operation.action);
  const { header, payload } = compactParts(token);
  exact(header, ["alg", "typ", "kid"]);
  requireAccess(header.alg === "EdDSA" && header.typ === TOKEN_TYPE, "invalid_header"); identifier(header.kid);
  const claims = validateClaims(strictJson(payload, true));
  requireAccess(claims.aud === operation.audience, "wrong_audience");
  const bundle = await trust.snapshot();
  const key = bundle.keys.find(k => k.issuer === claims.iss && k.kid === header.kid);
  requireAccess(key, "unknown_key");
  await compactVerify(token as string, await importJWK(key.public_key, "EdDSA"), { algorithms: ["EdDSA"] });
  trust.assertCurrent(bundle.sequence);
  const now = clock.check();
  checkTime(claims, key, now, skew);
  requireAccess(allows(claims, key), "issuer_ceiling");
  requireAccess(claims.grants.some(g => g.resource === operation.resource && g.actions.includes(operation.action)), "forbidden");
  return {
    claims,
    validUntil: Math.min(claims.exp, key.verify_until, bundle.expires_at),
    async recheck() { await verifyToken(token, operation, trust, clock, skew); },
  };
}
