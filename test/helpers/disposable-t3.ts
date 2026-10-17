// A disposable T3 server for end-to-end tests.
//
// Runs the real pinned `t3` executable against a fresh base directory on the
// scratch disk, with an isolated HOME, a PATH that holds only the fake
// `claude`, node and the system directories, and settings that exist only in
// this instance. The server listens on 127.0.0.1 only. It can be prepared
// before it starts and restarted on the same base directory, as a host's T3
// would be across a restart. Nothing here touches the live T3 server, its
// settings or ~/.t3.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** The pinned T3 launcher; override with CHALDEA_T3_BIN. */
export const T3_LAUNCHER = process.env.CHALDEA_T3_BIN ?? "/home/igor/.local/share/mise/installs/node/26.10.0/bin/t3";

/** Resolves the npm launcher to the self-contained executable so signals reach the server itself. */
export function t3Executable(): string | null {
  if (!existsSync(T3_LAUNCHER)) return null;
  const launcher = realpathSync(T3_LAUNCHER);
  if (!launcher.endsWith(".js")) return launcher;
  const executable = join(dirname(launcher), "..", "node_modules", "@t3code", `t3-${process.platform}-${process.arch}`, "t3");
  return existsSync(executable) ? executable : null;
}

export function t3Version(): string | null {
  const executable = t3Executable();
  if (executable === null) return null;
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

export interface DisposableT3Options {
  /** Parent directory for the fixture; must be on disk, never /tmp. */
  readonly scratchRoot: string;
  readonly scenario: "reset" | "no-reset";
  readonly resetDelaySeconds?: number;
  /** Writes `autoResumeLimitedThreads` into this instance's settings.json. */
  readonly autoResume: boolean;
  /** Optional native restart recovery setting; omission tests the upstream default. */
  readonly restartContinuation?: boolean;
  readonly codex?: "available" | "exhausted";
  readonly claudeModel?: string;
}

export interface DisposableT3 {
  readonly root: string;
  /** The running server's URL; throws while it is stopped. */
  readonly serverUrl: string;
  readonly baseDir: string;
  readonly settingsPath: string;
  readonly workspaceDir: string;
  readonly fakeClaudeLog: string;
  readonly trigger: string;
  /** Starts the server on this base directory; resolves once it accepts WebSocket upgrades. */
  startServer(): Promise<void>;
  /** Stops the server (and its provider children) but keeps the base directory. */
  stopServer(signal?: NodeJS.Signals): Promise<void>;
  issueToken(scopes: ReadonlyArray<string>): string;
  fakeClaudeEvents(): Array<Record<string, unknown>>;
  /** Stops the server and removes the fixture. */
  stop(): Promise<void>;
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForServer(listening: () => string | null, child: ChildProcess, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`t3 exited early with code ${child.exitCode}`);
    const serverUrl = listening();
    if (serverUrl === null) {
      await new Promise((r) => setTimeout(r, 100));
      continue;
    }
    try {
      // Without the protocol parameter /ws answers 426 as soon as routing is up.
      const response = await fetch(new URL("/ws", serverUrl));
      await response.body?.cancel();
      if (response.status === 426) return serverUrl;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("t3 did not become ready in time");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function startDisposableT3(options: DisposableT3Options): Promise<DisposableT3> {
  const t3 = prepareDisposableT3(options);
  try {
    await t3.startServer();
  } catch (error) {
    await t3.stop();
    throw error;
  }
  return t3;
}

/** Creates the fixture without starting the server. */
export function prepareDisposableT3(options: DisposableT3Options): DisposableT3 {
  const executable = t3Executable();
  if (executable === null) throw new Error(`pinned t3 not found at ${T3_LAUNCHER}`);
  mkdirSync(options.scratchRoot, { recursive: true });
  const root = mkdtempSync(join(options.scratchRoot, "t3-"));
  const baseDir = join(root, "server");
  const home = join(root, "home");
  const bin = join(root, "bin");
  const workspaceDir = join(root, "workspace");
  const tmp = join(root, "tmp");
  for (const dir of [baseDir, home, bin, workspaceDir, tmp, join(home, ".claude"), join(baseDir, "userdata")]) {
    mkdirSync(dir, { recursive: true });
  }
  const fakeClaudeLog = join(root, "fake-claude.jsonl");
  const trigger = "chaldea-quota-trigger";
  const claudeLauncher = join(bin, "claude");
  writeFileSync(
    claudeLauncher,
    [
      "#!/bin/sh",
      `export FAKE_CLAUDE_STATE=${shellQuote(join(root, "fake-claude-state.json"))}`,
      `export FAKE_CLAUDE_LOG=${shellQuote(fakeClaudeLog)}`,
      `export FAKE_CLAUDE_SCENARIO=${shellQuote(options.scenario)}`,
      `export FAKE_CLAUDE_RESET_DELAY_S=${shellQuote(String(options.resetDelaySeconds ?? 10))}`,
      `export FAKE_CLAUDE_TRIGGER=${shellQuote(trigger)}`,
      `export FAKE_CLAUDE_MODEL=${shellQuote(options.claudeModel ?? "claude-sonnet-4-6")}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "test/fixtures/fake-claude.mjs"))} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(claudeLauncher, 0o755);

  const codexLauncher = join(bin, "codex");
  if (options.codex) {
    const codexHome = join(home, ".codex");
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(codexLauncher, [
      "#!/bin/sh",
      `export FAKE_CODEX_LOG=${shellQuote(join(root, "fake-codex.jsonl"))}`,
      `export FAKE_CODEX_EXHAUSTED=${shellQuote(options.codex === "exhausted" ? "1" : "0")}`,
      `exec ${shellQuote(process.execPath)} ${shellQuote(join(repoRoot, "test/fixtures/fake-codex.mjs"))} "$@"`,
      "",
    ].join("\n"));
    chmodSync(codexLauncher, 0o755);
  }
  const settingsPath = join(baseDir, "userdata", "settings.json");
  const disabled = (driver: string) => ({ driver, enabled: false });
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        autoResumeLimitedThreads: options.autoResume,
        ...(options.restartContinuation === undefined ? {} : { continueThreadsAfterServerUpdate: options.restartContinuation }),
        enableProviderUpdateChecks: false,
        defaultModelSelection: { instanceId: "claudeAgent", model: options.claudeModel ?? "claude-sonnet-4-6" },
        providerInstances: {
          claudeAgent: {
            driver: "claudeAgent",
            enabled: true,
            config: { binaryPath: claudeLauncher, homePath: join(home, ".claude") },
          },
          codex: options.codex ? {
            driver: "codex", enabled: true,
            config: { binaryPath: codexLauncher, homePath: join(home, ".codex") },
          } : disabled("codex"),
          opencode: disabled("opencode"),
          cursor: disabled("cursor"),
          grok: disabled("grok"),
          antigravity: disabled("antigravity"),
          pi: disabled("pi"),
          muse: disabled("muse"),
        },
      },
      null,
      2,
    ),
  );

  const env: Record<string, string> = {
    HOME: home,
    PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local/share"),
    XDG_STATE_HOME: join(home, ".local/state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    LANG: "C.UTF-8",
  };
  const log = createWriteStream(join(root, "t3.log"), { flags: "a" });

  let child: ChildProcess | null = null;
  let currentUrl: string | null = null;
  // If the test process exits without stopping the server, take the group down with it.
  const killOnExit = () => {
    try {
      if (child?.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // Already gone.
    }
  };

  const stopServer = async (signal: NodeJS.Signals = "SIGTERM") => {
    const running = child;
    child = null;
    currentUrl = null;
    process.removeListener("exit", killOnExit);
    if (running?.pid === undefined) return;
    const pid = running.pid;
    const exited = running.exitCode !== null || running.signalCode !== null
      ? Promise.resolve()
      : new Promise<void>((r) => running.once("exit", () => r()));
    const signalGroup = (signal: NodeJS.Signals) => {
      try {
        // The negative pid reaches the whole group, including provider children.
        process.kill(-pid, signal);
      } catch {
        // Already gone.
      }
    };
    signalGroup(signal);
    const timeout = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref());
    await Promise.race([exited, timeout(10_000)]);
    signalGroup("SIGKILL");
    await Promise.race([exited, timeout(5_000)]);
  };

  const startServer = async () => {
    if (child !== null) throw new Error("t3 is already running");
    const port = await freePort();
    const started = spawn(
      executable,
      ["start", "--base-dir", baseDir, "--host", "127.0.0.1", "--port", String(port), "--no-browser", "--auto-bootstrap-project-from-cwd", workspaceDir],
      { cwd: workspaceDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    child = started;
    process.once("exit", killOnExit);
    started.stdout?.pipe(log, { end: false });
    started.stderr?.pipe(log, { end: false });
    // T3 may not bind the requested port, so trust the address it reports.
    let listeningUrl: string | null = null;
    let pending = "";
    const scan = (chunk: Buffer) => {
      if (listeningUrl !== null) return;
      pending = (pending + chunk.toString("utf8")).slice(-4096);
      const match = /Listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(pending);
      if (match?.[1]) listeningUrl = match[1];
    };
    started.stdout?.on("data", scan);
    started.stderr?.on("data", scan);
    currentUrl = await waitForServer(() => listeningUrl, started, 90_000);
  };

  let removed = false;
  return {
    root,
    get serverUrl() {
      if (currentUrl === null) throw new Error("t3 is not running");
      return currentUrl;
    },
    baseDir,
    settingsPath,
    workspaceDir,
    fakeClaudeLog,
    trigger,
    startServer,
    stopServer,
    issueToken(scopes) {
      const args = ["auth", "session", "issue", "--base-dir", baseDir, "--ttl", "1h", "--label", "chaldea-e2e", "--token-only"];
      for (const scope of scopes) args.push("--scope", scope);
      const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 60_000 });
      if (result.status !== 0) throw new Error(`t3 auth session issue failed with status ${result.status}`);
      return result.stdout.trim();
    },
    fakeClaudeEvents() {
      if (!existsSync(fakeClaudeLog)) return [];
      return readFileSync(fakeClaudeLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    async stop() {
      if (removed) return;
      removed = true;
      await stopServer();
      log.end();
      if (process.env.CHALDEA_KEEP_FIXTURES !== "1") rmSync(root, { recursive: true, force: true });
    },
  };
}
