// Protected fixed session presets. The policy file is operator-owned public
// configuration: it names instances, prompts and grant ceilings, never credentials.
import { lstatSync } from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { createHash } from "node:crypto";
import { readTrustedFile } from "../config/files.ts";
import { AccessError, identifier, strictJson } from "../access/token.ts";
import { isDeepStrictEqual } from "node:util";
import { grantKeys, isNew, parseServiceGrant, RESOURCES, type NewServiceGrant, type SessionServiceGrant } from "./service-grant.ts";

export const MAX_PRESETS = 16;
export const MAX_SESSION_SECONDS = 86_400;
export const MAX_PROMPT_BYTES = 8192;
const RUNTIME_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
const INTERACTION_MODES = ["default", "plan"] as const;

/** A clear, coded denial. Messages carry codes and field names, never file bytes. */
export class SessionRefusal extends Error {
  readonly code: string;
  constructor(code: string, detail?: string) {
    super(detail ? code + ": " + detail : code); this.code = code; this.name = "SessionRefusal";
  }
}
export interface SessionCeiling { project: string; maxSeconds: number; services: SessionServiceGrant[]; destinations: string[] }
export interface SessionPreset {
  id: string; instanceId: string; model: string; options?: Array<{ id: string; value: string | boolean }>;
  runtimeMode: typeof RUNTIME_MODES[number]; interactionMode: typeof INTERACTION_MODES[number];
  projectId: string; title: string; prompt: string; inputs: Record<string, string>;
  project: string; services: SessionServiceGrant[]; maxSeconds: number; delegate: boolean; destinations: string[];
}
/**
 * Public description of one ordinary host×profile Authentik enrollment for a
 * preset. It names where to ask and what to expect, never the secret itself:
 * secretFile points at the owner-only app password on this host.
 */
interface CommonEnrollment {
  form: "app_password"; issuer: string; tokenUrl: string; jwksUrl: string; clientId: string; username: string;
  resource: string; maxTokenSeconds: typeof ENROLLMENT_TOKEN_SECONDS; secretFile: string;
}
export type Enrollment = LegacyJocastaEnrollment | (CommonEnrollment & NewServiceGrant);
export interface LegacyJocastaEnrollment {
  form: "app_password"; issuer: string; tokenUrl: string; jwksUrl: string; clientId: string; username: string;
  scope: typeof ENROLLMENT_SCOPE; resource: string; project: string; maxTokenSeconds: typeof ENROLLMENT_TOKEN_SECONDS; secretFile: string;
}
export const ENROLLMENT_SCOPE = "jocasta.read";
export const ENROLLMENT_TOKEN_SECONDS = 300;
export interface SessionPolicy {
  environment: string; ceilings: SessionCeiling[]; presets: Record<string, SessionPreset>;
  /** Optional; absent leaves sessions and their gate exactly as before. Keyed by preset ID. */
  enrollments?: Record<string, Enrollment>;
}

