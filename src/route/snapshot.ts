import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import { hostname } from "node:os";
import { cached, getJson, readJson } from "./cache.ts";
import { scoreSnapshot, validateScores } from "./scores.ts";
import type { ScoreSnapshot } from "./scores.ts";
import { helperToken, publish } from "../events/publisher.ts";
import type { PublisherOptions } from "../events/publisher.ts";

export interface ScoreTransport { enabled: boolean; url: string; tokenHelper: string; host: string }
export const AA_KEY = "/etc/chaldea-route/artificial-analysis-key";
const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
export function readAAKey(path = AA_KEY): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || (st.mode & 0o777) !== 0o600 || st.nlink !== 1 || st.size < 1 || st.size > 4096)
      throw new Error("invalid_aa_key_file");
    const key = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9_.-]{1,4096}$/.test(key)) throw new Error("invalid_aa_key_file");
    return key;
  } finally { closeSync(fd); }
}
export async function fetchScores(now: number, fetcher: typeof fetch = fetch, keyReader = readAAKey): Promise<ScoreSnapshot> {
  try {
    const key = keyReader(), rows: Array<Record<string, any>> = [];
    let version: number | undefined;
    for (let page = 1; page <= 8; page++) {
      const url = new URL(AA_URL); url.searchParams.set("page", String(page));
      const r = await getJson(url.toString(), { headers: { "x-api-key": key } }, fetcher, 4 * 1024 * 1024) as Record<string, any>;
      if (!Array.isArray(r.data) || !r.pagination || r.pagination.page !== page ||
          typeof r.intelligence_index_version !== "number" || !Number.isFinite(r.intelligence_index_version) ||
          page > 1 && version !== r.intelligence_index_version) throw new Error();
      version = r.intelligence_index_version; rows.push(...r.data);
      if (rows.length > 5000) throw new Error();
      if (r.pagination.has_more === false) return scoreSnapshot({ data: rows, intelligence_index_version: version }, now);
      if (r.pagination.has_more !== true) throw new Error();
    }
    throw new Error();
  } catch { throw new Error("aa_fetch_failed"); } // Never propagate a request, key or upstream body.
}
export async function publishScores(config: ScoreTransport, cacheFile: string, now: number,
  options: PublisherOptions & { keyReader?: typeof readAAKey; machine?: string } = {}): Promise<ScoreSnapshot> {
  if ((options.machine ?? hostname().split(".")[0]) !== "homelab") throw new Error("aa_fetch_homelab_only");
  if (!config.enabled || config.host !== "homelab") throw new Error("aa_publishing_not_configured");
  const result = await cached(cacheFile, 86400000, Math.floor(now / 86400000) * 86400000, validateScores,
    () => fetchScores(now, options.fetch, options.keyReader));
  if (!result.value || result.reason) throw new Error("aa_fetch_failed_last_good_retained");
  const s = result.value;
  const ok = await publish({ key: "route-scores:" + s.fetchedAt, source: "route", host: "homelab",
    payload: { v: 1, kind: "route_score_snapshot", title: "Artificial Analysis routing scores",
      data: { scores: s } } }, { url: config.url, helper: config.tokenHelper, ...options });
  if (!ok) throw new Error("aa_snapshot_publication_pending");
  return s;
}
export async function collectScores(config: ScoreTransport, cacheFile: string, now: number,
  fetcher: typeof fetch = fetch, tokenReader = helperToken) {
  if (!config.enabled) {
    // Disabling transport keeps last-good data usable without reserving a refresh.
    let value: ScoreSnapshot | null = null, fetchedAt: string | null = null;
    try {
      const prior = readJson(cacheFile) as { attemptedAt: number; fetchedAt: unknown; value: unknown };
      if (Number.isFinite(prior.attemptedAt) && prior.attemptedAt >= 0) {
        fetchedAt = typeof prior.fetchedAt === "string" && Number.isFinite(Date.parse(prior.fetchedAt)) ? prior.fetchedAt : null;
        if (prior.value !== null) value = validateScores(prior.value);
      }
    } catch { /* No valid last-good snapshot. Disabled transport never collects. */ }
    return { value, fetchedAt, reason: "snapshot transport disabled" };
  }
  return cached(cacheFile, 15 * 60000, now, validateScores, async () => {
    const token = await tokenReader(config.tokenHelper, { key: "", source: "route", host: config.host,
      payload: { kind: "route_score_snapshot" } }, "read");
    const url = new URL("/api/v1/events", config.url);
    url.searchParams.set("source", "route"); url.searchParams.set("host", "homelab");
    url.searchParams.set("kind", "route_score_snapshot"); url.searchParams.set("limit", "20");
    url.searchParams.set("from", new Date(now - 90 * 86400000).toISOString());
    url.searchParams.set("to", new Date(now).toISOString());
    let best: ScoreSnapshot | null = null;
    for (let page = 0; page < 8; page++) {
      const r = await getJson(url.toString(), { headers: { authorization: "Bearer " + token } }, fetcher) as Record<string, any>;
      if (!Array.isArray(r.events)) throw new Error();
      for (const e of r.events) {
        if (e.source !== "route" || e.host !== "homelab" || e.kind !== "route_score_snapshot" || e.provenance?.type !== "verified") continue;
        try {
          const s = validateScores(e.data?.scores);
          if (Date.parse(s.fetchedAt) <= now && (!best || Date.parse(s.fetchedAt) > Date.parse(best.fetchedAt))) best = s;
        } catch {}
      }
      if (r.next_cursor === null) {
        if (!best) throw new Error();
        try {
          const prior = validateScores((readJson(cacheFile) as { value: unknown }).value);
          if (Date.parse(prior.fetchedAt) <= now && Date.parse(prior.fetchedAt) > Date.parse(best.fetchedAt)) return prior;
        } catch {}
        return best;
      }
      if (typeof r.next_cursor !== "string" || r.next_cursor.length > 1024) throw new Error();
      url.searchParams.set("cursor", r.next_cursor);
    }
    throw new Error(); // A partial view must not replace the last successful snapshot.
  });
}
