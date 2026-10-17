// Durable, bounded provider-switch intents. Every side effect follows a saved phase.
import { createHash } from "node:crypto";
import { AuthenticationError, type ModelChoice, type ShellEvent, type ShellThread, type SwitchPort } from "../t3/adapter.ts";
import type { Logger } from "../log.ts";
import { claim, stopTime, type QuotaRecord } from "./observer.ts";
import { equivalentTarget, type SwitchConfig } from "./routing.ts";
import { belowWatermark, MAX_ACTIVE_SWITCHES, MAX_STOP_AGE_MS, type ObserverState } from "./state.ts";
export { MAX_ACTIVE_SWITCHES, MAX_COMPLETED_SWITCHES } from "./state.ts";
export interface SwitchIntent {
  readonly threadId: string;
  readonly runId: string;
  readonly resetAt: string | null;
  readonly from: ModelChoice;
  readonly target: ModelChoice;
  readonly stopAt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly restoreAutoResume: boolean;
  readonly subagent: boolean;
  releaseAttempt?: number;
  phase: "holding" | "dispatching" | "releasing" | "switched" | "cancelled";
}
export function switchIds(threadId: string, runId: string) {
  const hash = createHash("sha256").update(JSON.stringify([threadId, runId])).digest("hex");
  const prefix = `chaldea-switch:${hash}`;
  return { key: hash, hold: `${prefix}:hold`, dispatch: `${prefix}:continue`, release: `${prefix}:release` };
}
export function activeIntent(intent: SwitchIntent): boolean {
  return intent.phase !== "switched" && intent.phase !== "cancelled";
}
export function switchable(thread: ShellThread): boolean {
  return thread.status === "failed" && thread.lastErrorClass === "usage_limit" &&
    thread.latestRunId !== null && thread.activeRunId === null &&
    !thread.deleted && !thread.archived && !thread.settled && !thread.pendingRequest;
}

export class ProviderSwitcher {
  readonly #state: ObserverState;
  readonly #save: () => boolean;
  readonly #record: (record: QuotaRecord) => void;
  readonly #logger: Logger;
  readonly #config: SwitchConfig;
  #port: SwitchPort;
  #authorized = true;
  #synced = false;
  readonly #stops = new Map<string, ShellThread>();

