import { readFileSync } from "node:fs";
import { AccessState, Clock } from "./trust.ts";
import { exact, object, requireAccess, seconds, strictJson } from "./token.ts";

/** Callers retain their private/public file ownership checks; every daemon shares freshness validation. */
export function clockHealth(state: AccessState, read: () => Uint8Array): Clock {
  return new Clock(state, () => {
    const now = Math.floor(Date.now() / 1000), h = object(strictJson(Buffer.from(read())));
    exact(h, ["healthy", "offsetSeconds", "checked_at"]); seconds(h.checked_at);
    requireAccess(h.checked_at <= now && now - h.checked_at <= 30 &&
      typeof h.offsetSeconds === "number", "clock_health_stale");
    return { unixSeconds: now, monotonicSeconds: Number(process.hrtime.bigint()) / 1e9,
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      healthy: h.healthy === true, offsetSeconds: h.offsetSeconds };
  });
}
