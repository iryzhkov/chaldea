import { readJson } from "../config/files.ts";
import { loadCapacityConfig } from "../quota/capacity-config.ts";
import { hostname } from "node:os";
import type { ScoreTransport } from "./snapshot.ts";
import { join } from "node:path";
import { DEFAULT_POLICY } from "./types.ts";
import type { PolicyConfig, QuotaWindow } from "./types.ts";
import { tokenSource, type ClaudeTokenSource } from "./claude-usage.ts";

export interface RouteConfig extends PolicyConfig {
  scores: ScoreTransport;
  announceHost: string; routeStateFile: string;
  stateFile: string; cacheDir: string; t3BaseDir: string; tokenFile: string; capacityConfigFile: string; quotaConfigFile: string | undefined;
  claudeUsage: ClaudeTokenSource & { enabled: boolean; providerInstanceId: string };
  claudeWeeklyTarget: { observedAt: string; window: QuotaWindow } | null;
}
export function loadRouteConfig(home: string, path = join(home, ".config/chaldea/route.json")): RouteConfig {
  const defaults: RouteConfig = {
    ...DEFAULT_POLICY,
    scores: { enabled: false, url: "", tokenHelper: "", host: hostname().split(".")[0]! },
    announceHost: "omarchy-pc", routeStateFile: join(home, ".local/state/chaldea/route.sqlite"),
    capacityConfigFile: join(home, ".config/chaldea/capacity.json"),
    quotaConfigFile: undefined,
    stateFile: join(home, ".local/state/chaldea/quota-observer.json"),
    cacheDir: join(home, ".cache/chaldea/route"),
    t3BaseDir: join(home, ".t3"), tokenFile: join(home, ".config/chaldea/t3-token"),
    claudeUsage: { enabled: false, providerInstanceId: "claudeAgent", credentialFile: join(home, ".claude/.credentials.json") },
    claudeWeeklyTarget: null,
  };
  const r = readJson(path, true, undefined, { maxBytes: 64 * 1024 });
  if (!r || typeof r !== "object" || Array.isArray(r) ||
    Object.keys(r).some(k => !Object.hasOwn(defaults, k))) throw new Error("Invalid route configuration keys");
  const c = { ...defaults };
  for (const key of ["paceMargin", "minimumRemaining", "failureMargin", "probationShare"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0 || r[key] > 1) throw new Error("Invalid route fraction");
      c[key] = r[key];
    }
  }
  for (const key of ["minimumTurns", "quotaMaxAgeMs", "analyticsMaxAgeMs", "scoreMaxAgeMs", "probationMs"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "number" || !Number.isSafeInteger(r[key]) || r[key] <= 0) throw new Error("Invalid route threshold");
      c[key] = r[key];
    }
  }
  for (const key of ["stateFile", "cacheDir", "t3BaseDir", "tokenFile", "capacityConfigFile", "quotaConfigFile", "routeStateFile"] as const) {
    if (r[key] !== undefined) {
      if (typeof r[key] !== "string" || !r[key].startsWith("/")) throw new Error("Route paths must be absolute");
      c[key] = r[key];
    }
  }
  if (r.bans !== undefined) {
    if (!Array.isArray(r.bans) || r.bans.length > 100 || r.bans.some(b => typeof b !== "string" || !/^[a-zA-Z0-9_.*:/-]{1,160}$/.test(b))) throw new Error("Invalid model bans");
    c.bans = r.bans;
  }
  if (r.floors !== undefined) {
    const f = r.floors as Record<string, unknown>;
    if (!f || typeof f !== "object" || Array.isArray(f) || Object.entries(f).some(([k,v]) =>
      !Object.hasOwn(c.floors, k) || typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100)) throw new Error("Invalid role floors");
    c.floors = { ...c.floors, ...f };
  }
  if (r.pins !== undefined) {
    const pins = r.pins as Record<string, any>;
    if (!pins || typeof pins !== "object" || Array.isArray(pins) || Object.entries(pins).some(([k,v]) =>
      !Object.hasOwn(c.floors, k) || !v || typeof v !== "object" || Array.isArray(v) ||
      Object.keys(v).some(f => !["model", "providerInstanceId"].includes(f)) ||
      typeof v.model !== "string" || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(v.model) ||
      v.providerInstanceId !== undefined && (typeof v.providerInstanceId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.providerInstanceId)))) throw new Error("Invalid role pins");
    c.pins = pins;
  }
  if (r.announceHost !== undefined) {
    if (typeof r.announceHost !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(r.announceHost)) throw new Error("Invalid announcement host");
    c.announceHost = r.announceHost;
  }
  if (r.scores !== undefined) {
    const s = r.scores as Record<string, any>;
    if (!s || typeof s !== "object" || Array.isArray(s) || Object.keys(s).some(k => !["enabled", "url", "tokenHelper", "host"].includes(k))) throw new Error("Invalid score transport");
    c.scores = { ...c.scores, ...s };
    const t = c.scores;
    if (typeof t.enabled !== "boolean" || typeof t.host !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(t.host) ||
      typeof t.tokenHelper !== "string" || typeof t.url !== "string") throw new Error("Invalid score transport");
    if (t.enabled) {
      const u = new URL(t.url);
      if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !t.tokenHelper.startsWith("/")) throw new Error("Invalid score transport");
    }
  }
  if (r.claudeUsage !== undefined) {
    const v = r.claudeUsage as Record<string, unknown>;
    if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !["enabled", "providerInstanceId", "credentialFile", "envFile", "envVar"].includes(k)) ||
      v.enabled !== undefined && typeof v.enabled !== "boolean" ||
      v.providerInstanceId !== undefined && (typeof v.providerInstanceId !== "string" || !v.providerInstanceId.length) ||
      v.credentialFile !== undefined && (typeof v.credentialFile !== "string" || !v.credentialFile.startsWith("/"))) throw new Error("Invalid Claude collector configuration");
    c.claudeUsage = { enabled: c.claudeUsage.enabled, providerInstanceId: c.claudeUsage.providerInstanceId, ...v,
      ...tokenSource(v as ClaudeTokenSource, home) } as RouteConfig["claudeUsage"];
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
  const capacity = loadCapacityConfig(home, c.capacityConfigFile);
  if (r.paceMargin === undefined) c.paceMargin = capacity.paceMargin;
  if (r.minimumRemaining === undefined) c.minimumRemaining = capacity.minimumRemaining;
  if (r.quotaMaxAgeMs === undefined) c.quotaMaxAgeMs = capacity.maxAgeMs;
  return c;
}
