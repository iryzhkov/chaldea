// Quota state owns durability; this worker only handles asynchronous delivery.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { QuotaRecord } from "../quota/observer.ts";
import type { Logger } from "../log.ts";
import { publish, type PublisherOptions, type Publication } from "../events/publisher.ts";
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
    case "quota_headroom_snapshot":
    case "quota_headroom_changed":
    case "quota_headroom_low":
      return `${record.kind}: ${record.headroom?.providers.map(p => p.alias).join(", ") ?? "unknown"}`;
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


export function quotaKey(record: QuotaRecord): string {
  // The observer claims each kind once for a stopped run. This is a logical
  // transition identity, independent of token leases and payload changes.
  return "quota/" + createHash("sha256").update(JSON.stringify([
    record.threadId, record.runId, record.kind, record.kind === "quota_resumed" ? record.continuationRunId ?? record.runId : record.runId,
  ])).digest("hex");
}
export function quotaPublication(record: QuotaRecord, host: string): Publication {
  const transition = quotaKey(record);
  const data: Record<string, unknown> = record.headroom ? { transition_id: transition } : { thread_id: record.threadId, run_id: record.runId,
    provider: record.toProvider ?? record.provider, transition_id: transition };
  if (record.kind === "quota_parked" && record.resetAt) data.reset_at = record.resetAt;
  if (record.kind === "provider_switched" || record.kind === "provider_switch_failed") {
    if (record.fromProvider) data.previous_provider = record.fromProvider;
    if (record.toModel) data.model = record.toModel;
    if (record.kind === "provider_switch_failed") data.error_class = "provider_switch_failed";
  }
  return { key: transition, source: FEED_SOURCE, host, payload: {
    v: 1, kind: record.kind, source: FEED_SOURCE, host, severity: record.severity,
    title: title(record).slice(0, 500), body: body(record, host), tags: ["quota", "chaldea"], data,
  } };
}
export interface FeedPosterOptions {
  /** Used only in legacy mode, chosen before any delivery attempt. */
  readonly command: string;
  readonly host: string;
  readonly logger: Logger;
  readonly attemptTimeoutMs?: number;
  readonly publisher?: PublisherOptions;
  readonly deliver?: (event: Publication) => Promise<boolean>;
  readonly retryMs?: number;
  readonly mode?: "legacy" | "akasha";
}
/** Before configured cutover retain the legacy one-attempt semantics. An
 * ambiguous legacy result is never retried; scoped mode never calls this path. */
async function legacyAttempt(options: FeedPosterOptions, record: QuotaRecord): Promise<void> {
  await new Promise<void>(resolve => {
    const child = spawn(options.command, ["post", title(record), "--severity", record.severity,
      "--source", FEED_SOURCE, "--host", options.host, "--tag", FEED_TAGS, "--body-file", "-"],
      { stdio: ["pipe", "ignore", "pipe"], detached: true,
        env: { ...process.env, FEED_IDEMPOTENCY_KEY: quotaKey(record) } });
    let stderrBytes = 0, settled = false;
    child.stderr.on("data", (b: Buffer) => { stderrBytes += b.length; });
    const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} },
      options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS);
    const finish = (ok: boolean) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (!ok) options.logger.warn("legacy feed attempt failed; record not retried", { kind: record.kind, stderrBytes });
      else options.logger.info("posted feed record", { kind: record.kind });
      resolve();
    };
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
    child.stdin.on("error", () => {});
    child.stdin.end(body(record, options.host));
  });
}
export class FeedPoster {
  readonly #options: FeedPosterOptions;
  readonly #akasha: boolean;
  readonly #queue = new Map<string, { record: QuotaRecord; ack?: () => boolean | void }>();
  #draining: Promise<void> | null = null;
  #timer: NodeJS.Timeout | null = null;
  #closed = false;
  constructor(options: FeedPosterOptions) {
    this.#options = options;
    // Configuration selects the mode once. Even incomplete scoped configuration
    // queues on failure; no auth result can select the legacy command.
    this.#akasha = options.mode === "akasha" || (options.mode !== "legacy" &&
      (options.publisher !== undefined || options.deliver !== undefined ||
       process.env.AKASHA_URL !== undefined || process.env.AKASHA_TOKEN_HELPER !== undefined));
  }
  enqueue(record: QuotaRecord, ack?: () => boolean | void): void {
    const key = quotaKey(record);
    if (this.#queue.has(key)) return;
    if (this.#queue.size >= MAX_QUEUED_RECORDS) {
      this.#options.logger.warn("feed worker full; durable intent retained"); return;
    }
    this.#queue.set(key, { record, ...(ack ? { ack } : {}) });
    this.#kick();
  }
  #kick(): void {
    if (this.#closed || this.#draining) return;
    this.#draining = this.#drain().finally(() => {
      this.#draining = null;
      if (!this.#closed && this.#queue.size > 0 && !this.#timer) {
        this.#timer = setTimeout(() => { this.#timer = null; this.#kick(); }, this.#options.retryMs ?? 30_000);
        this.#timer.unref();
      }
    });
  }
  /** Waits for current attempts, not an outage. Pending work remains durable. */
  async idle(): Promise<void> { while (this.#draining) await this.#draining; }
  close(): void { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); }
  async #drain(): Promise<void> {
    for (const [key, item] of this.#queue) {
      if (this.#closed) return;
      let ok = false;
      try {
        if (this.#akasha) ok = await (this.#options.deliver ?? ((e) => publish(e, this.#options.publisher)))(quotaPublication(item.record, this.#options.host));
        else {
          // Legacy feedd has no receipt contract: claim durably before its
          // one attempt, preserving the pre-cutover at-most-once policy.
          if (item.ack?.() === false) continue;
          this.#queue.delete(key);
          await legacyAttempt(this.#options, item.record);
          continue;
        }
      }
      catch {}
      if (ok) {
        // The acknowledgement atomically removes the state's pending payload.
        item.ack?.(); this.#queue.delete(key);
        this.#options.logger.info("posted feed record", { kind: item.record.kind });
      } else this.#options.logger.warn("event delivery deferred; durable intent retained", { kind: item.record.kind });
    }
  }
}
