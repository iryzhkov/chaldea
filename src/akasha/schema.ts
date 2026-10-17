import { createHash } from "node:crypto";
import { strictJson } from "../access/token.ts";

export const KiB = 1024;
export const MAX_EVENT = 64 * KiB, MAX_LEGACY = 256 * KiB, MAX_ENVELOPE = 320 * KiB;
export const NEW_FEED_ID = 1_000_000_000_000;
export const KINDS = ["feed_post", "report", "quota_parked", "quota_reset_unknown", "quota_resumed",
  "provider_switched", "provider_switch_failed", "tool_call", "deployment_finished", "job_finished",
  "task_started", "task_finished", "review_verdict", "review_note", "agent_status"] as const;
export type Kind = typeof KINDS[number];
export class HttpError extends Error {
  status: number;
  constructor(status: number, code: string) { super(code); this.status = status; }
}
export function ensure(ok: unknown, code: string, status = 400): asserts ok {
  if (!ok) throw new HttpError(status, code);
}
export function record(value: unknown): Record<string, unknown> {
  ensure(value !== null && typeof value === "object" && !Array.isArray(value), "invalid_object");
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  ensure(Object.keys(value).every(k => allowed.includes(k)), "unknown_field");
}
export function text(value: unknown, max: number, required = false): string {
  ensure(typeof value === "string", "invalid_string");
  ensure(Array.from(value).length <= max, "field_too_large", 413);
  ensure(!required || value.trim().length > 0, "required_field");
  return value;
}
export function timestamp(value: unknown): string {
  const s = text(value, 64, true);
  ensure(/^\d{4}-\d\d-\d\dT/.test(s) && Number.isFinite(Date.parse(s)), "invalid_timestamp");
  return new Date(s).toISOString();
}
export function parse(bytes: Uint8Array): Record<string, unknown> {
  try { return record(strictJson(bytes)); } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "invalid_json");
  }
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object") return "{" + Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v)).join(",") + "}";
  return JSON.stringify(value);
}
export const hash = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
export function eventId(tuple: string[]): string {
  const h = createHash("sha256").update("akasha-event-v1\0");
  for (const s of tuple) { const b = Buffer.from(s); const n = Buffer.alloc(4); n.writeUInt32BE(b.length); h.update(n).update(b); }
  return h.digest("hex");
}
export function idempotencyKey(value: unknown): string {
  ensure(typeof value === "string" && /^[\x20-\x7e]{1,256}$/.test(value), "invalid_idempotency_key");
  return value;
}
export interface Identity {
  issuer: string; profile: string; project: string; source: string; host: string; run_id: string; source_id: string;
}
export interface Input {
  kind: Kind; occurred_at: string | null; severity: string; title: string; body: string;
  tags: string[]; link: string; data: Record<string, unknown>;
}
export interface Envelope extends Omit<Input, "occurred_at">, Identity {
  v: 1; event_id: string; received_at: string; occurred_at: string;
  provenance: { type: "verified"; request_hash: string; feed_id: number | null } | { type: "legacy-feed"; legacy_id: number; display_host: string; display_source: string; request_hash: string };
}
export interface FeedRow {
  id: number; created_at: string; host: string; source: string; severity: string;
  title: string; body: string; tags: string; link: string;
}
export function normaliseTags(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw || "").replaceAll(",", " ").split(/\s+/);
  return [...new Set(parts.map(p => String(p).trim().toLowerCase().replace(/[^a-z0-9._/-]/g, "-")).filter(Boolean))];
}
const COMMON = ["v", "kind", "source", "host", "run_id", "project", "occurred_at", "severity", "title", "body", "tags", "link", "data"];
const DATA: Record<Kind, readonly string[]> = {
  feed_post: [], report: ["status", "checks"],
  quota_parked: ["thread_id", "run_id", "provider", "reset_at", "transition_id"],
  quota_reset_unknown: ["thread_id", "run_id", "provider", "transition_id"],
  quota_resumed: ["thread_id", "run_id", "provider", "transition_id"],
  provider_switched: ["thread_id", "run_id", "provider", "previous_provider", "model", "transition_id"],
  provider_switch_failed: ["thread_id", "run_id", "provider", "previous_provider", "model", "transition_id", "error_class"],
  tool_call: ["ts", "session", "proc", "seq", "client", "tool", "args", "outcome", "ok", "err", "exit", "ms",
    "tool_source", "root", "raw_line_hash"],
  deployment_finished: ["deployment_id", "status", "revision"],
  job_finished: ["job_id", "invocation_id", "status", "exit", "ms"],
  task_started: ["task_id", "thread_id", "model", "status"],
  task_finished: ["task_id", "thread_id", "model", "status"],
  review_verdict: ["task_id", "thread_id", "model", "verdict", "revision"],
  review_note: ["task_id", "thread_id", "model", "revision"],
  agent_status: ["thread_id", "model", "status"],
};
function validateData(kind: Kind, data: Record<string, unknown>): void {
  fields(data, DATA[kind]);
  ensure(Buffer.byteLength(canonical(data)) <= 48 * KiB, "data_too_large", 413);
  for (const [key, value] of Object.entries(data)) {
    if (key === "checks") {
      ensure(Array.isArray(value) && value.length <= 100, "invalid_checks");
      for (const item of value) { const c = record(item); fields(c, ["name", "status"]); text(c.name, 128, true); text(c.status, 32, true); }
    } else if (key === "args") {
      ensure(Array.isArray(value) && value.length <= 128, "invalid_argument_names");
      for (const name of value) ensure(typeof name === "string" && (name === "?" || /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name)), "invalid_argument_name");
    } else if (["seq", "exit", "ms"].includes(key)) {
      ensure(typeof value === "number" && Number.isSafeInteger(value) && (key === "exit" || value >= 0), "invalid_number");
    } else if (key === "ok") ensure(typeof value === "boolean", "invalid_ok");
    else if (key === "err" || key === "error_class") {
      // Only a class/fingerprint, never arbitrary tool stderr or operands.
      ensure(typeof value === "string" && /^[a-zA-Z0-9_.:/-]{0,160}$/.test(value), "invalid_error_class");
    } else if (key === "ts") timestamp(value);
    else if (key === "raw_line_hash") ensure(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "invalid_line_hash");
    else text(value, key === "root" ? 512 : 256, true);
  }
  if (kind === "tool_call") {
    for (const k of ["ts", "session", "proc", "seq", "client", "tool", "args", "outcome", "ok", "tool_source", "raw_line_hash"])
      ensure(Object.hasOwn(data, k), "missing_tool_field");
  }
}
export function normalize(payload: Record<string, unknown>, identity: Identity, legacy: boolean): Input {
  fields(payload, legacy ? ["title", "body", "severity", "tags", "link", "host", "source"] : COMMON);
  for (const name of ["source", "host", "run_id", "project"] as const)
    ensure(payload[name] === undefined || payload[name] === identity[name], "identity_mismatch", 403);
  if (!legacy) ensure(payload.v === 1, "unknown_version");
  const kind = legacy ? "feed_post" : payload.kind;
  ensure(KINDS.includes(kind as Kind), "unknown_kind");
  const title = legacy ? Array.from(text(payload.title ?? "", MAX_LEGACY, true).trim()).slice(0, 500).join("")
    : text(payload.title ?? "", 500, kind !== "tool_call");
  const severity = legacy ? String(payload.severity || "info").toLowerCase() : payload.severity ?? "info";
  ensure(["info", "warn", "fail"].includes(severity as string), "invalid_severity");
  const tags = legacy ? normaliseTags(payload.tags) : payload.tags ?? [];
  ensure(Array.isArray(tags) && tags.length <= 32, "invalid_tags", 413);
  for (const tag of tags) ensure(typeof tag === "string" && /^[a-z0-9._/-]+$/.test(tag), "invalid_tag");
  ensure(Buffer.byteLength(JSON.stringify(tags)) <= 2 * KiB, "tags_too_large", 413);
  const link = text(payload.link ?? "", 2 * KiB).trim();
  ensure(Buffer.byteLength(link) <= 2 * KiB, "link_too_large", 413);
  const data = { ...record(payload.data ?? {}) };
  if (kind === "tool_call" && data.ts !== undefined) data.ts = timestamp(data.ts);
  validateData(kind as Kind, data);
  // Tool telemetry is allowlisted data only; general prose could smuggle raw output.
  if (kind === "tool_call") ensure(!payload.body && !payload.title && !link && tags.length === 0, "tool_prose_forbidden");
  const occurred = payload.occurred_at === undefined ? null : timestamp(payload.occurred_at);
  if (kind === "tool_call") ensure(occurred === null || occurred === data.ts, "tool_time_mismatch");
  return { kind: kind as Kind, occurred_at: kind === "tool_call" ? data.ts as string : occurred,
    title, body: text(payload.body ?? "", legacy ? MAX_LEGACY : MAX_EVENT), severity: severity as string,
    tags: [...new Set(tags as string[])], link, data };
}
export function validateEnvelope(value: unknown): Envelope {
  const e = record(value);
  fields(e, [...COMMON.filter(k => !["source", "host"].includes(k)), "source", "host", "issuer", "profile",
    "source_id", "event_id", "received_at", "provenance"]);
  ensure(e.v === 1 && typeof e.event_id === "string" && /^[a-f0-9]{64}$/.test(e.event_id), "invalid_envelope");
  for (const k of ["issuer", "profile", "project", "source", "host", "run_id"]) text(e[k], 256, true);
  ensure(typeof e.source_id === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(e.source_id), "invalid_source_id");
  ensure(["v", "event_id", "source_id", "issuer", "profile", "project", "source", "host", "run_id", "kind",
    "received_at", "occurred_at", "severity", "title", "body", "tags", "link", "data", "provenance"].every(k => Object.hasOwn(e, k)), "incomplete_envelope");
  record(e.data); ensure(Array.isArray(e.tags), "invalid_tags");
  timestamp(e.received_at);
  const p = record(e.provenance);
  if (p.type === "verified") {
    timestamp(e.occurred_at);
    fields(p, ["type", "request_hash", "feed_id"]);
    ensure(typeof p.request_hash === "string" && /^[a-f0-9]{64}$/.test(p.request_hash), "invalid_request_hash");
    ensure(e.kind === "tool_call" ? p.feed_id === null : (Number.isSafeInteger(p.feed_id) &&
      (p.feed_id as number) >= NEW_FEED_ID && (p.feed_id as number) < Number.MAX_SAFE_INTEGER), "invalid_feed_id");
    const input = { ...e }; for (const k of ["issuer", "profile", "source_id", "event_id", "received_at", "provenance"]) delete input[k];
    if (e.kind === "feed_post") { text(input.body, MAX_LEGACY); input.body = ""; }
    normalize(input, e as unknown as Identity, false);
    ensure(Buffer.byteLength(canonical(e)) <= (e.kind === "feed_post" ? MAX_ENVELOPE : MAX_EVENT), "event_too_large", 413);
  } else {
    fields(p, ["type", "legacy_id", "display_host", "display_source", "request_hash"]);
    ensure(typeof p.request_hash === "string" && /^[a-f0-9]{64}$/.test(p.request_hash), "invalid_request_hash");
    ensure(typeof e.occurred_at === "string" && e.occurred_at.length <= 256 && Number.isFinite(Date.parse(e.occurred_at)), "invalid_import_time");
    ensure(p.type === "legacy-feed" && e.issuer === "legacy-feed" && e.source_id === "legacy-feed" &&
      Number.isSafeInteger(p.legacy_id) && (p.legacy_id as number) > 0 && (p.legacy_id as number) < NEW_FEED_ID &&
      e.kind === "feed_post" && e.profile === "legacy-feed" && e.project === "legacy-feed" && e.source === "legacy-feed" && e.host === "legacy-feed" && e.run_id === "import", "invalid_legacy");
    text(e.title, 500, true); text(e.body, MAX_LEGACY); text(e.link, 2 * KiB);
    ensure(["info", "warn", "fail"].includes(e.severity as string), "invalid_severity");
    validateData("feed_post", record(e.data));
    text(p.display_host, MAX_LEGACY); text(p.display_source, MAX_LEGACY);
    ensure(Array.isArray(e.tags) && e.tags.every(t => typeof t === "string"), "invalid_tags");
    ensure(Buffer.byteLength(canonical(e)) <= MAX_ENVELOPE, "event_too_large", 413);
  }
  return e as unknown as Envelope;
}
