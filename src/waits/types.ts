// Provider-independent public inputs. No implicit caller identity.
import { randomUUID } from "node:crypto";
export const DAY = 86_400_000;
export const MAX_AGE = 42 * DAY;
export const MAX_DEADLINE = 35 * DAY;
export type Condition = { kind: "time"; at: string } | { kind: "thread"; threadId: string; runId?: string };
export interface WaitInput { threadId: string; requestId: string; condition: Condition; deadline?: string; description?: string }
export interface DecisionInput {
  threadId: string; requestId: string; question: string; options: string[];
  dependentAction: string; defaultAction: "skip" | "defer"; deadline: string;
}
export interface NativeDecisionInput {
  threadId: string; requestId: string; dependentAction: string; defaultAction: "skip" | "defer"; deadline: string;
  runtimeRequestId?: string;
}
export type Input = WaitInput | DecisionInput | NativeDecisionInput;
export type AnswerSource = "page" | "cli" | `mcp:${string}`;
export type Outcome = { reason: string; answer?: string; defaulted?: boolean; action?: "skip" | "defer"; source?: AnswerSource | "t3" | "chaldea"; runId?: string; runtimeRequestId?: string; detail?: string };
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > max) throw new Error("Invalid " + name);
  return value;
}
// Context only: never an executable action or an authorization.
export function waitDescription(input: WaitInput, targetRun: string | null): string {
  if (input.description !== undefined) return input.description;
  const c = input.condition;
  return c.kind === "time" ? "Wait until " + c.at
    : "Wait for thread " + c.threadId + " run " + (targetRun ?? c.runId ?? "latest accepted");
}
export function description(value: unknown): string {
  const s = text(value, "description", 512);
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) throw new Error("Invalid description: use single-line plain text");
  return s;
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
export function validate(kind: "wait" | "decision" | "native", value: unknown, now: number): { input: Input; deadline: number; requestAt: number } {
  const v = {...object(value)};
  if (kind === "wait" && v.requestId === undefined) v.requestId = now+":"+randomUUID();
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
    input = { threadId: v.threadId as string, requestId: v.requestId as string, condition, deadline: new Date(deadline).toISOString(),
      ...(v.description === undefined ? {} : {description: description(v.description)}) };
  } else if (kind === "native") {
    if (v.defaultAction !== "skip" && v.defaultAction !== "defer") throw new Error("Default action must only skip or defer");
    deadline = timestamp(v.deadline);
    input = {threadId:v.threadId as string,requestId:v.requestId as string,
      dependentAction:text(v.dependentAction,"dependentAction",512),defaultAction:v.defaultAction,
      deadline:new Date(deadline).toISOString(),
      ...(v.runtimeRequestId === undefined ? {} : {runtimeRequestId:text(v.runtimeRequestId,"runtimeRequestId",2048)})};
  } else {
    if (!Array.isArray(v.options) || v.options.length < 2 || v.options.length > 8) throw new Error("Provide 2–8 options");
    const options = v.options.map(o => text(o, "option", 256));
    if (new Set(options).size !== options.length) throw new Error("Options must be unique");
    if (v.defaultAction !== "skip" && v.defaultAction !== "defer")
      throw new Error("Default action must only skip or defer");
    if ("default" in v || "defaultSafe" in v) throw new Error("Option-valued defaults are unsupported; declare only defaultAction");
    deadline = timestamp(v.deadline);
    input = { threadId: v.threadId as string, requestId: v.requestId as string, question: text(v.question, "question", 1024),
      options, dependentAction: text(v.dependentAction, "dependentAction", 512), defaultAction: v.defaultAction as "skip" | "defer",
      deadline: new Date(deadline).toISOString() };
  }
  // Time waits may use their target + 24 hours as the default timeout.
  const limit = kind === "wait" && "condition" in input && input.condition.kind === "time" ? MAX_DEADLINE + DAY : MAX_DEADLINE;
  if (deadline > requestAt + limit) throw new Error("Deadline exceeds maximum");
  if (Buffer.byteLength(JSON.stringify(input)) > 3072) throw new Error("Input exceeds 3 KiB");
  return { input, deadline, requestAt };
}
