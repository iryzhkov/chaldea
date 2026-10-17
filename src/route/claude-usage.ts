// Opt-in, GET-only Linux credential reader. No refresh, credential write or logging.
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { cached, getJson } from "./cache.ts";
import type { QuotaWindow } from "./types.ts";
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_CADENCE_MS = 5 * 60_000;
export interface ClaudeUsage { observedAt: string; windows: QuotaWindow[] }
function percent(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100; }
export function parseClaudeUsage(raw: unknown, now: number): ClaudeUsage {
  const r = raw as Record<string, { utilization?: unknown; resets_at?: unknown }> | null;
  if (!r || typeof r !== "object") throw new Error("Invalid Claude usage");
  const windows: QuotaWindow[] = [];
  for (const [key, kind, minutes] of [["five_hour", "session", 300], ["seven_day", "weekly", 10080]] as const) {
    const w = r[key];
    if (!w || !percent(w.utilization) || typeof w.resets_at !== "string" ||
      !Number.isFinite(Date.parse(w.resets_at))) throw new Error("Invalid Claude usage");
    windows.push({ kind, remainingPercent: 100 - w.utilization, resetsAt: w.resets_at, windowDurationMins: minutes });
  }
  return { observedAt: new Date(now).toISOString(), windows };
}
function validate(raw: unknown): ClaudeUsage {
  const u = raw as ClaudeUsage;
  if (!u || typeof u.observedAt !== "string" || !Number.isFinite(Date.parse(u.observedAt)) ||
    !Array.isArray(u.windows) || u.windows.length !== 2 ||
    !u.windows.every(w => percent(w.remainingPercent) && typeof w.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt)) &&
      (w.kind === "session" && w.windowDurationMins === 300 || w.kind === "weekly" && w.windowDurationMins === 10080))) throw new Error("Invalid Claude usage cache");
  // Project explicitly; no raw OAuth payload ever reaches disk.
  return { observedAt: u.observedAt, windows: u.windows.map(w => ({
    kind: w.kind, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, windowDurationMins: w.windowDurationMins,
  })) };
}
function accessToken(path: string, now: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Credential unavailable");
    const c = JSON.parse(readFileSync(fd, "utf8"))?.claudeAiOauth;
    if (!c || typeof c.accessToken !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(c.accessToken) ||
      typeof c.expiresAt !== "number" || !Number.isFinite(c.expiresAt) || c.expiresAt <= now) throw new Error("Credential unavailable");
    return c.accessToken;
  } finally { closeSync(fd); }
}
export async function collectClaudeUsage(options: {
  enabled: boolean; credentialFile: string; cacheFile: string; now: number; fetcher?: typeof fetch;
}) {
  if (!options.enabled) return { value: null, fetchedAt: null, reason: "Claude usage collector disabled" };
  return cached(options.cacheFile, CLAUDE_CADENCE_MS, options.now, validate, async () => {
    const token = accessToken(options.credentialFile, options.now);
    const raw = await getJson(CLAUDE_USAGE_URL, { headers: {
      authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20",
    } }, options.fetcher, 64 * 1024);
    return parseClaudeUsage(raw, options.now);
  });
}
