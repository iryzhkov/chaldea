import { RouteError } from "./errors.ts";
import { MODEL_MAP } from "./scores.ts";
export type Provider = string;
export type Role = "builder" | "critical-review" | "bulk-read" | "general" | "executor";
export type Effort = "low" | "medium" | "high" | "xhigh";
export interface RouteInput { role: Role; authorProvider?: Provider; effortOverride?: Effort }
export interface CatalogProvider {
  providerInstanceId: string;
  accountKey?: string;
  driverKind: string;
  canRunChildTask: boolean;
  models: ReadonlyArray<{ id: string; options?: ReadonlyArray<{
    id: string; type: string; options?: ReadonlyArray<{ id: string }>
  }> | null }>;
}
export interface QuotaWindow { id?: string; kind: string; remainingPercent: number; windowDurationMins: number | null; resetsAt: string | null }
export interface Quota {
  observedAt: string | null;
  windows: ReadonlyArray<QuotaWindow>;
  activeStop: boolean;
  operatorEstimate?: boolean;
  incomplete?: boolean;
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
export interface Target { accountKey?: string; providerInstanceId: string; model: string; options: Record<string, Effort> }
export type ProviderPick = (Target & { eligible: true; reasons: string[] }) |
  { eligible: false; model: null; options: null; reasons: string[] };
export interface RouteDiagnostics {
  quality_source: "fixed_policy" | "AA";
  benchmarkCoverage?: Record<string, { complete: boolean; models: number; covered: number; missing: string[] }>;
  fleet?: { readiness: "absent" | "disabled" | "ready" | "empty" | "unavailable"; freshAccounts: number };
  quota: Record<string, { accountKey: string | null; bindingSource: string; source: string; ageSeconds: number | null;
    freshness: "fresh" | "stale" | "unknown"; bindingWindow: string | null; scopedKnown: boolean; conflicts?: string[] }>;
}
export interface RouteResult extends Target {
  diagnostics?: RouteDiagnostics;
  byProvider: Record<Provider, ProviderPick>;
  alternatives: Target[];
  reasons: string[];
  dataAges: { quota: Record<string, number | null>; slopalytics: number | null; slopalyticsWindow: number | null; artificialAnalysis?: number | null };
  topPick?: Target;
}
export interface PolicyConfig {
  benchmark: { indexVersion: string; anchors?: Partial<Record<Role, string[]>> } | null;
  paceMargin: number;
  minimumRemaining: number;
  failureMargin: number;
  minimumTurns: number;
  quotaMaxAgeMs: number;
  analyticsMaxAgeMs: number;
  scoreMaxAgeMs: number;
  probationMs: number;
  probationShare: number;
  bans: string[];
  pins: Partial<Record<Role, { model: string; providerInstanceId?: string }>>;
  floors: Record<Role, number>;
}
export const DEFAULT_POLICY: PolicyConfig = {
  paceMargin: 0.10, minimumRemaining: 0.10, failureMargin: 0.10, minimumTurns: 100,
  quotaMaxAgeMs: 15 * 60_000, analyticsMaxAgeMs: 21 * 86_400_000,
  scoreMaxAgeMs: 3 * 86_400_000, probationMs: 7 * 86_400_000, probationShare: 0.10,
  bans: ["*sonnet*"], pins: {}, benchmark: null,
  floors: { builder: 50, "critical-review": 49, "bulk-read": 30, general: 48, executor: 48 },
};
export const PAIRS = {
  builder: ["claude-opus-5-5", "gpt-6.1-sol"],
  "critical-review": ["claude-fable-5-1", "gpt-6-astra"],
  "bulk-read": ["claude-haiku-5-5", "gpt-6-luna"],
  general: ["claude-opus-5-5", "gpt-6.1-sol"],
  executor: ["claude-opus-5-5", "gpt-6.1-sol"],
} as const;
export const MODEL_NAMES: Record<string, string> = Object.fromEntries(MODEL_MAP.map(m => [m.analytics, m.model]));
export function routeInput(value: unknown): RouteInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RouteError("usage", "route input must be an object");
  const v = value as Record<string, unknown>;
  if (Object.keys(v).some(k => !["role", "authorProvider", "effortOverride"].includes(k)) ||
      typeof v.role !== "string" || !Object.hasOwn(PAIRS, v.role) ||
      v.authorProvider !== undefined && (typeof v.authorProvider !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(v.authorProvider)) ||
      v.effortOverride !== undefined && !["low", "medium", "high", "xhigh"].includes(String(v.effortOverride))) {
    throw new RouteError("usage", "Invalid route role, authorProvider or effortOverride");
  }
  return v as unknown as RouteInput;
}
export function ageSeconds(at: string | null | undefined, now: number): number | null {
  const age = at ? now - Date.parse(at) : NaN;
  return Number.isFinite(age) && age >= 0 ? Math.floor(age / 1000) : null;
}