const invalid = (detail: string): never => { throw new SessionRefusal("session_policy_invalid", detail); };
function record(value: unknown, name: string, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(name + " must be an object");
  const v = value as Record<string, unknown>;
  for (const key of required) if (!Object.hasOwn(v, key)) invalid(name + " requires " + key);
  for (const key of Object.keys(v)) if (!required.includes(key) && !optional.includes(key)) invalid(name + " has unknown key " + key);
  return v;
}
function dict(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(name + " must be an object");
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || Buffer.byteLength(value) > max || value.includes("\0"))
    invalid(name + " must be a trimmed non-empty string");
  return value as string;
}
function id(value: unknown, name: string): string {
  try { identifier(value); return value; } catch { return invalid(name + " must be an identifier"); }
}
function duration(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SESSION_SECONDS) invalid(name + " must be 1..86400 seconds");
  return value as number;
}
function list<T>(value: unknown, name: string, max: number, item: (v: unknown, n: string) => T): T[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > max) invalid(name + " must hold 1.." + max + " entries");
  return (value as unknown[]).map((v, i) => item(v, name + "[" + i + "]"));
}
function services(value: unknown, name: string): SessionServiceGrant[] {
  const out = list(value, name, 7, (v, n) => {
    try { return parseServiceGrant(v); }
    catch (error) { return invalid(n + " " + (error instanceof AccessError ? error.message : "invalid")); }
  });
  if (new Set(out.map(s => s.audience)).size !== out.length) invalid(name + " repeats an audience");
  return out;
}
function destinations(value: unknown, name: string): string[] {
  const out = list(value, name, 16, (v, n) => string(v, n));
  if (new Set(out).size !== out.length) invalid(name + " repeats a destination");
  return out;
}
/** The exact initial message text a preset sends. Inputs are fixed policy data. */
export function presetMessage(preset: Pick<SessionPreset, "prompt" | "inputs">): string {
  return Object.keys(preset.inputs).length
    ? preset.prompt + "\n\nFixed inputs (JSON): " + JSON.stringify(preset.inputs) : preset.prompt;
}
function preset(key: string, value: unknown): SessionPreset {
  const name = "preset " + key;
  const p = record(value, name, ["instanceId", "model", "runtimeMode", "interactionMode", "projectId", "title", "prompt",
    "project", "services", "maxSeconds", "delegate", "destinations"], ["options", "inputs"]);
  if (!RUNTIME_MODES.includes(p.runtimeMode as never)) invalid(name + " runtimeMode is unsupported");
  if (!INTERACTION_MODES.includes(p.interactionMode as never)) invalid(name + " interactionMode is unsupported");
  if (typeof p.delegate !== "boolean") invalid(name + " delegate must be a boolean");
  if (typeof p.prompt !== "string" || !p.prompt.trim() || p.prompt.includes("\0")) invalid(name + " prompt must be non-empty text");
  const inputs: Record<string, string> = {};
  if (p.inputs !== undefined) {
    const entries = Object.entries(dict(p.inputs, name + " inputs"));
    if (entries.length > 16) invalid(name + " inputs exceed 16 entries");
    for (const [k, v] of entries) { id(k, name + " input key"); inputs[k] = string(v, name + " input " + k, 1024); }
  }
  const options = p.options === undefined ? undefined : list(p.options, name + " options", 16, (v, n) => {
    const o = record(v, n, ["id", "value"]);
    if (typeof o.value !== "string" && typeof o.value !== "boolean") invalid(n + " value must be a string or boolean");
    return { id: string(o.id, n + " id"), value: o.value as string | boolean };
  });
  // Fixed key order makes the canonical JSON, and so the policy hash, deterministic.
  const out: SessionPreset = {
    id: id(key, "preset id"), instanceId: string(p.instanceId, name + " instanceId"), model: string(p.model, name + " model"),
    ...(options ? { options } : {}),
    runtimeMode: p.runtimeMode as SessionPreset["runtimeMode"], interactionMode: p.interactionMode as SessionPreset["interactionMode"],
    projectId: string(p.projectId, name + " projectId"), title: string(p.title, name + " title"), prompt: p.prompt as string, inputs,
    project: id(p.project, name + " project"), services: services(p.services, name + " services"),
    maxSeconds: duration(p.maxSeconds, name + " maxSeconds"), delegate: p.delegate as boolean,
    destinations: destinations(p.destinations, name + " destinations"),
  };
  if (Buffer.byteLength(presetMessage(out)) > MAX_PROMPT_BYTES) invalid(name + " message exceeds 8 KiB");
  return out;
}
/** A canonical HTTPS URL: no credentials, query or fragment, and exactly as the URL parser writes it. */
function httpsUrl(value: unknown, name: string): URL {
  const text = string(value, name, 2048);
  let url: URL | undefined;
  try { url = new URL(text); } catch { invalid(name + " must be an absolute URL"); }
  if (!url || url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    text.includes("?") || text.includes("#") || url.href !== text)
    invalid(name + " must be a canonical HTTPS URL without credentials, query or fragment");
  return url!;
}
function printable(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !new RegExp("^[\\x21-\\x7e]{1," + max + "}$").test(value)) invalid(name + " must be printable ASCII without spaces");
  return value as string;
}
const ENROLLMENT_KEYS = ["form", "issuer", "tokenUrl", "jwksUrl", "clientId", "username", "scope", "resource", "project",
  "maxTokenSeconds", "secretFile"] as const;
