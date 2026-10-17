// Durable provider-switch intents; observation is independent of this optional path.
import { createHash } from "node:crypto";
import { AuthenticationError, TransientConnectionError, type ModelChoice, type ShellEvent, type ShellThread, type SwitchPort } from "../t3/adapter.ts";
import type { Logger } from "../log.ts";
import { claim, stopTime, type QuotaRecord } from "./observer.ts";
import { equivalentTarget, type SwitchConfig } from "./routing.ts";
import { belowWatermark, MAX_ACTIVE_SWITCHES, type ObserverState } from "./state.ts";
export { MAX_ACTIVE_SWITCHES, MAX_COMPLETED_SWITCHES } from "./state.ts";

export const HOLD_GRACE_MS = 2 * 60_000;
export const RESETLESS_BOUND_MS = 2 * 60_000;
const RELEASE_RETRY_MS = 5_000;
export const SWITCH_RETRY_MIN_MS = 1_000;
export const SWITCH_RETRY_MAX_MS = 60_000;
export interface SwitchIntent {
  readonly threadId: string;
  readonly runId: string;
  readonly resetAt: string | null;
  readonly from: ModelChoice;
  readonly target: ModelChoice;
  readonly stopAt: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** null means no reliable previous choice: release to the live global setting. */
  readonly restoreAutoResume: boolean | null;
  readonly snooze?: boolean;
  readonly subagent: boolean;
  releaseAttempt?: number;
  /** A timed-out dispatch may commit after cleanup; reconcile its eventual receipt. */
  dispatchUncertain?: boolean;
  phase: "holding" | "dispatching" | "releasing" | "switched" | "cancelled";
}
export function switchIds(threadId: string, runId: string) {
  const key = createHash("sha256").update(JSON.stringify([threadId, runId])).digest("hex");
  const prefix = `chaldea-switch:${key}`;
  return { key, hold: `${prefix}:hold`, dispatch: `${prefix}:continue`, release: `${prefix}:release` };
}
export function activeIntent(intent: SwitchIntent): boolean {
  return intent.phase !== "switched" && intent.phase !== "cancelled";
}
export function holdDeadline(intent: Pick<SwitchIntent, "createdAt" | "resetAt" | "expiresAt">): number {
  const reset = intent.resetAt === null ? NaN : Date.parse(intent.resetAt);
  return Math.min(intent.expiresAt, Number.isFinite(reset) ? reset + HOLD_GRACE_MS : intent.createdAt + RESETLESS_BOUND_MS);
}
export function switchable(thread: ShellThread): boolean {
  return thread.status === "failed" && thread.lastErrorClass === "usage_limit" &&
    thread.latestRunId !== null && thread.activeRunId === null &&
    !thread.deleted && !thread.archived && !thread.settled && !thread.pendingRequest;
}
function ownsHold(thread: ShellThread, intent: Pick<SwitchIntent, "threadId" | "runId" | "resetAt">): boolean {
  const recovery = thread.limitRecovery;
  return recovery?.runId === intent.runId && recovery.resetAt === intent.resetAt &&
    recovery.requestId === switchIds(intent.threadId, intent.runId).hold;
}
function optedOut(thread: ShellThread): boolean {
  const recovery = thread.limitRecovery;
  return recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt &&
    !recovery.autoResume &&
    !(recovery.snooze === true && recovery.requestId === `limit-arm:${thread.id}:${recovery.runId}:${Date.parse(recovery.resetAt)}`) &&
    !ownsHold(thread, { threadId: thread.id, runId: recovery.runId, resetAt: recovery.resetAt });
}

export class ProviderSwitcher {
  readonly #state: ObserverState;
  readonly #save: () => boolean;
  readonly #record: (record: QuotaRecord) => void;
  readonly #logger: Logger;
  readonly #config: SwitchConfig;
  readonly #now: () => number;
  readonly #onReconciled: ((thread: ShellThread) => void) | undefined;
  readonly #startedAt: number;
  #port: SwitchPort;
  #disabled = false;
  #synced = false;
  #closed = false;
  #capLogged = false;
  #failureLogged = false;
  #enableAt = Infinity;
  #enableDelay = SWITCH_RETRY_MIN_MS;
  #cleanupDone = false;
  readonly #cancelled = new Map<SwitchIntent, ShellThread>();
  #work: Promise<void> | null = null;
  #requested = false;
  #timer: NodeJS.Timeout | null = null;
  #retryAt = Infinity;
  #catalog: ReturnType<SwitchPort["catalog"]> | undefined;
  readonly #stops = new Map<string, { thread: ShellThread; live: boolean }>();

