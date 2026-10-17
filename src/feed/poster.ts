// Delivers quota records to the fleet feed through the `feed post` CLI.
//
// Posting never blocks the observer: records go into a bounded in-memory
// queue drained by one worker. Each record gets exactly one attempt with a
// timeout. The CLI has no idempotency key, so a failed attempt may still have
// reached the server; retrying could post the record twice. A failure is
// therefore logged and the record dropped. Bodies carry identifiers and
// timestamps only, never transcript text or credentials, and the CLI's stderr
// is never logged (only its length), since it can echo URLs or account names.
import { spawn } from "node:child_process";
import { hostname } from "node:os";

import type { QuotaRecord } from "../quota/observer.ts";
import type { Logger } from "../log.ts";

export const FEED_SOURCE = "chaldea-quota";
export const FEED_TAGS = "quota chaldea";
export const MAX_QUEUED_RECORDS = 256;
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
    case "provider_switch_failed":
      return `provider_switch_failed: ${record.provider} thread ${thread}; native recovery fallback (${record.reason})`;
    case "provider_switched":
      return `provider_switched: ${record.fromProvider}/${record.fromModel} to ${record.toProvider}/${record.toModel} thread ${thread}`;
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
  readonly attemptTimeoutMs?: number;
}

/** Why an attempt failed, without any of the CLI's output. */
class AttemptFailure extends Error {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderrBytes: number;
  readonly spawnError: string | null;

  constructor(exitCode: number | null, signal: string | null, stderrBytes: number, spawnError: string | null) {
    super("feed post failed");
    this.exitCode = exitCode;
    this.signal = signal;
    this.stderrBytes = stderrBytes;
    this.spawnError = spawnError;
  }
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
    let stderrBytes = 0;
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
    let settled = false;
    const settle = (failure: AttemptFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (failure === null) resolve();
      else reject(failure);
    };
    child.once("error", (error: NodeJS.ErrnoException) => {
      settle(new AttemptFailure(null, null, stderrBytes, error.code ?? "spawn_error"));
    });
    child.once("close", (code, signal) => {
      settle(code === 0 ? null : new AttemptFailure(code, signal, stderrBytes, null));
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
    this.#kick();
  }

  #kick(): void {
    this.#draining ??= this.#drain().finally(() => {
      this.#draining = null;
      // A record queued after the loop's last check would otherwise wait for the next enqueue.
      if (this.#queue.length > 0) this.#kick();
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
    const fields = { kind: record.kind, thread: record.threadId, run: record.runId };
    try {
      await runOnce(this.#options, record);
      this.#options.logger.info("posted feed record", fields);
    } catch (error) {
      const failure = error instanceof AttemptFailure ? error : null;
      this.#options.logger.error("feed post failed; record dropped", {
        ...fields,
        exitCode: failure?.exitCode ?? null,
        signal: failure?.signal ?? null,
        stderrBytes: failure?.stderrBytes ?? null,
        spawnError: failure?.spawnError ?? null,
      });
    }
  }
}