function enrollment(key: string, value: unknown, presets: Record<string, SessionPreset>): Enrollment {
  const name = "enrollment " + key;
  const preset = Object.hasOwn(presets, key) ? presets[key] : undefined;
  if (!preset) return invalid(name + " names no preset");
  const raw = dict(value, name), typed = Object.hasOwn(raw, "audience");
  let service: NewServiceGrant | undefined;
  if (typed) {
    try {
      const keys = grantKeys(raw.audience);
      service = parseServiceGrant(Object.fromEntries(keys.map(k => [k, raw[k]]))) as NewServiceGrant;
    } catch { invalid(name + " invalid service grant"); }
  }
  const e = record(value, name, typed
    ? [...ENROLLMENT_KEYS.filter(k => k !== "project" && k !== "scope"), ...grantKeys(raw.audience)] : ENROLLMENT_KEYS);
  // Only the primary ordinary app-password form exists; a fallback form needs its own review.
  if (e.form !== "app_password") invalid(name + " form must be app_password");
  const issuer = httpsUrl(e.issuer, name + " issuer"), tokenUrl = httpsUrl(e.tokenUrl, name + " tokenUrl");
  const jwksUrl = httpsUrl(e.jwksUrl, name + " jwksUrl"), resource = httpsUrl(e.resource, name + " resource");
  if (tokenUrl.origin !== issuer.origin || jwksUrl.origin !== issuer.origin) invalid(name + " tokenUrl and jwksUrl must share the issuer origin");
  if (!typed && e.scope !== ENROLLMENT_SCOPE) invalid(name + " scope must be " + ENROLLMENT_SCOPE);
  if (e.maxTokenSeconds !== ENROLLMENT_TOKEN_SECONDS) invalid(name + " maxTokenSeconds must be " + ENROLLMENT_TOKEN_SECONDS);
  let project: string | undefined;
  if (service) {
    if (!issuer.href.endsWith("/") || jwksUrl.href !== issuer.href + "jwks/" ||
      tokenUrl.href !== issuer.origin + "/application/o/token/" || resource.href !== RESOURCES[service.audience])
      invalid(name + " endpoints do not match the service provider");
    if (preset.services.length !== 1 || !isDeepStrictEqual(preset.services[0], service))
      invalid(name + " must exactly match the preset service");
  } else {
    project = id(e.project, name + " project");
    if (project !== preset.project) invalid(name + " project must equal the preset project");
    const jocasta = preset.services.find(s => !isNew(s) && s.audience === "jocasta");
    if (!jocasta || isNew(jocasta) || !jocasta.grants.every(g => g.resource === "project:" + project))
      invalid(name + " preset must grant Jocasta access to exactly project:" + project);
  }
  const secretFile = string(e.secretFile, name + " secretFile", 4096);
  if (!isAbsolute(secretFile) || normalize(secretFile) !== secretFile || secretFile.endsWith("/"))
    invalid(name + " secretFile must be a normalized absolute path");
  if (service) return { form: "app_password", issuer: issuer.href, tokenUrl: tokenUrl.href, jwksUrl: jwksUrl.href,
    clientId: printable(e.clientId, name + " clientId", 255), username: printable(e.username, name + " username", 150),
    resource: resource.href, ...service, maxTokenSeconds: ENROLLMENT_TOKEN_SECONDS, secretFile };
  // Fixed key order makes the legacy enrollment digest deterministic.
  return { form: "app_password", issuer: issuer.href, tokenUrl: tokenUrl.href, jwksUrl: jwksUrl.href,
    clientId: printable(e.clientId, name + " clientId", 255), username: printable(e.username, name + " username", 150),
    scope: ENROLLMENT_SCOPE, resource: resource.href, project: project!, maxTokenSeconds: ENROLLMENT_TOKEN_SECONDS, secretFile };
}
/** Public digest over every enrollment field; any edit changes it and invalidates cached tokens. */
export function enrollmentDigest(e: Enrollment): string {
  return createHash("sha256").update(JSON.stringify(e)).digest("hex");
}
export function parsePolicy(value: unknown, environment: string): SessionPolicy {
  if (Buffer.byteLength(JSON.stringify(value) ?? "") > 65_536) invalid("policy exceeds 64 KiB");
  const v = record(value, "policy", ["version", "environment", "ceilings", "presets"], ["enrollments"]);
  if (v.version !== 1) invalid("unsupported version");
  if (v.environment !== environment) throw new SessionRefusal("session_policy_environment", "policy names another T3 environment");
  const ceilings = list(v.ceilings, "ceilings", 8, (c, n) => {
    const r = record(c, n, ["project", "maxSeconds", "services", "destinations"]);
    return { project: id(r.project, n + " project"), maxSeconds: duration(r.maxSeconds, n + " maxSeconds"),
      services: services(r.services, n + " services"), destinations: destinations(r.destinations, n + " destinations") };
  });
  const raw = dict(v.presets, "presets");
  if (Object.keys(raw).length > MAX_PRESETS) invalid("more than 16 presets");
  const presets: Record<string, SessionPreset> = Object.create(null);
  for (const [key, value] of Object.entries(raw)) presets[key] = preset(key, value);
  if (v.enrollments === undefined) {
    if (Object.values(presets).some(p => p.services.some(isNew))) invalid("new services require enrollment");
    return { environment, ceilings, presets };
  }
  const rawEnrollments = dict(v.enrollments, "enrollments");
  if (Object.keys(rawEnrollments).length > MAX_PRESETS) invalid("more than 16 enrollments");
  const enrollments: Record<string, Enrollment> = Object.create(null);
  for (const [key, value] of Object.entries(rawEnrollments)) enrollments[key] = enrollment(key, value, presets);
  const typed = Object.entries(enrollments).filter(([, e]) => "audience" in e);
  for (const [key, e] of typed) for (const [otherKey, other] of Object.entries(enrollments)) {
    if (key === otherKey || !("audience" in e)) continue;
    if (e.secretFile === other.secretFile || (new URL(e.issuer).origin === new URL(other.issuer).origin && e.username === other.username))
      invalid("new enrollments must use distinct secret files and accounts");
    if (new URL(e.issuer).origin === new URL(other.issuer).origin && e.audience !== ("audience" in other ? other.audience : "jocasta") &&
      (e.issuer === other.issuer || e.clientId === other.clientId))
      invalid("different services require distinct providers and client IDs");
  }
  for (const p of Object.values(presets)) if (p.services.some(isNew) &&
    (!Object.hasOwn(enrollments, p.id) || !("audience" in enrollments[p.id]!))) invalid("new services require enrollment");
  return { environment, ceilings, presets, enrollments };
}
export function presetHash(preset: SessionPreset): string {
  return createHash("sha256").update(JSON.stringify(preset)).digest("hex");
}
export interface PolicyFileRules { owners?: readonly number[]; stopAt?: string }
/**
 * The policy must be readable by the ordinary service UID, so it is public, not
 * 0600. Integrity comes from ownership instead: the file and every ancestor are
 * owned by an allowed UID (root by default) and are not group/other writable.
 * stopAt bounds the ancestor walk for fixtures only; production checks to "/".
 */
export function loadSessionPolicy(path: string, environment: string, rules: PolicyFileRules = {}): SessionPolicy {
  const owners = rules.owners ?? [0];
  if (!isAbsolute(path)) throw new SessionRefusal("session_policy_unsafe", "path must be absolute");
  let bytes: Buffer;
  try {
    for (let dir = dirname(path); ; dir = dirname(dir)) {
      const s = lstatSync(dir);
      if (!s.isDirectory() || s.isSymbolicLink() || !owners.includes(s.uid) || (s.mode & 0o022) !== 0)
        throw new SessionRefusal("session_policy_unsafe", "ancestor directory is not protected");
      if (dir === rules.stopAt || dir === dirname(dir)) break;
    }
    bytes = readTrustedFile(path, { owners, maxBytes: 65_536 });
  } catch (error) {
    if (error instanceof SessionRefusal) throw error;
    throw new SessionRefusal("session_policy_unsafe", "policy file is missing, unsafe or unreadable");
  }
  let value: unknown;
  try { value = strictJson(bytes); } catch { throw new SessionRefusal("session_policy_invalid", "policy requires strict JSON"); }
  return parsePolicy(value, environment);
}
