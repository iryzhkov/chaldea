import type { RouteResult } from "./types.ts";
import { pairTarget } from "./pair.ts";
/** Bounded projection preserves the native target fields for existing callers. */
export function compactRoute(result: RouteResult) {
  const target = pairTarget(result);
  const quota = result.diagnostics?.quota[result.providerInstanceId + ":" + result.model] ?? null;
  const reasonCodes = [result.diagnostics?.quality_source === "AA" ? "quality_aa" : "quality_fixed_policy",
    "quota_" + (quota?.freshness ?? "unknown"), ...(quota?.scopedKnown === false ? ["model_scope_unknown"] : []),
    ...(quota?.conflicts?.length ? ["observation_conflict"] : [])];
  const reasons = [...new Set(result.reasons.filter(r => r.startsWith(result.providerInstanceId + " ") && !r.includes("capacity")))].slice(0, 2);
  if (!reasons.length) reasons.push("Selected eligible target under role, quota and separation policy");
  return { ...target, target, reasons, reasonCodes, quota,
    quality_source: result.diagnostics?.quality_source ?? "fixed_policy",
    fleet: result.diagnostics?.fleet ?? null,
    dataAges: { quota: { [result.providerInstanceId]: result.dataAges.quota[result.providerInstanceId] ?? null },
      artificialAnalysis: result.dataAges.artificialAnalysis ?? null, slopalytics: result.dataAges.slopalytics,
      slopalyticsWindow: result.dataAges.slopalyticsWindow },
    byProvider: Object.fromEntries(Object.entries(result.byProvider).slice(0, 8).map(([driver, pick]) => [driver,
      pick.eligible ? { ...pairTarget(pick), eligible: true } : { eligible: false, model: null, options: null }])),
    alternatives: result.alternatives.slice(0, 2).map(pairTarget) };
}
