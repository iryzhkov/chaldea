// `chaldea` command-line entry point.
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { loadHeadroomConfig } from "./quota/codex-balance.ts";
import { humanStatus, statusSnapshot } from "./quota/headroom.ts";
import { loadState } from "./quota/state.ts";
import { switchConfig } from "./quota/routing.ts";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { shortHostname } from "./feed/poster.ts";
import { createLogger } from "./log.ts";
import { ConfigurationError, EXIT_CONFIG, readToken, runObserver } from "./quota/run.ts";
import { ProtocolIncompatibleError, discoverServerUrl, setAutoResumeLimitedThreads } from "./t3/adapter.ts";

const USAGE = `Usage:
  chaldea quota observe [options]
  chaldea quota status [--json] [--state-file PATH]
  chaldea access --help
  chaldea t3 restart [options]\n  chaldea t3 set-auto-resume on|off [options]\n  chaldea wait|decision|waits|mcp --help

quota observe: records T3 usage-limit stops and native auto-resumes in the fleet feed.
  --server-url URL     T3 URL (default: origin in <t3-base-dir>/userdata/server-runtime.json)
  --t3-base-dir DIR    T3 base directory (default: ~/.t3)
  --token-file PATH    Bearer token, mode 0600 (default: ~/.config/chaldea/t3-token)
  --state-file PATH    Cursor and posted keys (default: ~/.local/state/chaldea/quota-observer.json)
  --feed-command PATH  Feed CLI to run (default: feed)
  --quota-config PATH  Codex contexts (default: ~/.config/chaldea/quota.json, optional)
  --enable-provider-switch  Continue quota stops on an equivalent provider (default: off)
  --switch-config PATH  JSON { enabled, equivalences: [[Claude model, Codex model], ...] }
  --restart-config PATH  Planned restart recovery config (enabled by default)\n  --host NAME          Host name for feed records (default: short hostname)

t3 set-auto-resume: turns T3's autoResumeLimitedThreads on or off through server.updateSettings.
  --server-url URL     As above
  --t3-base-dir DIR    As above
  --token-file PATH    Short-lived settings:write token, mode 0600 (default: ~/.config/chaldea/t3-settings-token)
`;

async function restart(rest: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...rest], options: {
    "server-url": { type: "string" }, "t3-base-dir": { type: "string" },
    "token-file": { type: "string" }, "restart-config": { type: "string" },
    "feed-command": { type: "string" },
    help: { type: "boolean", short: "h" },
  }, allowPositionals: true, strict: true });
  if (values.help) { process.stdout.write("chaldea t3 restart [--t3-base-dir DIR] [--token-file PATH] [--restart-config PATH] [--server-url URL]\n"); return 0; }
  if (positionals.length) throw new Error("t3 restart takes no positional arguments");
  const { restartConfig, restartT3 } = await import("./t3/restart.ts");
  try {
    await restartT3({
      t3BaseDir: values["t3-base-dir"] ?? join(homedir(), ".t3"),
      ...(values["server-url"] === undefined ? {} : { serverUrl: values["server-url"] }),
      tokenFile: values["token-file"] ?? join(homedir(), ".config/chaldea/t3-token"),
      ...(values["feed-command"] === undefined ? {} : { feedCommand: values["feed-command"] }),
      config: restartConfig(values["restart-config"]), logger: createLogger(),
    });
    return 0;
  } catch (error) {
    process.stderr.write(`chaldea: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function setAutoResume(rest: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: {
      "server-url": { type: "string" },
      "t3-base-dir": { type: "string" },
      "token-file": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  const [mode, ...extra] = positionals;
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if ((mode !== "on" && mode !== "off") || extra.length > 0) {
    process.stderr.write(USAGE);
    return 64;
  }
  const home = homedir();
  const serverUrl = values["server-url"] ?? discoverServerUrl(values["t3-base-dir"] ?? join(home, ".t3"));
  if (serverUrl === null) {
    process.stderr.write("chaldea: T3 is not running (no server-runtime.json)\n");
    return 69;
  }
  try {
    const token = readToken(values["token-file"] ?? join(home, ".config", "chaldea", "t3-settings-token"));
    const now = await setAutoResumeLimitedThreads({ serverUrl, token }, mode === "on");
    process.stdout.write(`autoResumeLimitedThreads is ${now ? "on" : "off"}\n`);
    return now === (mode === "on") ? 0 : 1;
  } catch (error) {
    process.stderr.write(`chaldea: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof ConfigurationError || error instanceof ProtocolIncompatibleError ? EXIT_CONFIG : 1;
  }
}

async function observe(rest: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: {
      "server-url": { type: "string" },
      "t3-base-dir": { type: "string" },
      "token-file": { type: "string" },
      "state-file": { type: "string" },
      "feed-command": { type: "string" },
      "quota-config": { type: "string" },
      "enable-provider-switch": { type: "boolean" },
      "switch-config": { type: "string" },
      "restart-config": { type: "string" },
      host: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (positionals.length > 0) {
    process.stderr.write(USAGE);
    return 64;
  }
  const home = homedir();
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  try {
    const serverUrl = values["server-url"];
    return await runObserver({
      ...(serverUrl === undefined ? {} : { serverUrl }),
      t3BaseDir: values["t3-base-dir"] ?? join(home, ".t3"),
      tokenFile: values["token-file"] ?? join(home, ".config", "chaldea", "t3-token"),
      statePath: values["state-file"] ?? join(home, ".local", "state", "chaldea", "quota-observer.json"),
      feedCommand: values["feed-command"] ?? "feed",
      reporting: loadHeadroomConfig(home, values["quota-config"]),
      switching: (() => {
        const config = switchConfig(values["switch-config"] ? JSON.parse(readFileSync(values["switch-config"], "utf8")) : {});
        return { ...config, enabled: values["enable-provider-switch"] === true || config.enabled };
      })(),
      restart: (await import("./t3/restart.ts")).restartConfig(values["restart-config"]),
      host: values.host ?? shortHostname(),
      logger: createLogger(),
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(`chaldea: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CONFIG;
  }
}

async function quotaStatus(rest: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...rest], strict: true, allowPositionals: true,
    options: { json: { type: "boolean" }, "state-file": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) { process.stdout.write(USAGE); return 0; }
  if (positionals.length) return 64;
  try {
    const now = Date.now();
    const state = loadState(values["state-file"] ?? join(homedir(), ".local", "state", "chaldea", "quota-observer.json"), now);
    process.stdout.write(values.json ? JSON.stringify(statusSnapshot(state.headroom, now), null, 2) + "\n" : humanStatus(state.headroom, now));
    return 0;
  } catch {
    process.stderr.write("chaldea: quota snapshot could not be read\n");
    return 78;
  }
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [group, command, ...rest] = argv;
  try {
    if (group && ["waits","wait","decision","mcp"].includes(group)) {
      const { waitsCli } = await import("./waits/cli.ts");
      return await waitsCli(argv);
    }
    if (group === "access") {
      const { accessCli } = await import("./access/cli.ts");
      return await accessCli(argv.slice(1));
    }
    if (group === "quota" && command === "status") return await quotaStatus(rest);
    if (group === "quota" && command === "observe") return await observe(rest);
    if (group === "t3" && command === "restart") return await restart(rest);
    if (group === "t3" && command === "set-auto-resume") return await setAutoResume(rest);
  } catch (error) {
    // parseArgs rejects unknown options.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 64;
  }
  process.stderr.write(USAGE);
  return group === "--help" || group === "-h" ? 0 : 64;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
