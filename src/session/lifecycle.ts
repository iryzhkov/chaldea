// Fixed-preset session lifecycle inside the wait service. The private same-UID
// socket is operator-context ingress; a caller threadId is only the wake
// destination and never proof of authority. This is shared-server accident
// prevention, not authenticated per-thread confinement.
import { randomUUID } from "node:crypto";
import { backoff } from "../retry.ts";
import type { WakeStore, Item, SessionRecord } from "../wake/store.ts";
import type { WaitT3, WaitSnapshot } from "../t3/waits.ts";
import { completion, LIVE } from "../waits/completion.ts";
import { validateAdmission, type RunAdmission } from "../access/run-lease.ts";
import { AUDIENCES, type Grant } from "../access/token.ts";
import { SessionRefusal, presetHash, type SessionPolicy } from "./policy.ts";
import { admit, destination, startInput, withinCeiling } from "./admit.ts";
import { checkResult } from "./result.ts";
import { launchPayload, type SessionT3 } from "./t3.ts";

export interface SessionOptions {
  /** Reads the protected policy; null when no presets are configured. May throw a SessionRefusal. */
  policy: () => SessionPolicy | null;
  t3?: SessionT3;
  /** Bounded wait for the first launch answer inside one start call. */
  launchWaitMs?: number;
}
export interface SessionHooks {
  poke(): void; fault(error: unknown): void;
  boundary?: ((name: string, item: string) => void) | undefined; report?: ((event: string) => void) | undefined;
}
export type IssueDecision =
  | { ok: true; sessionId: string; runId: string; threadId: string; profile: string; project: string; audience: string; grants: Grant[]; expiresAt: number }
  | { ok: false; refusal: string };
