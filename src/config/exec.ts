import { homedir } from "node:os";
import { join } from "node:path";
import { configPath, paths } from "./paths.ts";
import { configString, onlyKeys, readJson, ConfigurationError } from "./files.ts";
import { legacyEnv } from "./compat.ts";

export function execConfig() {
  const c = readJson(configPath("exec"), true), p = paths();
  onlyKeys(c, ["sshConfig", "stateDir", "hosts", "hostsFile"]);
  if (c.hosts !== undefined && (!Array.isArray(c.hosts) || !c.hosts.every(h => typeof h === "string" && /^[a-zA-Z0-9][a-zA-Z0-9-]{0,62}$/.test(h))))
    throw new ConfigurationError("Invalid exec hosts");
  return {
    sshConfig: legacyEnv("CHALDEA_SSH_CONFIG", "sshConfig") ?? configString(c.sshConfig, "sshConfig", join(homedir(), ".ssh/chaldea-job.conf")),
    stateDir: legacyEnv("CHALDEA_STATE_DIR", "stateDir") ?? configString(c.stateDir, "stateDir", join(p.state, "exec")),
    hostsFile: legacyEnv("CHALDEA_EXEC_HOSTS", "hostsFile") ?? configString(c.hostsFile, "hostsFile", join(p.config, "exec-hosts")),
    hosts: c.hosts as string[] | undefined,
  };
}
