import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** XDG base directories must be absolute; empty/relative values use the default. */
export function paths(home = homedir(), env: NodeJS.ProcessEnv = process.env) {
  const base = (key: string, fallback: string) => {
    const value = env[key];
    return value && isAbsolute(value) ? value : join(home, fallback);
  };
  return {
    config: join(base("XDG_CONFIG_HOME", ".config"), "chaldea"),
    state: join(base("XDG_STATE_HOME", ".local/state"), "chaldea"),
    data: base("XDG_DATA_HOME", ".local/share"),
    runtime: base("XDG_RUNTIME_DIR", ".cache"),
  };
}
export const configPath = (name: string, home?: string) => join(paths(home).config, name + ".json");
