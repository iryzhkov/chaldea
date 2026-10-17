import { readFileSync } from "node:fs";
import { AccessState, Clock } from "./trust.ts";
import { exact, object, requireAccess, seconds, strictJson } from "./token.ts";

export const HEALTH_FIELDS = ["healthy", "offsetSeconds", "checked_at"];
export interface HealthPolicy {
  decode: (bytes: Uint8Array) => Record<string, unknown>;
  fields: (health: Record<string, unknown>) => void;
  check: (condition: unknown, code: string) => void;
}
const accessPolicy: HealthPolicy = {
  decode: bytes => object(strictJson(bytes)),
  fields: h => { exact(h, HEALTH_FIELDS); seconds(h.checked_at); },
  check: requireAccess,
};
/** The service retains its parser/error contract while sharing all freshness rules. */
export function readHealth(bytes: Uint8Array, now: number, policy = accessPolicy) {
  const h = policy.decode(bytes);
  policy.fields(h);
  const checked = h.checked_at as number;
  policy.check(Number.isSafeInteger(checked) && checked <= now && now - checked <= 30 &&
    typeof h.offsetSeconds === "number", "clock_health_stale");
  return { healthy: h.healthy === true, offsetSeconds: h.offsetSeconds as number };
}
/** Callers retain their private/public file ownership checks. */
export function clockHealth(state: AccessState, read: () => Uint8Array, policy = accessPolicy): Clock {
  return new Clock(state, () => {
    const now = Math.floor(Date.now() / 1000), h = readHealth(read(), now, policy);
    return { unixSeconds: now, monotonicSeconds: Number(process.hrtime.bigint()) / 1e9,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), ...h };
  });
}
