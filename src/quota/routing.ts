// Opt-in equivalence routing and fail-closed quota admission.
import type { ModelChoice, SwitchProvider } from "../t3/adapter.ts";

export const DEFAULT_EQUIVALENCES: ReadonlyArray<readonly [string, string]> = [
  ["claude-opus-5-5", "gpt-6.1-sol"],
  ["claude-sonnet-5-5", "gpt-6-luna"],
  ["claude-fable-5-1", "gpt-6-astra"],
];
export interface SwitchConfig {
  readonly enabled: boolean;
  /** [Claude model, Codex model]; replaces defaults when supplied. */
  readonly equivalences: ReadonlyArray<readonly [string, string]>;
}
export function switchConfig(raw: unknown = {}): SwitchConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("switch config must be an object");
  const value = raw as Record<string, unknown>;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") throw new Error("enabled must be boolean");
  const pairs = value.equivalences ?? DEFAULT_EQUIVALENCES;
  if (!Array.isArray(pairs) || pairs.length > 128) throw new Error("equivalences must contain at most 128 model pairs");
  const seen = [new Set<string>(), new Set<string>()];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new Error("each equivalence must be [Claude model, Codex model]");
    pair.forEach((model, i) => {
      if (typeof model !== "string" || !model.trim() || model.trim() !== model || model.length > 200 || seen[i]!.has(model)) {
        throw new Error("equivalence models must be unique nonempty strings of at most 200 characters");
      }
      seen[i]!.add(model);
    });
  }
  return { enabled: value.enabled === true, equivalences: pairs as Array<[string, string]> };
}

export const MAX_USAGE_AGE_MS = 5 * 60_000;

/** No inference from elapsed resets, API billing, or missing/failed usage probes. */
export function hasQuota(provider: SwitchProvider | undefined, nowMs = Date.now()): provider is SwitchProvider {
  const limits = provider?.usageLimits;
  return provider !== undefined && provider.enabled && provider.installed &&
    provider.availability !== "unavailable" && provider.status === "ready" &&
    provider.auth.status === "authenticated" && limits !== undefined &&
    // Only the included lane can admit an included-usage switch. Paid controls/inventory cannot.
    !(provider.headroom?.included.ordinaryUsageAllowed.state === "fresh" &&
      provider.headroom.included.ordinaryUsageAllowed.value === false) &&
    limits.unavailable === undefined && limits.windows.length > 0 &&
    Number.isFinite(Date.parse(limits.checkedAt)) && Date.parse(limits.checkedAt) <= nowMs &&
    nowMs - Date.parse(limits.checkedAt) <= MAX_USAGE_AGE_MS &&
    limits.windows.every((w) => Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent < 100);
}

export function equivalentTarget(
  source: ModelChoice,
  providers: ReadonlyArray<SwitchProvider>,
  config: SwitchConfig,
  nowMs = Date.now(),
): ModelChoice | null {
  const index = source.instanceId === "claudeAgent" ? 0 : source.instanceId === "codex" ? 1 : -1;
  if (index === -1) return null;
  const pair = config.equivalences.find((p) => p[index] === source.model);
  if (!pair) return null;
  const instanceId = index === 0 ? "codex" : "claudeAgent";
  const provider = providers.find((p) => p.instanceId === instanceId && p.driver === instanceId);
  if (!hasQuota(provider, nowMs)) return null;
  const model = pair[1 - index]!;
  const catalogModel = provider.models.find((m) => m.slug === model);
  if (!catalogModel) return null;
  const effort = source.options?.find((o) => o.id === (index === 0 ? "effort" : "reasoningEffort"));
  if (effort === undefined) return { instanceId, model };
  const id = index === 0 ? "reasoningEffort" : "effort";
  const descriptor = catalogModel.capabilities?.optionDescriptors?.find((d) => d.id === id && d.type === "select");
  if (typeof effort.value !== "string" || !descriptor?.options?.some((o) => o.id === effort.value)) return null;
  return { instanceId, model, options: [{ id, value: effort.value }] };
}
