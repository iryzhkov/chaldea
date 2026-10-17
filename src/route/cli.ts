import { parseArgs } from "node:util";
import { readJson } from "./cache.ts";
import { recommend } from "./policy.ts";
import type { PolicyData } from "./policy.ts";
import { routeInput } from "./types.ts";
import { route } from "./runtime.ts";
export const ROUTE_USAGE = `chaldea route --role builder|critical-review|bulk-read|general
  [--author-provider claudeAgent|codex] [--effort low|medium|high|xhigh]
  [--config PATH] [--fixture PATH]
Returns JSON for T3 delegate_task.target. Launch the delegate natively after routing.
--fixture reads injected catalog/quota/analytics/now and performs no collection.
`;
export async function routeCli(args: ReadonlyArray<string>): Promise<number> {
  const { values: v, positionals } = parseArgs({ args: [...args], strict: true, allowPositionals: true, options: {
    role: { type: "string" }, "author-provider": { type: "string" }, effort: { type: "string" },
    config: { type: "string" }, fixture: { type: "string" }, help: { type: "boolean", short: "h" },
  } });
  if (v.help) { process.stdout.write(ROUTE_USAGE); return 0; }
  if (positionals.length) throw new Error("route takes no positional arguments");
  const input = routeInput({ role: v.role, ...(v["author-provider"] ? { authorProvider: v["author-provider"] } : {}),
    ...(v.effort ? { effortOverride: v.effort } : {}) });
  const result = v.fixture ? recommend(input, readJson(v.fixture) as PolicyData)
    : await route(input, v.config ? { configPath: v.config } : {});
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}
