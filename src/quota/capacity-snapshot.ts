// Pure wire contract. Importing it never loads collectors, configuration or transport.
import type { Window, Wallet, Resets } from "./headroom.ts";
export const CAPACITY_MAX_AGE_MS = 15 * 60000;
export interface AccountSnapshot {
  provider: "codex" | "claudeAgent"; accountKey: string; observedAt: string;
  maxAgeMs: number; windows: Window[]; credits: Wallet | null; resets: Resets | null;
  creditExpiresAt?: string; activeStop: boolean;
}
export interface CapacitySnapshot { version: 1; host: string; generatedAt: string; accounts: AccountSnapshot[] }
const key = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const iso = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
const obj = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid_capacity_snapshot");
  return v as Record<string, any>;
};
const fields = (v: Record<string, any>, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error("invalid_capacity_snapshot");
};
/** Strict allowlist shared by producers, Akasha ingress and readers. No paths,
 * aliases, raw provider objects, identity IDs or error prose cross this boundary.
 */
export function validateSnapshot(raw: unknown): CapacitySnapshot {
  const s = obj(raw);
  fields(s, ["version", "host", "generatedAt", "accounts"]);
  if (s.version !== 1 || typeof s.host !== "string" || !/^[a-zA-Z0-9_.-]{1,100}$/.test(s.host) ||
      !iso(s.generatedAt) || !Array.isArray(s.accounts) || s.accounts.length > 32 ||
      Buffer.byteLength(JSON.stringify(s)) > 40 * 1024) throw new Error("invalid_capacity_snapshot");
  const seen = new Set<string>();
  for (const rawAccount of s.accounts) {
    const a = obj(rawAccount);
    fields(a, ["provider", "accountKey", "observedAt", "maxAgeMs", "windows", "credits", "resets", "creditExpiresAt", "activeStop"]);
    if (!["codex", "claudeAgent"].includes(a.provider) || !key(a.accountKey) || !iso(a.observedAt) || Date.parse(a.observedAt) > Date.parse(s.generatedAt) ||
        !Number.isSafeInteger(a.maxAgeMs) || a.maxAgeMs <= 0 || a.maxAgeMs > CAPACITY_MAX_AGE_MS ||
        !Array.isArray(a.windows) || a.windows.length > 8 || typeof a.activeStop !== "boolean" ||
        a.creditExpiresAt !== undefined && !iso(a.creditExpiresAt)) throw new Error("invalid_capacity_account");
    const id = a.provider + ":" + a.accountKey;
    if (seen.has(id)) throw new Error("duplicate_capacity_account");
    seen.add(id);
    const windowIds = new Set<string>();
    for (const rawWindow of a.windows) {
      const w = obj(rawWindow);
      if (windowIds.has(w.id)) throw new Error("duplicate_capacity_window");
      windowIds.add(w.id);
      fields(w, ["id", "kind", "usedPercent", "remainingPercent", "windowDurationMins", "resetsAt"]);
      if (!["session", "weekly", "monthly", "other"].includes(w.kind) || !/^[a-zA-Z0-9_.:/-]{1,100}$/.test(w.id) ||
          !Number.isFinite(w.usedPercent) || w.usedPercent < 0 || w.usedPercent > 100 ||
          !Number.isFinite(w.remainingPercent) || w.remainingPercent < 0 || w.remainingPercent > 100 ||
          Math.abs(w.remainingPercent + w.usedPercent - 100) > 1e-8 ||
          w.windowDurationMins !== null && (!Number.isFinite(w.windowDurationMins) || w.windowDurationMins <= 0) ||
          w.resetsAt !== null && !iso(w.resetsAt)) throw new Error("invalid_capacity_window");
    }
    if (a.credits !== null) {
      const c = obj(a.credits); fields(c, ["balance", "hasCredits", "unlimited"]);
      if (typeof c.hasCredits !== "boolean" || typeof c.unlimited !== "boolean" ||
          c.balance !== null && (typeof c.balance !== "string" || !/^\d{1,80}(\.\d{1,18})?$/.test(c.balance))) throw new Error("invalid_capacity_wallet");
    }
    if (a.resets !== null) {
      const r = obj(a.resets); fields(r, ["availableCount", "nextExpiresAt"]);
      if (!Number.isSafeInteger(r.availableCount) || r.availableCount < 0 ||
          r.nextExpiresAt !== null && !iso(r.nextExpiresAt)) throw new Error("invalid_capacity_resets");
    }
  }
  return s as unknown as CapacitySnapshot;
}
