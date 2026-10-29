import type { CatalogProvider, Effort, RouteDiagnostics, Target } from "./types.ts";
import type { ScoreSnapshot } from "./scores.ts";
import { banned, scoreFor } from "./targets.ts";

export function benchmarkEfforts(model: string, exact?: Effort): Effort[] {
  const efforts: Effort[] = ["low", "medium", "high"];
  if (/^(gpt-6-luna|claude-haiku-5-5)$/.test(model)) efforts.push("xhigh");
  return exact ? efforts.includes(exact) ? [exact] : [] : efforts;
}
export const targetEffort = (target: Target) => Object.values(target.options)[0]!;
/** Coverage means measured intelligence and cost for an allowed, offered variant of every unbanned model. */
export function benchmarkCoverage(catalog: readonly CatalogProvider[], scores: ScoreSnapshot | null,
  bans: readonly string[], exact?: Effort): NonNullable<RouteDiagnostics["benchmarkCoverage"]> {
  const groups = new Map<string, Map<string, boolean>>();
  for (const p of catalog) {
    if (!p.canRunChildTask) continue;
    const models = groups.get(p.driverKind) ?? new Map<string, boolean>();
    groups.set(p.driverKind, models);
    for (const m of p.models) {
      if (banned(m.id, bans)) continue;
      const offered = benchmarkEfforts(m.id, exact).filter(effort =>
        m.options?.some(o => ["reasoningEffort", "effort", "variant"].includes(o.id) &&
          o.type === "select" && o.options?.some(v => v.id === effort)));
      if (!offered.length) continue;
      const covered = offered.some(effort => scoreFor(scores, m.id, effort)?.benchmarkCostUSDPerTask != null);
      models.set(m.id, (models.get(m.id) ?? false) || covered);
    }
  }
  return Object.fromEntries([...groups].map(([driver, models]) => {
    const missing = [...models].filter(([, covered]) => !covered).map(([id]) => id).sort();
    return [driver, { complete: models.size > 0 && !missing.length, models: models.size,
      covered: models.size - missing.length, missing }];
  }));
}
export function compareBenchmark(x: Target, y: Target, scores: ScoreSnapshot): number {
  const a = scoreFor(scores, x.model, targetEffort(x))!, b = scoreFor(scores, y.model, targetEffort(y))!;
  return a.benchmarkCostUSDPerTask! - b.benchmarkCostUSDPerTask! || b.intelligence - a.intelligence;
}
