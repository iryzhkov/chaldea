// Whole-preset admission. A caller names a preset; it never selects or reduces limits.
import { createHash } from "node:crypto";
import { validateAdmission, narrowing, type RunAdmission } from "../access/run-lease.ts";
import { AccessError } from "../access/token.ts";
import { MAX_AGE, object, requestTime, text } from "../waits/types.ts";
import { SessionRefusal, presetHash, type SessionPolicy, type SessionPreset } from "./policy.ts";

/** Jocasta reads in this first slice; writes and other audiences are refused. */
export const READ_ONLY_ACTIONS: readonly string[] = ["get", "history", "list", "search"];
const LIMIT_KEYS = new Set(["maxSeconds", "deadline", "expiresAt", "services", "grants", "audience", "limits", "destination",
  "destinations", "delegate", "instanceId", "model", "options", "projectId", "project", "prompt", "inputs", "runtimeMode",
  "interactionMode", "workspace", "workspaceStrategy", "environment", "argv", "helper", "endpoint"]);
export interface StartInput { threadId: string; requestId: string; preset: string }

export function startInput(value: unknown, now: number): { input: StartInput; requestAt: number; hash: string } {
  const v = object(value);
  for (const key of Object.keys(v)) {
    if (LIMIT_KEYS.has(key)) throw new SessionRefusal("unsupported_reduction",
      "explicit limits and runtime choices are not supported; ask the operator for a narrower preset");
    if (!["threadId", "requestId", "preset"].includes(key)) throw new SessionRefusal("unsupported_field", key.slice(0, 64));
  }
  const threadId = text(v.threadId, "threadId"), requestId = text(v.requestId, "requestId"), preset = text(v.preset, "preset", 128);
  const requestAt = requestTime(requestId);
  if (requestAt > now + 300_000 || requestAt < now - MAX_AGE) throw new Error("requestId outside replay age");
  const input = { threadId, requestId, preset };
  return { input, requestAt, hash: createHash("sha256").update(JSON.stringify({ kind: "session", input })).digest("hex") };
}
export interface Admitted { preset: SessionPreset; hash: string; admission: RunAdmission }
/**
 * The whole preset must fit inside one operator ceiling: same access project,
 * every service grant a subset, no longer duration and no wider destinations.
 * An equal preset passes; anything broader, unknown or delegating is refused
 * before any T3 call.
 */
export function admit(policy: SessionPolicy, presetId: string, runId: string, now: number): Admitted {
  const preset = Object.hasOwn(policy.presets, presetId) ? policy.presets[presetId] : undefined;
  if (!preset) throw new SessionRefusal("unknown_preset");
  if (preset.delegate !== false) throw new SessionRefusal("delegation_unsupported", "presets must set delegate:false");
  for (const service of preset.services) {
    if (service.audience !== "jocasta") throw new SessionRefusal("unsupported_audience", service.audience);
    if (!service.grants.every(g => g.actions.every(a => READ_ONLY_ACTIONS.includes(a))))
      throw new SessionRefusal("unsupported_grant", "only read-only Jocasta actions are supported");
  }
  const seconds = Math.floor(now / 1000);
  const admission: RunAdmission = { runId, profile: preset.id, project: preset.project,
    expiresAt: seconds + preset.maxSeconds, services: structuredClone(preset.services) };
  try { validateAdmission(admission, seconds); }
  catch (error) { throw new SessionRefusal("invalid_preset_admission", error instanceof AccessError ? error.message : undefined); }
  if (!withinCeiling(policy, preset, admission)) throw new SessionRefusal("preset_exceeds_ceiling");
  return { preset, hash: presetHash(preset), admission };
}
/**
 * True when the whole preset and its admission fit one of the policy's current
 * ceilings. Used at admission and again at every issuance check, so narrowing
 * or removing the admitting ceiling stops issuance for a run already started.
 */
export function withinCeiling(policy: SessionPolicy, preset: SessionPreset, admission: RunAdmission): boolean {
  const started = admission.expiresAt - preset.maxSeconds;
  return policy.ceilings.some(c => preset.maxSeconds <= c.maxSeconds &&
    preset.destinations.every(d => c.destinations.includes(d)) &&
    narrowing(admission, { runId: admission.runId, profile: preset.id, project: c.project, expiresAt: started + c.maxSeconds, services: c.services }));
}
/** The caller's T3 project is only the wake destination, checked against the preset. */
export function destination(preset: SessionPreset, callerProject: string): void {
  if (!preset.destinations.includes(callerProject)) throw new SessionRefusal("destination_not_allowed");
}
