export type Provider = "claudeAgent" | "codex";
export type Role = "builder" | "critical-review" | "bulk-read" | "general";
export type Effort = "low" | "medium" | "high" | "xhigh";
export interface RouteInput { role: Role; authorProvider?: Provider; effortOverride?: Effort }
export interface CatalogProvider {
  providerInstanceId: string;
  driverKind: string;
  canRunChildTask: boolean;
  models: ReadonlyArray<{ id: string; options?: ReadonlyArray<{
    id: string; type: string; options?: ReadonlyArray<{ id: string }>
  }> | null }>;
}
export interface QuotaWindow { kind: string; remainingPercent: number; windowDurationMins: number | null; resetsAt: string | null }
export interface Quota {
  observedAt: string | null;
  windows: ReadonlyArray<QuotaWindow>;
  activeStop: boolean;
  operatorEstimate?: boolean;
}
export interface ModelStats {
  turns: number; completionRate: number; failedRate: number; interruptedRate: number; minutesPerTurn: number | null;
}
export interface Analytics {
  fetchedAt: string;
  sourceFetchedAt: string;
  endExclusive: string;
  models: Record<string, ModelStats>;
}
export interface Target { providerInstanceId: string; model: string; options: Record<string, Effort> }
export interface RouteResult extends Target {
  alternatives: Target[];
  reasons: string[];
  dataAges: { quota: Record<string, number | null>; slopalytics: number | null; slopalyticsWindow: number | null };
}
export interface PolicyConfig {
  paceMargin: number;
  minimumRemaining: number;
  failureMargin: number;
  minimumTurns: number;
  quotaMaxAgeMs: number;
  analyticsMaxAgeMs: number;
}
export const DEFAULT_POLICY: PolicyConfig = {
  paceMargin: 0.10, minimumRemaining: 0.10, failureMargin: 0.10, minimumTurns: 100,
  quotaMaxAgeMs: 15 * 60_000, analyticsMaxAgeMs: 3 * 86_400_000,
};
export const PAIRS = {
  builder: ["claude-opus-5-5", "gpt-6.1-sol"],
  "critical-review": ["claude-fable-5-1", "gpt-6-astra"],
  "bulk-read": ["claude-sonnet-5-5", "gpt-6-luna"],
  general: ["claude-opus-5-5", "gpt-6.1-sol"],
} as const;
// The only display-name mapping. Never alias older generations to newer models.
export const MODEL_NAMES: Record<string, string> = {
  "Opus 5.5": "claude-opus-5-5",
  "Fable 5.1": "claude-fable-5-1",
  "Sonnet 5.5": "claude-sonnet-5-5",
  "GPT-6.1 Sol": "gpt-6.1-sol",
  "GPT-6 Astra": "gpt-6-astra",
  "GPT-6 Luna": "gpt-6-luna",
};
export function routeInput(value: unknown): RouteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("route input must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["role", "authorProvider", "effortOverride"].includes(k)) ||
      typeof v.role !== "string" || !Object.hasOwn(PAIRS, v.role) ||
      v.authorProvider !== undefined && !["claudeAgent", "codex"].includes(String(v.authorProvider)) ||
      v.effortOverride !== undefined && !["low", "medium", "high", "xhigh"].includes(String(v.effortOverride))) {
    throw new Error("Invalid route role, authorProvider or effortOverride");
  }
  return v as unknown as RouteInput;
}
export function ageSeconds(at: string | null | undefined, now: number): number | null {
  const age = at ? now - Date.parse(at) : NaN;
  return Number.isFinite(age) && age >= 0 ? Math.floor(age / 1000) : null;
}
