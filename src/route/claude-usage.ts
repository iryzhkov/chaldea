// Opt-in, GET-only Linux credential reader. No refresh, credential write or logging.
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { accountKey } from "../quota/account.ts";
import { cached, getJson, CollectionFailure, HttpFailure } from "./cache.ts";
import type { QuotaWindow } from "./types.ts";
export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
export const CLAUDE_CADENCE_MS = 5 * 60_000;
export const claudeCacheFile = (home: string, credentialFile: string) => join(home, ".cache/chaldea/claude-accounts", createHash("sha256").update(credentialFile).digest("hex") + ".json");
export interface ClaudeTokenSource { credentialFile?: string; envFile?: string; envVar?: string }
export function tokenSource(raw: ClaudeTokenSource, home: string): ClaudeTokenSource {
  if (raw.credentialFile !== undefined && (raw.envFile !== undefined || raw.envVar !== undefined) ||
      [raw.credentialFile, raw.envFile].some(v => v !== undefined && (typeof v !== "string" || !v.startsWith("/"))) ||
      raw.envVar !== undefined && (typeof raw.envVar !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(raw.envVar))) throw new Error("Invalid Claude token source");
  return raw.envFile !== undefined || raw.envVar !== undefined
    ? { envFile: raw.envFile ?? join(home, ".config/claude/oauth.env"), envVar: raw.envVar ?? "CLAUDE_CODE_OAUTH_TOKEN" }
    : { credentialFile: raw.credentialFile ?? join(home, ".claude/.credentials.json") };
}
export const claudeSourceId = (source: ClaudeTokenSource) => source.envFile ? "env:" + source.envFile + ":" + (source.envVar ?? "CLAUDE_CODE_OAUTH_TOKEN") : source.credentialFile!;
export interface ClaudeUsage { accountKey?: string; observedAt: string; windows: QuotaWindow[] }
function percent(v: unknown): v is number { return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 100; }
export function parseClaudeUsage(raw: unknown, now: number): ClaudeUsage {
  const r = raw as Record<string, { utilization?: unknown; resets_at?: unknown }> | null;
  if (!r || typeof r !== "object") throw new Error("Invalid Claude usage");
  const windows: QuotaWindow[] = [];
  for (const [key, kind, minutes] of [["five_hour", "session", 300], ["seven_day", "weekly", 10080], ["seven_day_fable", "weekly", 10080]] as const) {
    const w = r[key];
    if (key === "seven_day_fable" && w == null) continue;
    if (!w || !percent(w.utilization) || typeof w.resets_at !== "string" ||
      !Number.isFinite(Date.parse(w.resets_at))) throw new Error("Invalid Claude usage");
    windows.push({ id: key, kind, remainingPercent: 100 - w.utilization, resetsAt: w.resets_at, windowDurationMins: minutes });
  }
  const key = claudeAccountKey(raw);
  return { ...(key ? { accountKey: key } : {}), observedAt: new Date(now).toISOString(), windows };
}
export function claudeAccountKey(raw: unknown): string | undefined {
  const r = raw as Record<string, any> | null;
  return accountKey(r?.organization_id ?? r?.organization?.uuid ?? r?.organization?.id ??
    r?.account_id ?? r?.account?.uuid ?? r?.account?.id);
}
function validate(raw: unknown): ClaudeUsage {
  const u = raw as ClaudeUsage;
  if (!u || typeof u.observedAt !== "string" || !Number.isFinite(Date.parse(u.observedAt)) ||
    !Array.isArray(u.windows) || ![2, 3].includes(u.windows.length) ||
    new Set(u.windows.map(w => w.id ?? w.kind)).size !== u.windows.length ||
    !u.windows.some(w => w.kind === "session" && (w.id === undefined || w.id === "five_hour")) ||
    !u.windows.some(w => w.kind === "weekly" && (w.id === undefined || w.id === "seven_day")) ||
    !u.windows.every(w => percent(w.remainingPercent) && typeof w.resetsAt === "string" && Number.isFinite(Date.parse(w.resetsAt)) &&
      (w.kind === "session" && w.windowDurationMins === 300 && [undefined, "five_hour"].includes(w.id) ||
       w.kind === "weekly" && w.windowDurationMins === 10080 && [undefined, "seven_day", "seven_day_fable"].includes(w.id)))) throw new Error("Invalid Claude usage cache");
  // Project explicitly; no raw OAuth payload ever reaches disk.
  return { ...(u.accountKey && /^[a-f0-9]{64}$/.test(u.accountKey) ? { accountKey: u.accountKey } : {}), observedAt: u.observedAt, windows: u.windows.map(w => ({
    ...(w.id ? { id: w.id } : {}), kind: w.kind, remainingPercent: w.remainingPercent, resetsAt: w.resetsAt, windowDurationMins: w.windowDurationMins,
  })) };
}
function accessToken(source: ClaudeTokenSource, now: number): string {
  const fd = openSync((source.envFile ?? source.credentialFile)!, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 64 * 1024 || stat.nlink !== 1 ||
        source.envFile && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.())) throw new CollectionFailure("credential_unavailable");
    const text = readFileSync(fd, "utf8");
    let token: unknown;
    if (source.envFile) {
      // Extract exactly one named assignment. Never source/evaluate the file or populate process.env.
      const name = source.envVar ?? "CLAUDE_CODE_OAUTH_TOKEN";
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) throw new CollectionFailure("credential_unavailable");
      const assignments = text.split(/\r?\n/).filter(line => new RegExp("^\\s*(?:export\\s+)?" + name + "\\s*=").test(line));
      if (assignments.length !== 1) throw new CollectionFailure("credential_unavailable");
      const value = assignments[0]!.slice(assignments[0]!.indexOf("=") + 1).trim();
      token = /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
    } else {
      const credential = JSON.parse(text)?.claudeAiOauth;
      if (credential && typeof credential.expiresAt === "number" && Number.isFinite(credential.expiresAt) && credential.expiresAt <= now)
        throw new CollectionFailure("credential_expired");
      if (!credential || typeof credential.expiresAt !== "number" || !Number.isFinite(credential.expiresAt))
        throw new CollectionFailure("credential_unavailable");
      token = credential.accessToken;
    }
    if (typeof token !== "string" || !/^[\x21-\x7e]{1,8192}$/.test(token) || /['"`$\\]/.test(token))
      throw new CollectionFailure("credential_unavailable");
    return token;
  } finally { closeSync(fd); }
}
function retryDelay(value: string | null, now: number): number | null {
  if (value === null) return null;
  const delay = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? delay : null;
}
export async function collectClaudeUsage(options: {
  enabled: boolean; credentialFile?: string; envFile?: string; envVar?: string; cacheFile: string; now: number; fetcher?: typeof fetch;
}) {
  if (!options.enabled) return { value: null, fetchedAt: null, reason: "Claude usage collector disabled" };
  return cached(options.cacheFile, CLAUDE_CADENCE_MS, options.now, validate, async () => {
    let token: string;
    try { token = accessToken(tokenSource(options, homedir()), options.now); }
    catch (error) { throw error instanceof CollectionFailure ? error : new CollectionFailure("credential_unavailable"); }
    try {
      const raw = await getJson(CLAUDE_USAGE_URL, { headers: {
        authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20",
      } }, options.fetcher, 64 * 1024);
      const usage = parseClaudeUsage(raw, options.now);
      // Some usage responses omit identity. Read the profile with the same bearer;
      // never derive identity from a token, email or local host.
      if (!usage.accountKey) {
        try {
          const profile = await getJson("https://api.anthropic.com/api/oauth/profile", { headers: {
            authorization: "Bearer " + token, "anthropic-beta": "oauth-2025-04-20",
          } }, options.fetcher, 64 * 1024);
          const key = claudeAccountKey(profile);
          if (key) usage.accountKey = key;
        } catch { /* Unidentified windows remain local only. */ }
      }
      return usage;
    } catch (error) {
      if (error instanceof HttpFailure && error.status === 429) throw new CollectionFailure("rate_limited", retryDelay(error.retryAfter, options.now));
      if (error instanceof HttpFailure && error.status === 401) throw new CollectionFailure("unauthorized");
      throw error;
    }
  });
}
