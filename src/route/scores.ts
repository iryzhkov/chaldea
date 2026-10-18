import type { Effort } from "./types.ts";

export interface Score {
  model: string; effort: Effort; aaSlug: string;
  intelligence: number; coding: number; inputPrice: number; outputPrice: number;
}
export interface ScoreSnapshot { version: 1; fetchedAt: string; indexVersion: string; models: Score[]; unmapped: string[] }
// Reviewed exact identifiers, including effort. Never map a max result to medium.
// Add a row after reviewing AA's release table; unknown names remain diagnostics.
export const MODEL_MAP: ReadonlyArray<{ model: string; effort: Effort; aaSlug: string; analytics: string; harness: string }> = [
  { model: "gpt-6.1-sol", effort: "high", aaSlug: "gpt-6-1-sol-high", analytics: "GPT-6.1 Sol", harness: "codex" },
  { model: "gpt-6.1-sol", effort: "medium", aaSlug: "gpt-6-1-sol-medium", analytics: "GPT-6.1 Sol", harness: "codex" },
  { model: "gpt-6-luna", effort: "medium", aaSlug: "gpt-6-luna-medium", analytics: "GPT-6 Luna", harness: "codex" },
  { model: "gpt-6-astra", effort: "medium", aaSlug: "gpt-6-astra-medium", analytics: "GPT-6 Astra", harness: "codex" },
  { model: "claude-opus-5-5", effort: "high", aaSlug: "claude-opus-5-5-high", analytics: "Opus 5.5", harness: "claudeAgent" },
  { model: "claude-opus-5-5", effort: "medium", aaSlug: "claude-opus-5-5-medium", analytics: "Opus 5.5", harness: "claudeAgent" },
  { model: "claude-fable-5-1", effort: "medium", aaSlug: "claude-fable-5-1-medium", analytics: "Fable 5.1", harness: "claudeAgent" },
  { model: "claude-haiku-5-5", effort: "medium", aaSlug: "claude-haiku-5-5-medium", analytics: "Haiku 5.5", harness: "claudeAgent" },
];
const safe = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_.:/ -]{1,160}$/.test(v);
const number = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function validateScores(raw: unknown): ScoreSnapshot {
  const s = raw as ScoreSnapshot;
  if (!s || s.version !== 1 || !Number.isFinite(Date.parse(s.fetchedAt)) || !safe(s.indexVersion) ||
      !Array.isArray(s.models) || !s.models.length || s.models.length > 128 ||
      !Array.isArray(s.unmapped) || s.unmapped.length > 512 || !s.unmapped.every(safe)) throw new Error("invalid_route_scores");
  if (Object.keys(s).some(k => !["version", "fetchedAt", "indexVersion", "models", "unmapped"].includes(k))) throw new Error("invalid_route_scores");
  const keys = new Set<string>();
  for (const m of s.models) {
    if (!m || Object.keys(m).some(k => !["model", "effort", "aaSlug", "intelligence", "coding", "inputPrice", "outputPrice"].includes(k))) throw new Error("invalid_route_scores");
    const key = m.model + ":" + m.effort;
    if (!safe(m.model) || !safe(m.aaSlug) || !["low", "medium", "high", "xhigh"].includes(m.effort) ||
        ![m.intelligence, m.coding, m.inputPrice, m.outputPrice].every(number) ||
        m.intelligence > 100 || m.coding > 100 || keys.has(key)) throw new Error("invalid_route_scores");
    keys.add(key);
  }
  // Return only public, known fields. Unknown upstream properties never enter publication.
  return { version: 1, fetchedAt: s.fetchedAt, indexVersion: s.indexVersion,
    models: s.models.map(m => ({ model: m.model, effort: m.effort, aaSlug: m.aaSlug,
      intelligence: m.intelligence, coding: m.coding, inputPrice: m.inputPrice, outputPrice: m.outputPrice })), unmapped: s.unmapped };
}
export function scoreSnapshot(raw: unknown, now: number): ScoreSnapshot {
  const r = raw as { data?: Array<Record<string, any>>; intelligence_index_version?: number; metadata?: Record<string, any> };
  if (!r || !Array.isArray(r.data)) throw new Error("invalid_aa_response");
  const models: Score[] = [], unmapped: string[] = [];
  for (const row of r.data) {
    const mapping = MODEL_MAP.find(m => m.aaSlug === row.slug);
    if (!mapping) { if (safe(row.slug)) unmapped.push(row.slug); continue; }
    const e = row.evaluations, p = row.pricing;
    if (!e || !p || ![e.artificial_analysis_intelligence_index, e.artificial_analysis_coding_index,
      p.price_1m_input_tokens, p.price_1m_output_tokens].every(number) ||
      e.artificial_analysis_intelligence_index > 100 || e.artificial_analysis_coding_index > 100) {
      unmapped.push(row.slug); continue;
    }
    models.push({ model: mapping.model, effort: mapping.effort, aaSlug: mapping.aaSlug,
      intelligence: e.artificial_analysis_intelligence_index, coding: e.artificial_analysis_coding_index,
      inputPrice: p.price_1m_input_tokens, outputPrice: p.price_1m_output_tokens });
  }
  const indexVersion = String(r.intelligence_index_version ?? r.metadata?.intelligence_index_version ?? r.metadata?.artificial_analysis_intelligence_index_version ?? "unversioned");
  return validateScores({ version: 1, fetchedAt: new Date(now).toISOString(), indexVersion, models, unmapped: unmapped.slice(0, 512) });
}
