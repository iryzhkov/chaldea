// Provider-independent public inputs. No implicit caller identity.
export const DAY = 86_400_000;
export const MAX_AGE = 42 * DAY;
export const MAX_DEADLINE = 35 * DAY;
export type Condition = { kind: "time"; at: string } | { kind: "thread"; threadId: string; runId?: string };
export interface WaitInput { threadId: string; requestId: string; condition: Condition; deadline?: string }
export interface DecisionInput {
  threadId: string; requestId: string; question: string; options: string[];
  default: string; defaultSafe: true; defaultAction: "skip" | "defer"; deadline: string;
}
export type Input = WaitInput | DecisionInput;
export type Outcome = { reason: string; answer?: string; defaulted?: boolean; runId?: string };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new Error("Invalid " + name);
  return value;
}
export function timestamp(value: unknown): number {
  const s = text(value, "RFC3339 timestamp", 64);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s)))
    throw new Error("Timestamp requires RFC3339 with an offset");
  return Date.parse(s);
}
export function requestTime(key: unknown): number {
  const s = text(key, "requestId");
  if (!/^\d{13}:[A-Za-z0-9_-]{1,128}$/.test(s)) throw new Error("requestId must be <epoch milliseconds>:<unique key>");
  return Number(s.slice(0, 13));
}
export function validate(kind: "wait" | "decision", value: unknown, now: number): { input: Input; deadline: number; requestAt: number } {
  const v = object(value);
  text(v.threadId, "threadId"); const requestAt = requestTime(v.requestId);
  if (requestAt > now + 300_000 || requestAt < now - MAX_AGE) throw new Error("requestId outside replay age");
  let input: Input; let deadline: number;
  if (kind === "wait") {
    const c = object(v.condition);
    let condition: Condition;
    if (c.kind === "time") {
      const at = timestamp(c.at);
      if (at > requestAt + MAX_DEADLINE) throw new Error("Time wait exceeds 35 days");
      condition = { kind: "time", at: new Date(at).toISOString() };
      deadline = v.deadline === undefined ? at + DAY : timestamp(v.deadline);
    } else if (c.kind === "thread") {
      condition = { kind: "thread", threadId: text(c.threadId, "target threadId"),
        ...(c.runId === undefined ? {} : { runId: text(c.runId, "runId") }) };
      if (condition.threadId === v.threadId) throw new Error("Self dependency");
      deadline = v.deadline === undefined ? requestAt + DAY : timestamp(v.deadline);
    } else throw new Error("Unsupported condition (only time and same-host thread waits)");
    input = { threadId: v.threadId as string, requestId: v.requestId as string, condition, deadline: new Date(deadline).toISOString() };
  } else {
    if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 8) throw new Error("Provide 2–8 options");
    const options = v.options.map(o => text(o, "option", 256));
    if (new Set(options).size !== options.length) throw new Error("Options must be unique");
    if (v.defaultSafe !== true || !["skip", "defer"].includes(String(v.defaultAction)) || !options.includes(String(v.default)))
      throw new Error("Default must be an option, explicitly safe, and only skip or defer");
    deadline = timestamp(v.deadline);
    input = { threadId: v.threadId as string, requestId: v.requestId as string, question: text(v.question, "question", 1024),
      options, default: v.default as string, defaultSafe: true, defaultAction: v.defaultAction as "skip" | "defer",
      deadline: new Date(deadline).toISOString() };
  }
  // Time waits may use their target + 24 hours as the default timeout.
  const limit = kind === "wait" && "condition" in input && input.condition.kind === "time" ? MAX_DEADLINE + DAY : MAX_DEADLINE;
  if (deadline > requestAt + limit) throw new Error("Deadline exceeds maximum");
  if (Buffer.byteLength(JSON.stringify(input)) > 3072) throw new Error("Input exceeds 3 KiB");
  return { input, deadline, requestAt };
}