  constructor(options: { state: ObserverState; config: SwitchConfig; port: SwitchPort;
    save: () => boolean; record: (record: QuotaRecord) => void; logger: Logger }) {
    this.#state = options.state; this.#config = options.config; this.#port = options.port;
    this.#save = options.save; this.#record = options.record; this.#logger = options.logger;
  }
  /** Credential replacement on reconnect permits a fresh authorization attempt. */
  reconnect(port: SwitchPort, credentialChanged: boolean): void {
    this.#port = port; this.#synced = false; this.#stops.clear();
    if (credentialChanged) this.#authorized = true;
  }
  #persist(): void {
    if (!this.#save()) throw new Error("switch intent is not durable");
  }
  async handle(event: ShellEvent): Promise<void> {
    if (event.kind === "snapshot" || event.kind === "thread") {
      for (const thread of event.kind === "snapshot" ? event.threads : [event.thread]) {
        if (switchable(thread)) {
          if (this.#stops.size < 1_000 || this.#stops.has(thread.id)) this.#stops.set(thread.id, thread);
        } else this.#stops.delete(thread.id);
      }
    } else if (event.kind === "removed") this.#stops.delete(event.threadId);
    if (event.kind === "synchronized") this.#synced = true;
    if (!this.#synced || !this.#authorized) return;
    try {
      // Reconcile saved work before admitting new work, including after a reboot.
      for (const intent of this.#state.switches.values()) {
        if (activeIntent(intent) && (event.kind === "synchronized" ||
            event.kind === "thread" && event.thread.id === intent.threadId ||
            event.kind === "removed" && event.threadId === intent.threadId)) await this.#advance(intent);
      }
      const candidates = event.kind === "thread" ? [event.thread] : event.kind === "synchronized" ? [...this.#stops.values()] : [];
      for (const thread of candidates) await this.#admit(thread);
    } catch (error) {
      if (!(error instanceof AuthenticationError)) throw error;
      this.#authorized = false;
      this.#logger.warn("provider switching disabled: token needs orchestration:operate; observing continues");
    }
  }
  async #admit(thread: ShellThread): Promise<void> {
    if (!this.#config.enabled || !switchable(thread) || !thread.modelSelection) return;
    const ids = switchIds(thread.id, thread.latestRunId!);
    if (this.#state.switches.has(ids.key)) return;
    if ([...this.#state.switches.values()].filter(activeIntent).length >= MAX_ACTIVE_SWITCHES) return;
    const now = Date.now();
    const stopAt = stopTime(thread.usageLimitResetAt, thread.latestRunCompletedAt, now);
    if (now - stopAt > MAX_STOP_AGE_MS || belowWatermark(this.#state, stopAt)) return;
    const catalog = await this.#port.catalog();
    const target = equivalentTarget(thread.modelSelection, catalog.providers, this.#config);
    if (target === null) return;
    const intent: SwitchIntent = {
      threadId: thread.id, runId: thread.latestRunId!, resetAt: thread.usageLimitResetAt,
      from: thread.modelSelection, target, stopAt, createdAt: now, expiresAt: now + MAX_STOP_AGE_MS,
      restoreAutoResume: thread.limitRecovery?.runId === thread.latestRunId && thread.limitRecovery.resetAt === thread.usageLimitResetAt
        ? thread.limitRecovery.autoResume : catalog.autoResume,
      subagent: thread.relationshipToParent === "subagent", phase: "holding",
    };
    this.#state.switches.set(ids.key, intent);
    this.#persist();
    await this.#advance(intent);
  }
  async #advance(intent: SwitchIntent): Promise<void> {
    const ids = switchIds(intent.threadId, intent.runId);
    if (intent.phase === "holding") {
      const current = await this.#port.thread(intent.threadId);
      const catalog = await this.#port.catalog();
      const target = equivalentTarget(intent.from, catalog.providers, this.#config);
      if (Date.now() >= intent.expiresAt || !current || !switchable(current) ||
          current.latestRunId !== intent.runId || current.usageLimitResetAt !== intent.resetAt ||
          current.providerInstanceId !== intent.from.instanceId ||
          JSON.stringify(current.modelSelection) !== JSON.stringify(intent.from) || JSON.stringify(target) !== JSON.stringify(intent.target)) {
        intent.phase = "releasing"; this.#persist();
      } else {
        // A resetless stop cannot be armed by T3; the manual run guard still arbitrates a late reset.
        if (intent.resetAt !== null) {
          const held = await this.#port.recovery({ threadId: intent.threadId, runId: intent.runId,
            resetAt: intent.resetAt, commandId: ids.hold, autoResume: false });
          if (!held) { intent.phase = "releasing"; this.#persist(); }
        }
        if (intent.phase === "holding") {
          const held = await this.#port.thread(intent.threadId);
          if (!held || !switchable(held) || held.latestRunId !== intent.runId ||
              held.providerInstanceId !== intent.from.instanceId || JSON.stringify(held.modelSelection) !== JSON.stringify(intent.from) ||
              intent.resetAt !== null && held.limitRecovery?.requestId !== ids.hold) {
            intent.phase = "releasing";
          } else intent.phase = "dispatching";
          this.#persist();
        }
      }
    }
    if (intent.phase === "dispatching") {
      // An uncertain outcome MUST retry this exact payload, even after source state moved.
      // T3's durable command receipt returns the first result, or its run guard rejects it.
      const expired = Date.now() >= intent.expiresAt;
      const accepted = expired
        ? await this.#port.delivered(intent.threadId, ids.dispatch)
        : await this.#port.continue({ threadId: intent.threadId, runId: intent.runId,
          commandId: ids.dispatch, target: intent.target });
      if (accepted) {
        intent.phase = "switched";
        if (claim(this.#state, "provider_switched", intent.threadId, intent.runId, intent.stopAt, Date.now())) {
          this.#record({ kind: "provider_switched", severity: "info", threadId: intent.threadId,
            runId: intent.runId, provider: intent.from.instanceId, resetAt: intent.resetAt,
            fromProvider: intent.from.instanceId, fromModel: intent.from.model,
            toProvider: intent.target.instanceId, toModel: intent.target.model, subagent: intent.subagent });
        }
        this.#persist();
        return;
      }
      intent.phase = "releasing"; this.#persist();
    }
    if (intent.phase === "releasing") {
      const current = await this.#port.thread(intent.threadId);
      // Restore only our own hold. Never overwrite a later human/native recovery choice.
      if (intent.resetAt !== null && current?.limitRecovery?.requestId === ids.hold &&
          current.limitRecovery.runId === intent.runId && current.limitRecovery.resetAt === intent.resetAt) {
        if (current.latestRunId === intent.runId && (current.pendingRequest || current.settled || current.archived)) return;
        const released = await this.#port.recovery({ threadId: intent.threadId, runId: intent.runId,
          resetAt: intent.resetAt, commandId: `${ids.release}:${intent.releaseAttempt ?? 0}`, autoResume: intent.restoreAutoResume });
        // T3 caches rejections too. A later release needs a new ID; an uncertain
        // transport outcome retries the same saved attempt instead.
        if (!released && current.latestRunId === intent.runId) {
          intent.releaseAttempt = (intent.releaseAttempt ?? 0) + 1;
          this.#persist();
          return;
        }
      }
      intent.phase = "cancelled"; this.#persist();
    }
  }
}
