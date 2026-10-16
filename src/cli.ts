// `chaldea` command-line entry point.
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { shortHostname } from "./feed/poster.ts";
import { createLogger } from "./log.ts";
import { EXIT_CONFIG, runObserver } from "./quota/run.ts";

const USAGE = `Usage: chaldea quota observe [options]

Records T3 usage-limit stops and native auto-resumes in the fleet feed.

Options:
  --server-url URL     T3 URL (default: origin in <t3-base-dir>/userdata/server-runtime.json)
  --t3-base-dir DIR    T3 base directory (default: ~/.t3)
  --token-file PATH    Bearer token, mode 0600 (default: ~/.config/chaldea/t3-token)
  --state-file PATH    Cursor and posted keys (default: ~/.local/state/chaldea/quota-observer.json)
  --feed-command PATH  Feed CLI to run (default: feed)
  --host NAME          Host name for feed records (default: short hostname)
`;

export async function main(argv: ReadonlyArray<string>): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group !== "quota" || command !== "observe") {
    process.stderr.write(USAGE);
    return group === "--help" || group === "-h" ? 0 : 64;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: [...rest],
      options: {
        "server-url": { type: "string" },
        "t3-base-dir": { type: "string" },
        "token-file": { type: "string" },
        "state-file": { type: "string" },
        "feed-command": { type: "string" },
        host: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    }));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 64;
  }
  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const home = homedir();
  const controller = new AbortController();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());
  try {
    return await runObserver({
      ...(values["server-url"] === undefined ? {} : { serverUrl: values["server-url"] }),
      t3BaseDir: values["t3-base-dir"] ?? join(home, ".t3"),
      tokenFile: values["token-file"] ?? join(home, ".config", "chaldea", "t3-token"),
      statePath: values["state-file"] ?? join(home, ".local", "state", "chaldea", "quota-observer.json"),
      feedCommand: values["feed-command"] ?? "feed",
      host: values.host ?? shortHostname(),
      logger: createLogger(),
      signal: controller.signal,
    });
  } catch (error) {
    process.stderr.write(`chaldea: ${error instanceof Error ? error.message : String(error)}\n`);
    return EXIT_CONFIG;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
