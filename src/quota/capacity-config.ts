import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_CAPACITY } from "./capacity.ts";
import type { CapacityConfig } from "./capacity.ts";
export function loadCapacityConfig(home: string, path = join(home, ".config/chaldea/capacity.json")): CapacityConfig {
  if (!existsSync(path)) return { ...DEFAULT_CAPACITY, providers: {} };
  if (statSync(path).size > 65536) throw new Error("Capacity configuration too large");
  const r = JSON.parse(readFileSync(path, "utf8")) as CapacityConfig;
  if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some(k => !Object.hasOwn(DEFAULT_CAPACITY, k))) throw new Error("Invalid capacity configuration");
  const c = { ...DEFAULT_CAPACITY, ...r };
  for (const key of ["heavyMultiplier", "recentWindowMs", "maxAgeMs", "expiryHorizonMs"] as const)
    if (!Number.isFinite(c[key]) || c[key] <= 0) throw new Error("Invalid capacity threshold");
  if (!Number.isFinite(c.minimumResetLeadHours) || c.minimumResetLeadHours < 0) throw new Error("Invalid reset lead");
  for (const key of ["paceMargin", "minimumRemaining", "reserveFraction"] as const)
    if (!Number.isFinite(c[key]) || c[key] < 0 || c[key] >= 1) throw new Error("Invalid capacity fraction");
  if (!c.providers || typeof c.providers !== "object" || Array.isArray(c.providers) || Object.keys(c.providers).length > 64) throw new Error("Invalid capacity providers");
  for (const v of Object.values(c.providers)) {
    if (!v || typeof v !== "object" || Object.keys(v).some(k => !["creditsPerFullWeek", "creditExpiresAt", "claudeRefills"].includes(k)) ||
      v.creditsPerFullWeek !== undefined && (!Number.isFinite(v.creditsPerFullWeek) || v.creditsPerFullWeek <= 0) ||
      v.creditExpiresAt !== undefined && (typeof v.creditExpiresAt !== "string" || !Number.isFinite(Date.parse(v.creditExpiresAt))) ||
      v.claudeRefills !== undefined && (!v.claudeRefills || !Number.isSafeInteger(v.claudeRefills.count) || v.claudeRefills.count < 0 ||
        typeof v.claudeRefills.expiresAt !== "string" || !Number.isFinite(Date.parse(v.claudeRefills.expiresAt)))) throw new Error("Invalid capacity reserves");
  }
  return c;
}
