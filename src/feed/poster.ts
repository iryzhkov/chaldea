// Delivers quota records to the fleet feed through the `feed post` CLI.
//
// Posting never blocks the observer: records go into a bounded in-memory
// queue drained by one worker. Each record gets a few attempts with backoff
// and a per-attempt timeout; after that it is logged and dropped. Bodies carry
// identifiers and timestamps only, never transcript text or credentials.
import { spawn } from "node:child_process";
import { hostname } from "node:os";

import type { QuotaRecord } from "../quota/observer.ts";
import type { Logger } from "../log.ts";

export const FEED_SOURCE = "chaldea-quota";
export const FEED_TAGS = "quota chaldea";
export const MAX_QUEUED_RECORDS = 256;
export const ATTEMPT_DELAYS_MS: ReadonlyArray<number> = [0, 2_000, 10_000];
export const ATTEMPT_TIMEOUT_MS = 20_000;

export function shortHostname(): string {
  return hostname().split(".")[0] ?? "unknown";
}

function shortId(id: string): string {
  return id.length <= 12 ? id : id.slice(-12);
}

export function title(record: QuotaRecord): string {
  const thread = shortId(record.threadId);
  switch (record.kind) {
    case "quota_parked":
      return `quota_parked: ${record.provider} thread ${thread} until ${record.resetAt}`;
    case "quota_reset_unknown":
      return `quota_reset_unknown: ${record.provider} thread ${thread} parked with no reset time`;
    case "quota_resumed":
      return `quota_resumed: ${record.provider} thread ${thread}${record.latenessSeconds == null ? "" : ` ${record.latenessSeconds}s after reset`}`;
  }
}

/** The JSON body: identifiers, provider and times only. */
export function body(record: QuotaRecord, host: string): string {
  return `${JSON.stringify({ ...record, host }, null, 2)}\n`;
}

export interface FeedPosterOptions {
  /** Executable to run; `feed` by default, a recorder in tests. */
  readonly command: string;
  readonly host: string;
  readonly logger: Logger;
  readonly attemptDelaysMs?: ReadonlyArray<number>;
  readonly attemptTimeoutMs?: number;
}

function runOnce(options: FeedPosterOptions, record: QuotaRecord): Promise<void> {
  const args = [
    "post",
    title(record),
    "--severity",
    record.severity,
    "--source",
    FEED_SOURCE,
    "--host",
    options.host,
    "--tag",
    FEED_TAGS,
    "--body-file",
    "-",
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(options.command, args, { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 512) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      // The CLI's stderr is short and never includes the feed token; cap it anyway.
      else reject(new Error(`feed post exited with ${code ?? signal}: ${stderr.trim().slice(0, 200)}`));
    });
    child.stdin.on("error", () => {
      // The close handler reports the failure.
    });
    child.stdin.end(body(record, options.host));
  });
}

export class FeedPoster {
  readonly #options: FeedPosterOptions;
  readonly #queue: Array<QuotaRecord> = [];
  #draining: Promise<void> | null = null;

  constructor(options: FeedPosterOptions) {
    this.#options = options;
  }

  /** Queues a record; returns immediately. Drops it with a log line when the queue is full. */
  enqueue(record: QuotaRecord): void {
    if (this.#queue.length >= MAX_QUEUED_RECORDS) {
      this.#options.logger.warn("feed queue full; dropping record", { kind: record.kind, thread: record.threadId, run: record.runId });
      return;
    }
    this.#queue.push(record);
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
    });
  }

  /** Resolves once the queue is empty; for shutdown and tests. */
  async idle(): Promise<void> {
    while (this.#draining !== null) await this.#draining;
  }

  async #drain(): Promise<void> {
    for (let record = this.#queue.shift(); record !== undefined; record = this.#queue.shift()) {
      await this.#deliver(record);
    }
  }

  async #deliver(record: QuotaRecord): Promise<void> {
    const delays = this.#options.attemptDelaysMs ?? ATTEMPT_DELAYS_MS;
    for (const [attempt, delay] of delays.entries()) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        await runOnce(this.#options, record);
        this.#options.logger.info("posted feed record", { kind: record.kind, thread: record.threadId, run: record.runId });
        return;
      } catch (error) {
        this.#options.logger.warn("feed post failed", {
          kind: record.kind,
          thread: record.threadId,
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.#options.logger.error("dropping feed record after bounded retries", { kind: record.kind, thread: record.threadId, run: record.runId });
  }
}
