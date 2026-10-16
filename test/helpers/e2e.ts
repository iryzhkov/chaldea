// Pieces shared by the end-to-end tests: the observer as a real child process,
// a test-side shell watcher, the feed recorder log and a driver for the
// disposable T3 (dispatching messages, reading and changing settings).
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import * as Effect from "effect/Effect";

import { connectShell, withClient, type ShellThread } from "../../src/t3/adapter.ts";
import type { DisposableT3 } from "./disposable-t3.ts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const FEED_RECORDER = join(repoRoot, "test/fixtures/feed-recorder");

export async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface FeedEntry {
  readonly args: ReadonlyArray<string>;
  readonly body: Record<string, unknown>;
}

export function readFeed(path: string): Array<FeedEntry> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const entry = JSON.parse(line);
      return { args: entry.args, body: JSON.parse(entry.body) };
    });
}

/** `chaldea quota observe` running as its own process, as systemd would run it. */
export class ObserverProcess {
  readonly #child: ChildProcess;
  readonly lines: Array<Record<string, unknown>> = [];

  constructor(options: { serverUrl: string; tokenFile: string; statePath: string; feedLog: string; scratch: string }) {
    this.#child = spawn(
      process.execPath,
      [
        join(repoRoot, "src/cli.ts"),
        "quota",
        "observe",
        "--server-url",
        options.serverUrl,
        "--token-file",
        options.tokenFile,
        "--state-file",
        options.statePath,
        "--feed-command",
        FEED_RECORDER,
        "--host",
        "e2e-host",
      ],
      {
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: options.scratch, TMPDIR: options.scratch, FEED_RECORDER_LOG: options.feedLog },
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    let pending = "";
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      pending += chunk.toString("utf8");
      const parts = pending.split("\n");
      pending = parts.pop() ?? "";
      for (const part of parts) {
        try {
          this.lines.push(JSON.parse(part));
        } catch {
          this.lines.push({ message: part });
        }
      }
    });
  }

  subscriptions(): number {
    return this.lines.filter((line) => line.message === "subscribed to T3 shell").length;
  }

  async stop(signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return this.#child.exitCode;
    const exited = new Promise<number | null>((r) => this.#child.once("exit", (code) => r(code)));
    this.#child.kill(signal);
    return exited;
  }
}

/** Follows one disposable T3's shell from the test's side. */
export class ShellWatcher {
  readonly #controller = new AbortController();
  readonly threads = new Map<string, ShellThread>();
  readonly runs = new Map<string, Set<string>>();
  readonly runStarts = new Map<string, string>();
  readonly done: Promise<void>;

  constructor(serverUrl: string, token: string) {
    this.done = connectShell(
      { serverUrl, token, signal: this.#controller.signal },
      {
        onEvent: (event) => {
          const seen = event.kind === "snapshot" ? event.threads : event.kind === "thread" ? [event.thread] : [];
          for (const thread of seen) {
            this.threads.set(thread.id, thread);
            if (thread.latestRunId !== null) {
              const runs = this.runs.get(thread.id) ?? new Set<string>();
              runs.add(thread.latestRunId);
              this.runs.set(thread.id, runs);
              if (thread.latestRunStartedAt !== null) this.runStarts.set(thread.latestRunId, thread.latestRunStartedAt);
            }
          }
        },
      },
    ).catch(() => {});
  }

  firstThreadId(): string | null {
    return this.threads.keys().next().value ?? null;
  }

  async close(): Promise<void> {
    this.#controller.abort();
    await this.done;
  }
}

export async function dispatchMessage(t3: DisposableT3, token: string, threadId: string, text: string, id: string): Promise<void> {
  await withClient({ serverUrl: t3.serverUrl, token }, (client) =>
    client["orchestration.dispatchCommand"]({
      type: "message.dispatch",
      commandId: `e2e-command-${id}`,
      threadId,
      messageId: `e2e-message-${id}`,
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    } as never) as Effect.Effect<unknown, unknown>,
  );
}

export async function readAutoResumeSetting(t3: DisposableT3, token: string): Promise<boolean> {
  const settings = await withClient({ serverUrl: t3.serverUrl, token }, (client) =>
    client["server.getSettings"]({}) as Effect.Effect<{ autoResumeLimitedThreads: boolean }, unknown>,
  );
  return settings.autoResumeLimitedThreads;
}

export async function updateAutoResumeSetting(t3: DisposableT3, token: string, value: boolean): Promise<void> {
  await withClient({ serverUrl: t3.serverUrl, token }, (client) =>
    client["server.updateSettings"]({ patch: { autoResumeLimitedThreads: value } }) as Effect.Effect<unknown, unknown>,
  );
}

export function writePrivateFile(path: string, content: string): void {
  writeFileSync(path, content, { mode: 0o600 });
}
