// `chaldea` command-line entry point.
import { description, discoveryHelp } from "./describe.ts";
import { homedir } from "node:os";
import { configFailure, readJson } from "./config/files.ts";
import { quotaConfig } from "./config/quota.ts";
import { paths } from "./config/paths.ts";
import { EXIT } from "./config/exit.ts";
import { classifyCapacities } from "./quota/capacity.ts";
import { loadCapacityConfig } from "./quota/capacity-config.ts";
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
  chaldea route --role builder|critical-review|bulk-read|general [options]
  chaldea quota observe [options]
  chaldea quota status [--json] [--state-file PATH] [--capacity-config PATH]
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
      tokenFile: values["token-file"] ?? join(paths().config, "t3-token"),
      ...(values["feed-command"] === undefined ? {} : { feedCommand: values["feed-command"] }),
      config: restartConfig(values["restart-config"]), logger: createLogger(),
    });
    return 0;
  } catch (error) {
    createLogger().error("chaldea operation failed", { ...configFailure(error), error: error instanceof Error ? error.message : String(error) });
    return error instanceof ConfigurationError ? EXIT.config : EXIT.failure;
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
    const token = readToken(values["token-file"] ?? join(paths().config, "t3-settings-token"));
    const now = await setAutoResumeLimitedThreads({ serverUrl, token }, mode === "on");
    process.stdout.write(`autoResumeLimitedThreads is ${now ? "on" : "off"}\n`);
    return now === (mode === "on") ? 0 : 1;
  } catch (error) {
    createLogger().error("chaldea operation failed", { ...configFailure(error), error: error instanceof Error ? error.message : String(error) });
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
  const home = homedir(), p = paths();
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  try {
    const config = quotaConfig(home, values["quota-config"]);
    const serverUrl = values["server-url"] ?? config.serverUrl;
    return await runObserver({
      ...(serverUrl === undefined ? {} : { serverUrl }),
      t3BaseDir: values["t3-base-dir"] ?? config.t3BaseDir ?? join(home, ".t3"),
      tokenFile: values["token-file"] ?? config.tokenFile ?? join(p.config, "t3-token"),
      statePath: values["state-file"] ?? config.stateFile ?? join(p.state, "quota-observer.json"),
      feedCommand: values["feed-command"] ?? config.feedCommand ?? "feed",
      reporting: loadHeadroomConfig(home, values["quota-config"]),
      switching: (() => {
        const switching = switchConfig(values["switch-config"] || config.switchConfig ? readJson((values["switch-config"] ?? config.switchConfig)!) : {});
        return { ...switching, enabled: values["enable-provider-switch"] === true || config.enableProviderSwitch || switching.enabled };
      })(),
      restart: (await import("./t3/restart.ts")).restartConfig(values["restart-config"] ?? config.restartConfig),
      host: values.host ?? config.host ?? shortHostname(),
      logger: createLogger(),
      signal: controller.signal,
    });
  } catch (error) {
    createLogger().error("chaldea operation failed", { ...configFailure(error), error: error instanceof Error ? error.message : String(error) });
    return EXIT_CONFIG;
  }
}

async function quotaStatus(rest: ReadonlyArray<string>): Promise<number> {
  const { values, positionals } = parseArgs({ args: [...rest], strict: true, allowPositionals: true,
    options: { json: { type: "boolean" }, "state-file": { type: "string" }, "capacity-config": { type: "string" }, help: { type: "boolean", short: "h" } } });
  if (values.help) { process.stdout.write(USAGE); return 0; }
  if (positionals.length) return 64;
  try {
    const now = Date.now();
    const state = loadState(values["state-file"] ?? quotaConfig().stateFile ?? join(paths().state, "quota-observer.json"), now);
    const capacity = classifyCapacities(state, now, loadCapacityConfig(homedir(), values["capacity-config"]));
    process.stdout.write(values.json ? JSON.stringify({ ...statusSnapshot(state.headroom, now), capacity }, null, 2) + "\n"
      : humanStatus(state.headroom, now) + Object.entries(capacity).map(([id, c]) =>
        `${id} capacity: ${c.class}; ${c.reasons.join("; ")}; burn target ${c.burnTargetPerHour === null ? "unknown" : (c.burnTargetPerHour * 100).toFixed(2) + "%/hour"}\n`).join(""));
    return 0;
  } catch {
    createLogger().error("chaldea: quota snapshot could not be read");
    return 78;
  }
}

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  if (argv.length === 1 && argv[0] === "--describe") {
    const commands = (await import("./message.ts")).messageAvailable() ? [...description.commands, {name:"message send",summary:"Queue an authorized existing-thread message",access:"write"},{name:"message status",summary:"Read an authorized message receipt",access:"read"},{name:"message recover",summary:"Explicitly retry original stored message bytes",access:"write"},{name:"message targets",summary:"List configured message routes",access:"read"}] : description.commands;
    process.stdout.write(JSON.stringify({...description,commands}) + "\n");
    return 0;
  }
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) {
    const messaging = (await import("./message.ts")).messageAvailable() ? "\n  chaldea message send|status|recover --host HOST --thread THREAD --request-id ID [--text TEXT]\n" : "";
    process.stdout.write(discoveryHelp + "\n" + USAGE + messaging);
    return 0;
  }
  const [group, command, ...rest] = argv;
  if ((group === "quota" || group === "t3") && (command === "--help" || command === "-h") && rest.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    if (group && ["waits","wait","decision","mcp"].includes(group)) {
      const { waitsCli } = await import("./waits/cli.ts");
      return await waitsCli(argv);
    }
    if (group === "message") return await (await import("./message.ts")).messageCli(argv.slice(1));
    if (group === "route") return await (await import("./route/cli.ts")).routeCli(argv.slice(1));
    if (group === "access") {
      const { accessCli } = await import("./access/cli.ts");
      return await accessCli(argv.slice(1));
    }
    if (group === "quota" && command === "status") return await quotaStatus(rest);
    if (group === "quota" && command === "observe") return await observe(rest);
    if (group === "t3" && command === "restart") return await restart(rest);
    if (group === "t3" && command === "set-auto-resume") return await setAutoResume(rest);
  } catch (error) {
    if (error instanceof ConfigurationError) { createLogger().error("configuration unavailable", { file: error.file, reason: error.reason }); return EXIT.config; }
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
