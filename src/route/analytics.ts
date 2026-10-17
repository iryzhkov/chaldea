import { MODEL_NAMES } from "./types.ts";
import type { Analytics, ModelStats } from "./types.ts";
import { cached, getJson } from "./cache.ts";

export const SLOPALYTICS_URL = "https://slopalytics.com/data/t3-usage.json";
const count = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
export function aggregate(raw: unknown, fetchedAt: string): Analytics {
  const r = raw as Record<string, unknown> | null;
  if (!r || r.schemaVersion !== 2 || typeof r.fetchedAt !== "string" || !Number.isFinite(Date.parse(r.fetchedAt)) ||
    typeof r.start !== "string" || typeof r.endExclusive !== "string" ||
    !Number.isFinite(Date.parse(r.start)) || !(Date.parse(r.endExclusive) > Date.parse(r.start)) ||
    !Array.isArray(r.metrics)) throw new Error("Invalid Slopalytics data");
  const totals = new Map<string, { terminal: number; completed: number; failed: number; interrupted: number; timed: number; duration: number }>();
  for (const row of r.metrics) {
    if (!row || typeof row !== "object" || typeof row.model !== "string") continue;
    const id = MODEL_NAMES[row.model];
    if (!id) continue;
    // A model used through a different harness is not evidence about this candidate.
    if (row.harness !== (id.startsWith("claude-") ? "claudeAgent" : "codex")) continue;
    if (typeof row.day !== "string" || row.day < r.start || row.day >= r.endExclusive) continue;
    if (![row.terminal, row.completed, row.failed, row.interrupted, row.timedTurns, row.durationMs].every(count) ||
      row.completed + row.failed + row.interrupted !== row.terminal || row.timedTurns > row.terminal) throw new Error("Invalid Slopalytics metrics");
    const t = totals.get(id) ?? { terminal: 0, completed: 0, failed: 0, interrupted: 0, timed: 0, duration: 0 };
    t.terminal += row.terminal; t.completed += row.completed; t.failed += row.failed;
    t.interrupted += row.interrupted; t.timed += row.timedTurns; t.duration += row.durationMs;
    totals.set(id, t);
  }
  const models: Record<string, ModelStats> = {};
  for (const [id, t] of totals) if (t.terminal > 0) models[id] = {
    turns: t.terminal, completionRate: t.completed / t.terminal, failedRate: t.failed / t.terminal,
    interruptedRate: t.interrupted / t.terminal, minutesPerTurn: t.timed ? t.duration / t.timed / 60_000 : null,
  };
  return { fetchedAt, sourceFetchedAt: r.fetchedAt, endExclusive: r.endExclusive, models };
}
export function validateAnalytics(raw: unknown): Analytics {
  const a = raw as Analytics;
  if (!a || ![a.fetchedAt, a.sourceFetchedAt, a.endExclusive].every(v => typeof v === "string" && Number.isFinite(Date.parse(v))) ||
    !a.models || typeof a.models !== "object") throw new Error("Invalid analytics cache");
  for (const [id, s] of Object.entries(a.models)) {
    if (!Object.values(MODEL_NAMES).includes(id) || !s || !count(s.turns) ||
      ![s.completionRate, s.failedRate, s.interruptedRate].every(v => count(v) && v <= 1) ||
      s.minutesPerTurn !== null && !count(s.minutesPerTurn)) throw new Error("Invalid analytics cache");
  }
  return a;
}
export function collectAnalytics(path: string, now: number, fetcher: typeof fetch = fetch) {
  return cached(path, 86_400_000, now, validateAnalytics,
    async () => aggregate(await getJson(SLOPALYTICS_URL, {}, fetcher), new Date(now).toISOString()));
}
