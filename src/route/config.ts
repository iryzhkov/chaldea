import { existsSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_POLICY } from "./types.ts";
import type { PolicyConfig, QuotaWindow } from "./types.ts";
import { readJson } from "./cache.ts";

export interface RouteConfig extends PolicyConfig {
  stateFile: string; cacheDir: string; t3BaseDir: string; tokenFile: string; capacityConfigFile: string;
  claudeUsage: { enabled: boolean; providerInstanceId: string; credentialFile: string };
  claudeWeeklyTarget: { observedAt: string; window: QuotaWindow } | null;
}
export function loadRouteConfig(home: string, path = join(home, ".config/chaldea/route.json")): RouteConfig {
  const defaults: RouteConfig = {
    ...DEFAULT_POLICY,
    capacityConfigFile: join(home, ".config/chaldea/capacity.json"),
    stateFile: join(home, ".local/state/chaldea/quota-observer.json"),
    cacheDir: join(home, ".cache/chaldea/route"),
    t3BaseDir: join(home, ".t3"), tokenFile: join(home, ".config/chaldea/t3-token"),
    claudeUsage: { enabled: false, providerInstanceId: "claudeAgent", credentialFile: join(home, ".claude/.credentials.json") },
    claudeWeeklyTarget: null,
  };
  if (!existsSync(path)) return defaults;
  const r = readJson(path, 64 * 1024) as Record<string, unknown>;
  if (!r || typeof r !== "object" || Array.isArray(r) ||
    Object.keys(r).some(k => !Object.hasOwn(defaults, k))) throw new Error("Invalid route configuration keys");
  const c = { ...defaults };
  for (const key of ["paceMargin", "minimumRemaining", "failureMargin"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0 || r[key] > 1) throw new Error("Invalid route fraction");
      c[key] = r[key];
    }
  }
  for (const key of ["minimumTurns", "quotaMaxAgeMs", "analyticsMaxAgeMs"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] <= 0) throw new Error("Invalid route threshold");
      c[key] = r[key];
    }
  }
  for (const key of ["stateFile", "cacheDir", "t3BaseDir", "tokenFile", "capacityConfigFile"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "string" || !r[key].startsWith("/")) throw new Error("Route paths must be absolute");
      c[key] = r[key];
    }
  }
  if (r.claudeUsage !== undefined) {
    const v = r.claudeUsage as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["enabled", "providerInstanceId", "credentialFile"].includes(k)) ||
      v.enabled !== undefined && typeof v.enabled !== "boolean" ||
      v.providerInstanceId !== undefined && (typeof v.providerInstanceId !== "string" || !v.providerInstanceId.length) ||
      v.credentialFile !== undefined && (typeof v.credentialFile !== "string" || !v.credentialFile.startsWith("/"))) throw new Error("Invalid Claude collector configuration");
    c.claudeUsage = { ...c.claudeUsage, ...v } as RouteConfig["claudeUsage"];
  }
  if (r.claudeWeeklyTarget !== undefined && r.claudeWeeklyTarget !== null) {
    const v = r.claudeWeeklyTarget as Record<string, unknown>;
    if (!v || typeof v !== "object" || Object.keys(v).some(k => !["observedAt", "remainingPercent", "resetsAt"].includes(k)) ||
      typeof v.observedAt !== "string" || !Number.isFinite(Date.parse(v.observedAt)) ||
      typeof v.resetsAt !== "string" || !Number.isFinite(Date.parse(v.resetsAt)) ||
      typeof v.remainingPercent !== "number" || !Number.isFinite(v.remainingPercent) || v.remainingPercent < 0 || v.remainingPercent > 100) throw new Error("Invalid Claude weekly target");
    c.claudeWeeklyTarget = { observedAt: v.observedAt, window: { kind: "weekly", remainingPercent: v.remainingPercent,
      resetsAt: v.resetsAt, windowDurationMins: 10080 } };
  }
  return c;
}
