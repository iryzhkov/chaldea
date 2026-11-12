import { join } from "node:path";
import { configPath, paths } from "./paths.ts";
import { configString, readJson, onlyKeys } from "./files.ts";
import { legacyEnv } from "./compat.ts";

/** Shared by the collector and in-process quota/restart publishers. */
export function eventsConfig() {
  const c = readJson(configPath("events"), true), p = paths();
  onlyKeys(c, ["url", "tokenHelper", "stateFile", "spool", "timerSpool"]);
  const optional = (key: string, env: string) => legacyEnv(env, key) ??
    (c[key] === undefined ? undefined : configString(c[key], key, ""));
  return {
    url: optional("url", "AKASHA_URL"), tokenHelper: optional("tokenHelper", "AKASHA_TOKEN_HELPER"),
    stateFile: optional("stateFile", "AKASHA_STATE_FILE") ?? join(p.state, "events/collector.db"),
    spool: optional("spool", "AKASHA_SPOOL") ?? join(p.data, "toolfeedback"),
    timerSpool: optional("timerSpool", "AKASHA_TIMER_SPOOL") ?? join(p.state, "timer-spool"),
  };
}
export function scopedEventsConfigured(): boolean {
  const c = eventsConfig();
  return c.url !== undefined || c.tokenHelper !== undefined;
}
