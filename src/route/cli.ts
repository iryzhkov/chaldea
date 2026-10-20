import { homedir } from "node:os";
import { join } from "node:path";
import { loadRouteConfig } from "./config.ts";
import { publishScores } from "./snapshot.ts";
import { parseArgs } from "node:util";
import { readJson } from "./cache.ts";
import { recommend } from "./policy.ts";
import type { PolicyData } from "./policy.ts";
import { routeInput } from "./types.ts";
import { route, routeReviewPair } from "./runtime.ts";
import { recommendReviewPair, reviewPairInput } from "./pair.ts";
import { compactRoute } from "./output.ts";
import { RouteError, routeFailure } from "./errors.ts";
export const ROUTE_USAGE = `chaldea route --role builder|critical-review|bulk-read|general
  [--author-provider claudeAgent|codex] [--effort low|medium|high|xhigh]
  [--config PATH] [--fixture PATH] [--explain|--legacy-full]
Returns compact JSON with exact native target fields. --explain retains full legacy diagnostics.
--fixture reads injected catalog/quota/analytics/scores/history/now without collection.
chaldea route review-pair --author-provider codex|claudeAgent
  [--main-role ROLE] [--peer-role ROLE] [--main-effort EFFORT] [--peer-effort EFFORT]
  [--allow-quota-exception] [--config PATH] [--fixture PATH]
chaldea route fetch-scores --config PATH: daily homelab AA fetch and Akasha publication.
`;
const fixture = (path: string) => {
  try {
    const value = readJson(path) as PolicyData;
    if (!value || typeof value !== "object" || !Array.isArray(value.catalog) ||
        !value.quota || typeof value.quota !== "object" || !Number.isFinite(value.now) ||
        value.analytics !== null && typeof value.analytics !== "object") throw new Error();
    return value;
  }
  catch { throw new RouteError("config", "Route fixture unreadable or invalid"); }
};
async function run(args: ReadonlyArray<string>): Promise<number> {
  if (args[0] === "fetch-scores") {
    const { values, positionals } = parseArgs({ args: args.slice(1), strict: true, allowPositionals: true,
      options: { config: { type: "string" }, help: { type: "boolean" } } });
    if (values.help) { process.stdout.write(ROUTE_USAGE); return 0; }
    if (positionals.length) throw new RouteError("usage", "fetch-scores takes no positional arguments");
    const c = (() => { try { return loadRouteConfig(homedir(), values.config ?? process.env.CHALDEA_ROUTE_CONFIG); }
      catch { throw new RouteError("config", "Route configuration unreadable or invalid"); } })();
    const s = await publishScores(c.scores, join(c.cacheDir, "aa-fetch.json"), Date.now());
    process.stdout.write(JSON.stringify({ fetchedAt: s.fetchedAt, mapped: s.models.length, unmapped: s.unmapped }) + "\n");
    return 0;
  }
  const pair = args[0] === "review-pair";
  const { values: v, positionals } = parseArgs({ args: pair ? args.slice(1) : [...args], strict: true, allowPositionals: true, options: {
    role: { type: "string" }, "author-provider": { type: "string" }, effort: { type: "string" },
    "main-role": { type: "string" }, "peer-role": { type: "string" }, "main-effort": { type: "string" }, "peer-effort": { type: "string" },
    "allow-quota-exception": { type: "boolean" }, explain: { type: "boolean" }, "legacy-full": { type: "boolean" },
    compact: { type: "boolean" }, config: { type: "string" }, fixture: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (v.help) { process.stdout.write(ROUTE_USAGE); return 0; }
  if (positionals.length) throw new RouteError("usage", "route takes no positional arguments");
  if (pair) {
    if (v.role || v.effort) throw new RouteError("usage", "review-pair uses --main-role/--peer-role and --main-effort/--peer-effort");
    const input = reviewPairInput({ authorProvider: v["author-provider"],
      ...(v["main-role"] ? { mainRole: v["main-role"] } : {}), ...(v["peer-role"] ? { peerRole: v["peer-role"] } : {}),
      ...(v["main-effort"] ? { mainEffort: v["main-effort"] } : {}), ...(v["peer-effort"] ? { peerEffort: v["peer-effort"] } : {}),
      ...(v["allow-quota-exception"] ? { allowQuotaException: true } : {}) });
    const result = v.fixture ? recommendReviewPair(input, fixture(v.fixture))
      : await routeReviewPair(input, v.config ? { configPath: v.config } : {});
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.status === "complete" ? 0 : 7;
  }
  if ((["main-role", "peer-role", "main-effort", "peer-effort", "allow-quota-exception"] as const).some(k => v[k] !== undefined))
    throw new RouteError("usage", "Pair flags require the review-pair subcommand");
  const input = routeInput({ role: v.role, ...(v["author-provider"] ? { authorProvider: v["author-provider"] } : {}),
    ...(v.effort ? { effortOverride: v.effort } : {}) });
  const result = v.fixture ? recommend(input, fixture(v.fixture)) : await route(input, v.config ? { configPath: v.config } : {});
  process.stdout.write(JSON.stringify(v.explain || v["legacy-full"] ? result : compactRoute(result)) + "\n");
  return 0;
}
export async function routeCli(args: ReadonlyArray<string>): Promise<number> {
  try { return await run(args); }
  catch (error) {
    const e = error && typeof error === "object" && "code" in error && String(error.code).startsWith("ERR_PARSE_ARGS")
      ? new RouteError("usage", "Invalid route arguments; see chaldea route --help") : routeFailure(error);
    process.stderr.write(JSON.stringify({ error: { code: e.code, message: e.message } }) + "\n");
    return { usage: 2, config: 3, catalog_unavailable: 4, usage_unavailable: 5, no_candidate: 6 }[e.code];
  }
}