export interface SessionStatus {
  sessionId: string; requestId: string; preset: string; threadId: string; state: Item["state"]; disposition: string | null;
  launch: SessionRecord["launch"]; runId: string | null; deadline: string; outcome: unknown; result: string | null;
  resultState: string | null; resultBytes: number | null; occupancy: SessionRecord["occupancy"]; released: string | null;
  delivery: Array<{ channel: string; state: string; disposition: string | null; attempts: number }>;
}
const MAX_LINEAGE = 8;
export const RESULT_GRACE_MS = 10 * 60_000;
const AMBIGUOUS_READS = 3;
type Phase = "launch" | "read";
/** No run, queued request or native child of the thread can still act. */
function quiescent(s: WaitSnapshot): boolean {
  return s.runs.every(r => !LIVE.has(r.status)) && s.pendingRuns.length === 0 && s.children.every(c => !LIVE.has(c.status));
}
export class SessionLifecycle {
  private readonly store: WakeStore;
  private readonly waits: WaitT3;
  private readonly options: SessionOptions;
  private readonly hooks: SessionHooks;
  private launching = new Set<string>();
  private fetching = new Set<string>();
  private timers = new Set<NodeJS.Timeout>();
  /** Retry counts and backoff, keyed by phase and session so launch retries never spend result reads. */
  private attempts = new Map<string, number>();
  private notBefore = new Map<string, number>();
  /** Sessions whose root was seen completed before the deadline by this process. */
  private timely = new Set<string>();
  private stopped = false;
  constructor(store: WakeStore, waits: WaitT3, options: SessionOptions, hooks: SessionHooks) {
    this.store = store; this.waits = waits; this.options = options; this.hooks = hooks;
  }
  private policy(): SessionPolicy {
    const policy = this.options.policy();
    if (!policy) throw new SessionRefusal("sessions_disabled", "no fixed session presets are configured on this host");
    return policy;
  }
  /** Admit the whole preset, commit every identity, then launch once. Refusals happen before any launch. */
  async start(value: unknown): Promise<SessionStatus> {
    const now = Date.now();
    const policy = this.policy();
    const { input, requestAt, hash } = startInput(value, now);
    const existing = this.store.sessionRequest(input.requestId, hash);
    if (existing) return this.status(existing.id);
    const id = randomUUID();
    const { preset, hash: digest, admission } = admit(policy, input.preset, id, now);
    if (!this.options.t3) throw new SessionRefusal("sessions_unavailable", "no T3 launch seam");
    if (this.store.presetHeld(preset.id)) throw new SessionRefusal("preset_busy", "the preset's previous session has not been observed to stop");
    await this.waits.environment();
    const caller = await this.waits.snapshot(input.threadId);
    if (!caller || caller.deleted || caller.archived || caller.settled)
      throw new SessionRefusal("caller_inactive", "caller thread is absent, archived or settled on this T3");
    await this.delegating(caller);
    destination(preset, caller.project);
    const threadId = randomUUID(), launch = launchPayload(id, threadId, preset);
    const row = this.store.registerSession({
      id, requestId: input.requestId, requestAt, hash, input, parent: input.threadId, project: caller.project,
      deadline: admission.expiresAt * 1000, preset: preset.id, presetHash: digest, admission: JSON.stringify(admission),
      threadId, commandId: launch.commandId, messageId: launch.messageId, t3Project: preset.projectId, payload: launch.payload,
    }, now);
    if (row.id === id) {
      this.hooks.boundary?.("session_committed", id);
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([this.launch(id), new Promise<void>(r => { timer = setTimeout(r, this.options.launchWaitMs ?? 5000); })]);
      clearTimeout(timer);
    }
    this.hooks.poke();
    return this.status(row.id);
  }
  /** Known limited sessions and their descendants are nondelegating, whatever thread they claim. */
  private async delegating(caller: WaitSnapshot): Promise<void> {
    const known = this.store.sessionThreads(), seen = new Set<string>();
    let current: WaitSnapshot | null = caller;
    for (let depth = 0; current; depth++) {
      if (known.has(current.id) || (current.lineage && known.has(current.lineage.root)))
        throw new SessionRefusal("caller_not_delegating", "a limited session thread or its descendant cannot start sessions");
      const parent: string | null | undefined = current.lineage?.parent;
      if (!parent) return;
      if (depth >= MAX_LINEAGE || seen.has(parent)) throw new SessionRefusal("caller_lineage_unbounded");
      seen.add(current.id);
      current = await this.waits.snapshot(parent);
    }
  }
  private later(phase: Phase, id: string): void {
    const k = phase + ":" + id, n = this.attempts.get(k) ?? 0, delay = backoff(n);
    this.attempts.set(k, n + 1); this.notBefore.set(k, Date.now() + delay);
    const timer = setTimeout(() => { this.timers.delete(timer); if (!this.stopped) this.hooks.poke(); }, delay);
    this.timers.add(timer);
  }
  /** One dispatch per committed intent. A thrown or lost answer becomes uncertain and is never resent. */
  private async launch(id: string): Promise<void> {
    const t3 = this.options.t3;
    if (!t3 || this.stopped || this.launching.has(id)) return;
    this.launching.add(id);
    try {
      const s = this.store.session(id), item = this.store.get(id);
      if (s.launch !== "intent" || item.state !== "parked" || Date.now() >= item.deadline) return;
      if (!this.store.sessionLaunch(id, ["intent"], "dispatching")) return;
      let result: Awaited<ReturnType<SessionT3["launch"]>>;
      try { result = await t3.launch(s.payload); }
      catch {
        if (this.stopped) return;
        this.store.sessionLaunch(id, ["dispatching"], "uncertain", "dispatch_outcome_unknown");
        this.hooks.report?.("session_launch_uncertain"); return;
      }
      if (this.stopped) return;
      if (result.kind === "not_sent") {
        if (this.store.sessionLaunch(id, ["dispatching"], "intent", result.detail)) this.later("launch", id);
        return;
      }
      if (result.kind === "rejected") {
        // The slot stays held until T3 verifies the thread absent or stopped.
        if (this.store.sessionLaunch(id, ["dispatching"], "rejected", result.detail))
          this.store.finishSession(id, { reason: "launch_rejected", detail: result.detail });
        return;
      }
      if (result.threadId !== s.thread_id) {
        if (this.store.sessionLaunch(id, ["dispatching"], "mismatch", "returned " + result.threadId.slice(0, 128)))
          this.store.finishSession(id, { reason: "launch_identity_mismatch" });
        return;
      }
      this.store.sessionLaunch(id, ["dispatching", "uncertain"], "accepted", result.resumed ? "resumed" : null);
    } catch (error) { if (!this.stopped) this.hooks.fault(error); }
    finally { this.launching.delete(id); if (!this.stopped) this.hooks.poke(); }
  }
  /** Threads the engine must observe: every session still active or holding its slot. */
  observed(): string[] {
    return this.store.liveSessions().filter(s => s.launch !== "intent").map(s => s.thread_id);
  }
  /** Event driven from the engine pump; synchronous so storage faults reach its handler. */
  reconcileAll(now: number, snapshotOf: (threadId: string) => WaitSnapshot | null | undefined): void {
    for (const s of this.store.liveSessions()) this.reconcile(s, now, snapshotOf(s.thread_id));
  }
  private reconcile(s: SessionRecord, now: number, snapshot: WaitSnapshot | null | undefined): void {
    const id = s.item, item = this.store.get(id), active = item.state === "parked", overdue = active && now >= item.deadline;
    if (s.launch === "intent") {
      // Nothing was sent, so no runtime can exist for this session.
      if (!active || overdue) {
        if (overdue) this.store.finishSession(id, { reason: "deadline" }, null, now);
        this.store.releaseSession(id, "never_launched", now);
      } else if ((this.notBefore.get("launch:" + id) ?? 0) <= now) void this.launch(id);
      return;
    }
    if (s.launch === "dispatching" && this.launching.has(id)) {
      if (overdue) this.store.finishSession(id, { reason: "launch_uncertain" }, null, now);
      return;
    }
    let launch = s.launch;
    // Dispatching without a live attempt means a restart or lost answer: never resend.
    if (launch === "dispatching" && this.store.sessionLaunch(id, ["dispatching"], "uncertain", "restart_during_dispatch")) launch = "uncertain";
    const gone = snapshot === null || snapshot?.deleted === true;
    const present = snapshot !== undefined && !gone && snapshot !== null;
    if (present && snapshot.project !== s.t3_project) {
      if (overdue) this.store.finishSession(id, { reason: launch === "accepted" ? "deadline" : "launch_uncertain" }, null, now);
      return; // Not this preset's thread: never evidence that it stopped.
    }
    if (launch === "mismatch") return; // Quarantined until an operator repairs it.
    if (launch === "rejected") {
      if (gone) this.store.releaseSession(id, "launch_rejected", now);
      return;
    }
    if (launch === "uncertain") {
      if (present && this.store.sessionLaunch(id, ["uncertain"], "accepted", "observed")) launch = "accepted";
      else {
        // A delayed launch could still create the thread, so absence never releases the slot.
        if (overdue) this.store.finishSession(id, { reason: "launch_uncertain" }, null, now);
        return;
      }
    }
    if (snapshot === undefined) { if (overdue) this.store.finishSession(id, { reason: "deadline" }, null, now); return; }
    if (snapshot === null || snapshot.deleted) {
      if (active) this.store.finishSession(id, { reason: "thread_deleted" }, null, now);
      this.store.releaseSession(id, "thread_deleted", now); return;
    }
    const root = s.root_run ?? snapshot.runs.find(r => r.message === s.message_id)?.id ?? null;
    if (root && !s.root_run) this.store.sessionRoot(id, root);
    const done = root ? completion(snapshot, root) : null;
    if (active) {
      const completed = done?.reason === "completed" && done.runId ? done.runId : null;
      // T3 gives no completion time, so a root first seen finished after the deadline
      // (for example after service downtime) counts as overdue and yields no result.
      if (completed && !overdue) this.timely.add(id);
      if (overdue && !this.timely.has(id)) this.store.finishSession(id, { reason: "deadline" }, null, now);
      else if (completed) {
        // A timely completion may finish its result read within a bounded grace, never indefinitely.
        if (now >= item.deadline + RESULT_GRACE_MS) this.store.finishSession(id, { reason: "result_unavailable", runId: completed, detail: "grace_expired" }, null, now);
        else void this.capture(s, completed, item);
      } else if (done) this.store.finishSession(id, { reason: done.reason, ...(done.runId ? { runId: done.runId } : {}) }, null, now);
    }
    // Only runtime evidence frees the preset: the root cohort ended and nothing else in the thread runs.
    if (done && quiescent(snapshot)) this.store.releaseSession(id, "runtime_stopped", now);
  }
  private async capture(s: SessionRecord, runId: string, item: Item): Promise<void> {
    const id = s.item, t3 = this.options.t3;
    if (this.fetching.has(id) || (this.notBefore.get("read:" + id) ?? 0) > Date.now()) return;
    if (!t3) { this.store.finishSession(id, { reason: "result_unavailable", runId, detail: "no_t3" }); return; }
    this.fetching.add(id);
    try {
      let read: Awaited<ReturnType<SessionT3["result"]>>;
      try { read = await t3.result(s.thread_id, runId); }
      catch {
        if (this.stopped) return;
        if (Date.now() >= item.deadline + RESULT_GRACE_MS) this.store.finishSession(id, { reason: "result_unavailable", runId, detail: "read_failed" });
        else { this.hooks.report?.("session_result_retry"); this.later("read", id); }
        return;
      }
      if (this.stopped) return;
      if (read.kind === "ambiguous" && (this.attempts.get("read:" + id) ?? 0) < AMBIGUOUS_READS) { this.later("read", id); return; }
      if (read.kind === "missing") this.store.finishSession(id, { reason: "result_unavailable", runId });
      else if (read.kind === "ambiguous") this.store.finishSession(id, { reason: "result_ambiguous", runId, detail: read.detail });
      else {
        const c = checkResult(read.text);
        if (c.state === "stored") this.store.finishSession(id, { reason: "succeeded", runId, bytes: c.bytes }, c.text);
        else this.store.finishSession(id, { reason: c.state, runId, bytes: c.bytes });
      }
    } catch (error) { if (!this.stopped) this.hooks.fault(error); }
    finally { this.fetching.delete(id); if (!this.stopped) this.hooks.poke(); }
  }
  /** Logical cancellation stops issuance and wakes the caller. It does not interrupt T3 or free the slot. */
  cancel(id: string): SessionStatus {
    if (this.store.get(id).kind !== "session") throw new Error("Not a session");
    this.store.finishSession(id, { reason: "operator_cancelled" });
    return this.status(id);
  }
  /** Explicit reconciliation: a fresh T3 read under the same evidence rules, never a blind release. */
  async reconcileNow(id: string): Promise<SessionStatus> {
    const s = this.store.session(id);
    await this.waits.environment();
    this.reconcile(s, Date.now(), await this.waits.snapshot(s.thread_id));
    return this.status(id);
  }
  /**
   * Internal issuance gate for a future preset-bound credential helper. Nothing
   * calls it in production yet; it returns grants and expiry, never a token.
   */
  authorizeIssue(presetId: string, audience: string, now = Date.now()): IssueDecision {
    const refuse = (refusal: string): IssueDecision => ({ ok: false, refusal });
    let policy: SessionPolicy | null;
    try { policy = this.options.policy(); } catch { return refuse("session_policy_unavailable"); }
    if (!policy) return refuse("sessions_disabled");
    if (!(AUDIENCES as readonly string[]).includes(audience)) return refuse("invalid_audience");
    const s = this.store.presetHeld(presetId);
    if (!s) return refuse("no_active_run");
    const item = this.store.get(s.item);
    if (item.state !== "parked") return refuse("run_inactive");
    if (now >= item.deadline) return refuse("run_expired");
    if (!["dispatching", "uncertain", "accepted"].includes(s.launch)) return refuse("run_not_launched");
    const current = Object.hasOwn(policy.presets, presetId) ? policy.presets[presetId] : undefined;
    if (!current) return refuse("preset_removed");
    if (presetHash(current) !== s.preset_hash) return refuse("preset_changed");
    const admission = JSON.parse(s.admission) as RunAdmission;
    try { validateAdmission(admission, Math.floor(now / 1000)); } catch { return refuse("run_expired"); }
    // The unchanged preset must still fit a current ceiling; unrelated policy edits do not matter.
    if (!withinCeiling(policy, current, admission)) return refuse("preset_exceeds_ceiling");
    const service = admission.services.find(x => x.audience === audience);
    if (!service) return refuse("audience_not_admitted");
    return { ok: true, sessionId: s.item, runId: admission.runId, threadId: s.thread_id, profile: admission.profile,
      project: admission.project, audience, grants: structuredClone(service.grants), expiresAt: admission.expiresAt };
  }
  status(id: string): SessionStatus {
    const item = this.store.get(id);
    if (item.kind !== "session") throw new Error("Not a session");
    const s = this.store.session(id);
    return {
      sessionId: id, requestId: item.request_key, preset: s.preset, threadId: s.thread_id, state: item.state, disposition: item.disposition,
      launch: s.launch, runId: s.root_run, deadline: new Date(item.deadline).toISOString(), outcome: item.outcome ? JSON.parse(item.outcome) : null,
      result: s.result, resultState: s.result_state, resultBytes: s.result_bytes, occupancy: s.occupancy, released: s.released,
      delivery: this.store.deliveries().filter(d => d.item === id).map(d => ({ channel: d.channel, state: d.state, disposition: d.disposition, attempts: d.attempts })),
    };
  }
  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
