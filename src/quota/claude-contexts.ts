import { homedir } from "node:os";
import { tokenSource, type ClaudeTokenSource } from "../route/claude-usage.ts";
export interface ClaudeContext extends ClaudeTokenSource { providerInstanceId: string; enabled: boolean; accountKey?: string }
const key = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
const obj = (v: unknown): Record<string, any> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("invalid_capacity_snapshot");
  return v as Record<string, any>;
};
const fields = (v: Record<string, any>, allowed: string[]) => {
  if (Object.keys(v).some(k => !allowed.includes(k))) throw new Error("invalid_capacity_snapshot");
};
export function claudeContexts(raw: unknown): ClaudeContext[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 16) throw new Error("invalid_claude_contexts");
  const seen = new Set<string>();
  return raw.map(value => {
    const v = obj(value);
    fields(v, ["providerInstanceId", "credentialFile", "envFile", "envVar", "enabled", "accountKey"]);
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(v.providerInstanceId) || seen.has(v.providerInstanceId) ||
        v.credentialFile === undefined && v.envFile === undefined && v.envVar === undefined ||
        typeof v.enabled !== "boolean" || v.accountKey !== undefined && !key(v.accountKey)) throw new Error("invalid_claude_context");
    seen.add(v.providerInstanceId);
    return { ...v, ...tokenSource(v, homedir()) } as ClaudeContext;
  });
}
