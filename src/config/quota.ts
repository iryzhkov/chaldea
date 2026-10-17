import { configPath } from "./paths.ts";
import { configString, onlyKeys, readJson, ConfigurationError } from "./files.ts";

export function quotaConfig(home?: string, path?: string) {
  const c = readJson(path ?? configPath("quota", home), path === undefined);
  onlyKeys(c, ["contexts", "lowHeadroomPercent", "serverUrl", "t3BaseDir", "tokenFile", "stateFile", "feedCommand", "host", "switchConfig", "restartConfig", "enableProviderSwitch"]);
  if (c.enableProviderSwitch !== undefined && typeof c.enableProviderSwitch !== "boolean")
    throw new ConfigurationError("enableProviderSwitch must be boolean");
  const string = (key: string) => c[key] === undefined ? undefined : configString(c[key], key, "");
  return {
    serverUrl: string("serverUrl"), t3BaseDir: string("t3BaseDir"), tokenFile: string("tokenFile"),
    stateFile: string("stateFile"), feedCommand: string("feedCommand"), host: string("host"),
    switchConfig: string("switchConfig"), restartConfig: string("restartConfig"),
    contexts: c.contexts, lowHeadroomPercent: c.lowHeadroomPercent, enableProviderSwitch: c.enableProviderSwitch === true,
  };
}