  constructor(options: { state: ObserverState; config: SwitchConfig; port: SwitchPort;
    save: () => boolean; record: (record: QuotaRecord) => void; logger: Logger; now?: () => number; onReconciled?: (thread: ShellThread) => void }) {
    this.#state = options.state; this.#config = options.config; this.#port = options.port;
    this.#save = options.save; this.#record = options.record; this.#logger = options.logger;
    this.#onReconciled = options.onReconciled;
    this.#now = options.now ?? Date.now; this.#startedAt = this.#now();
  }
  reconnect(port: SwitchPort, credentialChanged: boolean): void {
    this.#port = port; this.#synced = false; this.#stops.clear(); this.#catalog = undefined;
    if (credentialChanged) {
      this.#disabled = false; this.#failureLogged = false;
      this.#enableAt = Infinity; this.#enableDelay = SWITCH_RETRY_MIN_MS;
    }
  }
  #persist(): void {
    if (!this.#save()) throw new Error("switch intent is not durable");
  }
  #getCatalog(): ReturnType<SwitchPort["catalog"]> {
    return this.#catalog ??= this.#port.catalog();
  }
  #blocking(thread: ShellThread, live = false, intent?: SwitchIntent): boolean {
    if (!switchable(thread) || optedOut(thread)) return false;
    const now = this.#now();
    if (thread.usageLimitResetAt !== null) return Date.parse(thread.usageLimitResetAt) > now;
    const completed = Date.parse(thread.latestRunCompletedAt ?? "");
    return Number.isFinite(completed) && completed <= now && now - completed < RESETLESS_BOUND_MS &&
      (live || completed >= this.#startedAt || intent !== undefined && now < intent.createdAt + RESETLESS_BOUND_MS);
  }
  /** Bounded coalescing: the shell caller never waits for optional network work. */
  handle(event: ShellEvent): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (event.kind === "snapshot" || event.kind === "thread") {
      const threads = event.kind === "snapshot" ? event.threads : [event.thread];
      const changed = new Map(threads.map((thread) => [thread.id, thread]));
      for (const intent of this.#state.switches.values()) {
        const thread = changed.get(intent.threadId);
        if (intent.phase === "cancelled" && thread && (this.#cancelled.size < 1_000 || this.#cancelled.has(intent))) {
          this.#cancelled.set(intent, thread);
        }
      }
      for (const thread of event.kind === "snapshot" ? event.threads : [event.thread]) {
        if (switchable(thread)) {
          if (this.#stops.size < 1_000 || this.#stops.has(thread.id)) {
            const previous = this.#stops.get(thread.id);
            this.#stops.set(thread.id, { thread, live: event.kind === "thread" && this.#synced ||
              previous?.thread.latestRunId === thread.latestRunId && previous.live === true });
          }
        } else this.#stops.delete(thread.id);
      }
    } else if (event.kind === "removed") this.#stops.delete(event.threadId);
    if (event.kind === "synchronized") this.#synced = true;
    if (!this.#synced) return Promise.resolve();
    return this.#kick();
  }
  #kick(): Promise<void> {
    this.#requested = true;
    if (this.#work === null) {
      this.#work = this.#drain().finally(() => {
        this.#work = null;
        if (this.#requested && !this.#closed) void this.#kick();
        else this.#schedule();
      });
    }
    return this.#work;
  }
  async #drain(): Promise<void> {
    while (this.#requested && !this.#closed) {
      this.#requested = false; this.#catalog = undefined; this.#retryAt = Infinity; this.#cleanupDone = false;
      try {
        // Deadlines/cleanup always precede new admissions, even in observe-only mode.
        for (const intent of this.#state.switches.values()) {
          if (!activeIntent(intent)) continue;
          try { await this.#advance(intent); }
          catch (error) { await this.#degrade(error, intent); break; }
        }
        for (const [intent, thread] of this.#cancelled) {
          this.#cancelled.delete(intent);
          try {
            if (await this.#port.delivered(intent.threadId, switchIds(intent.threadId, intent.runId).dispatch)) {
              this.#switched(intent);
            } else if (intent.dispatchUncertain && thread.latestRunId !== intent.runId) {
              delete intent.dispatchUncertain; this.#persist();
              this.#onReconciled?.(thread);
            }
          } catch (error) {
            if (!this.#cancelled.has(intent)) this.#cancelled.set(intent, thread);
            throw error;
          }
        }
        if (this.#disabled && this.#now() >= this.#enableAt) {
          await this.#getCatalog();
          this.#disabled = false; this.#enableAt = Infinity; this.#enableDelay = SWITCH_RETRY_MIN_MS;
          this.#logger.info("provider switching re-enabled after transient failure");
        }
        if (!this.#disabled && this.#config.enabled) {
          for (const stop of this.#stops.values()) {
            if (this.#disabled) break;
            try { await this.#admit(stop.thread, stop.live); }
            catch (error) {
              if (claim(this.#state, "provider_switch_failed", stop.thread.id, stop.thread.latestRunId!,
                  stopTime(stop.thread.usageLimitResetAt, stop.thread.latestRunCompletedAt, this.#now()), this.#now())) {
                this.#record({ kind: "provider_switch_failed", severity: "warn", threadId: stop.thread.id,
                  runId: stop.thread.latestRunId!, provider: stop.thread.providerInstanceId,
                  resetAt: stop.thread.usageLimitResetAt, subagent: stop.thread.relationshipToParent === "subagent",
                  reason: error instanceof AuthenticationError ? "scope_missing" : "switch_error" });
              }
              await this.#degrade(error);
            }
          }
        }
      } catch (error) { await this.#degrade(error); }
    }
  }
  #warning(intent: SwitchIntent, reason: string): void {
    if (claim(this.#state, "provider_switch_failed", intent.threadId, intent.runId, intent.stopAt, this.#now())) {
      this.#record({ kind: "provider_switch_failed", severity: "warn", threadId: intent.threadId,
        runId: intent.runId, provider: intent.from.instanceId, resetAt: intent.resetAt,
        subagent: intent.subagent, reason });
    }
  }
  async #degrade(error: unknown, failed?: SwitchIntent): Promise<void> {
    this.#disabled = true;
    this.#enableAt = error instanceof TransientConnectionError ? this.#now() + this.#enableDelay : Infinity;
    if (Number.isFinite(this.#enableAt)) this.#enableDelay = Math.min(this.#enableDelay * 2, SWITCH_RETRY_MAX_MS);
    const reason = error instanceof AuthenticationError ? "scope_missing" : "switch_error";
    if (!this.#failureLogged) {
      this.#failureLogged = true;
      this.#logger.error(reason === "scope_missing"
        ? "provider switching disabled: token needs orchestration:operate; observing continues"
        : "provider switching failed; releasing holds and observing only");
    }
    if (this.#cleanupDone) return;
    this.#cleanupDone = true;
    for (const intent of this.#state.switches.values()) {
      if (!activeIntent(intent)) continue;
      this.#warning(intent, reason);
      // Do not send any new continuations after a switch-path error.
      const dispatching = intent.phase === "dispatching";
      const releasing = intent.phase === "releasing";
      intent.phase = "releasing";
      try {
        this.#persist();
        // A dispatch failure must pass through advance's receipt check first.
        // The failing intent was already attempted in this drain.
        if (dispatching || intent === failed && releasing) this.#retryAt = this.#now() + RELEASE_RETRY_MS;
        else await this.#advance(intent);
      } catch { this.#retryAt = this.#now() + RELEASE_RETRY_MS; }
    }
    if (failed && activeIntent(failed)) this.#retryAt = this.#now() + RELEASE_RETRY_MS;
    // A warning still gets its usual durable claim before the feed attempt.
    this.#save();
  }
  async #admit(thread: ShellThread, live: boolean): Promise<void> {
    if (!this.#blocking(thread, live) || !thread.modelSelection) return;
    const ids = switchIds(thread.id, thread.latestRunId!);
    if (this.#state.switches.has(ids.key)) return;
    if ([...this.#state.switches.values()].filter(activeIntent).length >= MAX_ACTIVE_SWITCHES) {
      if (!this.#capLogged) { this.#capLogged = true; this.#logger.warn("provider switch intent cap reached; leaving new stops on native recovery"); }
      return;
    }
    this.#capLogged = false;
    const now = this.#now();
    const stopAt = stopTime(thread.usageLimitResetAt, thread.latestRunCompletedAt, now);
    if (belowWatermark(this.#state, stopAt)) return;
    const catalog = await this.#getCatalog();
    const target = equivalentTarget(thread.modelSelection, catalog.providers, this.#config, this.#now());
    if (target === null) return;
    const recovery = thread.limitRecovery;
    const intent: SwitchIntent = {
      threadId: thread.id, runId: thread.latestRunId!, resetAt: thread.usageLimitResetAt,
      from: thread.modelSelection, target, stopAt, createdAt: now,
      expiresAt: thread.usageLimitResetAt === null ? now + RESETLESS_BOUND_MS : Date.parse(thread.usageLimitResetAt) + HOLD_GRACE_MS,
      restoreAutoResume: ownsHold(thread, { threadId: thread.id, runId: thread.latestRunId!, resetAt: thread.usageLimitResetAt })
        ? null : recovery?.runId === thread.latestRunId && recovery.resetAt === thread.usageLimitResetAt ? recovery.autoResume : null,
      ...(recovery?.snooze === undefined ? {} : { snooze: recovery.snooze }),
      subagent: thread.relationshipToParent === "subagent", phase: "holding",
    };
    this.#state.switches.set(ids.key, intent);
    this.#persist();
    await this.#advance(intent);
  }
  async #preflight(intent: SwitchIntent): Promise<ShellThread | undefined> {
    const current = await this.#port.thread(intent.threadId);
    if (!current || !this.#blocking(current, false, intent) ||
        current.latestRunId !== intent.runId || current.usageLimitResetAt !== intent.resetAt ||
        current.providerInstanceId !== intent.from.instanceId ||
        JSON.stringify(current.modelSelection) !== JSON.stringify(intent.from)) return undefined;
    const catalog = await this.#getCatalog();
    if (!this.#blocking(current, false, intent) || this.#now() >= holdDeadline(intent)) return undefined;
    return JSON.stringify(equivalentTarget(intent.from, catalog.providers, this.#config, this.#now())) === JSON.stringify(intent.target)
      ? current : undefined;
  }
  #switched(intent: SwitchIntent): void {
    intent.phase = "switched"; delete intent.dispatchUncertain;
    if (claim(this.#state, "provider_switched", intent.threadId, intent.runId, intent.stopAt, this.#now())) {
      this.#record({ kind: "provider_switched", severity: "info", threadId: intent.threadId,
        runId: intent.runId, provider: intent.from.instanceId, resetAt: intent.resetAt,
        fromProvider: intent.from.instanceId, fromModel: intent.from.model,
        toProvider: intent.target.instanceId, toModel: intent.target.model, subagent: intent.subagent });
    }
    this.#persist();
  }
  async #advance(intent: SwitchIntent): Promise<void> {
    const ids = switchIds(intent.threadId, intent.runId);
    // A dispatched request may already have committed, including after a lost response.
    if ((intent.phase === "dispatching" || intent.phase === "releasing") && await this.#port.delivered(intent.threadId, ids.dispatch)) {
      this.#switched(intent); return;
    }
    if (this.#disabled || this.#now() >= holdDeadline(intent)) {
      if (this.#now() >= holdDeadline(intent)) this.#warning(intent, "hold_expired");
      intent.phase = "releasing"; this.#persist();
    }
    if (intent.phase === "holding") {
      const current = await this.#preflight(intent);
      if (!current) { intent.phase = "releasing"; this.#persist(); }
      else {
        if (intent.resetAt !== null) {
          const held = await this.#port.recovery({ threadId: intent.threadId, runId: intent.runId,
            resetAt: intent.resetAt, commandId: ids.hold, autoResume: false,
            snooze: intent.snooze ?? current.limitRecovery?.snooze ?? false });
          if (!held) { intent.phase = "releasing"; this.#persist(); }
        }
        if (intent.phase === "holding") { intent.phase = "dispatching"; this.#persist(); }
      }
    }
    if (intent.phase === "dispatching") {
      // Re-entering dispatching is conditional: a receipt wins; otherwise human state wins.
      const current = await this.#preflight(intent);
      if (!current || intent.resetAt !== null && !ownsHold(current, intent)) {
        intent.phase = "releasing"; this.#persist();
      } else {
        // Persist uncertainty before the send, including a crash before its response.
        intent.dispatchUncertain = true; this.#persist();
        let accepted: boolean;
        try {
          accepted = await this.#port.continue({ threadId: intent.threadId, runId: intent.runId,
            commandId: ids.dispatch, target: intent.target });
        } catch (error) {
          // Resolve an ambiguous send before releasing native recovery.
          if (await this.#port.delivered(intent.threadId, ids.dispatch).catch(() => false)) {
            this.#switched(intent); return;
          }
          throw error;
        }
        if (accepted) { this.#switched(intent); return; }
        delete intent.dispatchUncertain;
        intent.phase = "releasing"; this.#persist();
      }
    }
    if (intent.phase === "releasing") await this.#release(intent);
  }
  async #release(intent: SwitchIntent): Promise<void> {
    const current = await this.#port.thread(intent.threadId);
    if (intent.resetAt !== null && current && ownsHold(current, intent) && current.latestRunId === intent.runId) {
      const ids = switchIds(intent.threadId, intent.runId);
      const expired = this.#now() >= holdDeadline(intent);
      if (!expired && (current.archived || current.settled || current.pendingRequest)) return;
      // Metadata updates have no ownership guard in pinned T3. Re-read immediately
      // before every write, including a clear after a rejected restore.
      const freshHold = async () => {
        const fresh = await this.#port.thread(intent.threadId);
        return fresh && fresh.latestRunId === intent.runId && ownsHold(fresh, intent) ? fresh : undefined;
      };
      const clear = async () => {
        if (!await freshHold()) return true;
        return this.#port.clearRecovery(intent.threadId, `${ids.release}:clear:${intent.releaseAttempt ?? 0}`);
      };
      let released = false;
      if (expired && (intent.restoreAutoResume === null || current.archived || current.settled || current.pendingRequest ||
          current.usageLimitResetAt !== intent.resetAt)) {
        released = await clear();
      } else if (!current.archived && !current.settled && !current.pendingRequest) {
        const restore = intent.restoreAutoResume ?? (await this.#getCatalog()).autoResume;
        const fresh = await freshHold();
        if (!fresh) released = true;
        else if (!fresh.archived && !fresh.settled && !fresh.pendingRequest) {
          released = await this.#port.recovery({ threadId: intent.threadId, runId: intent.runId,
            resetAt: intent.resetAt, commandId: `${ids.release}:${intent.releaseAttempt ?? 0}`,
            autoResume: restore,
            // Omitting an expired true snooze preserves it without tripping T3's
            // "cannot snooze in the past" guard.
            ...((intent.snooze ?? fresh.limitRecovery?.snooze) && Date.parse(intent.resetAt) <= this.#now()
              ? {} : { snooze: intent.snooze ?? fresh.limitRecovery?.snooze ?? false }) });
          if (!released && expired) released = await clear();
        } else if (expired) released = await clear();
      }
      if (!released) {
        intent.releaseAttempt = (intent.releaseAttempt ?? 0) + 1;
        this.#persist(); this.#retryAt = this.#now() + RELEASE_RETRY_MS; return;
      }
    }
    intent.phase = "cancelled"; this.#persist();
    if (current) this.#onReconciled?.(current);
  }
  #schedule(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    if (this.#closed || !this.#synced) return;
    const now = this.#now();
    let next = Math.min(this.#retryAt, this.#enableAt);
    if (this.#cancelled.size > 0) next = Math.min(next, now + RELEASE_RETRY_MS);
    for (const intent of this.#state.switches.values()) {
      if (!activeIntent(intent)) continue;
      const deadline = holdDeadline(intent), reset = Date.parse(intent.resetAt ?? "");
      if (deadline > now) next = Math.min(next, deadline);
      else next = Math.min(next, now + RELEASE_RETRY_MS);
      if (reset > now) next = Math.min(next, reset);
    }
    if (Number.isFinite(next)) {
      this.#timer = setTimeout(() => { this.#timer = null; void this.#kick(); }, Math.max(1, Math.min(next - now, 2_147_483_647)));
      this.#timer.unref();
    }
  }
  /** Final containment boundary for an unexpected worker/callback failure. */
  async fail(error: unknown): Promise<void> {
    if (this.#work === null) this.#cleanupDone = false;
    try { await this.#degrade(error); } finally { this.#schedule(); }
  }
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#work;
  }
}
