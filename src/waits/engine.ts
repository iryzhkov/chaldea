import { WakeStore, type Item, type Registration, type Delivery } from "../wake/store.ts";
import type { WaitT3, WaitSnapshot } from "../t3/waits.ts";
import { completion } from "./completion.ts";
import { Deadlines } from "./deadlines.ts";
import type { WaitInput, DecisionInput } from "./types.ts";

export interface EngineOptions {
  answerBaseUrl: string;
  notify?: (payload: string) => Promise<void>;
  // Test seam for abrupt process termination at durable/ambiguous boundaries.
  boundary?: (name: string, item: string) => void;
  report?: (event: string) => void;
}
export class WaitEngine {
  readonly store: WakeStore;
  readonly t3: WaitT3;
  private options: EngineOptions;
  private clock = new Deadlines();
  private snapshots = new Map<string,WaitSnapshot|null>();
  private observers = new Map<string,{abort:AbortController; retry?:NodeJS.Timeout}>();
  private inflight = new Set<string>();
  private stopped = false;
  private pumping = false;
  private fatal = false;
  constructor(store: WakeStore, t3: WaitT3, options: EngineOptions) { this.store=store; this.t3=t3; this.options=options; }
  start(): void { this.poke(); }
  async register(kind: "wait" | "decision", value: unknown): Promise<Item> {
    if (this.fatal) throw new Error("Watcher needs attention");
    const reg = this.store.prepare(kind,value);
    const existing = this.store.existing(reg); if (existing) return existing;
    await this.t3.environment();
    const parent = await this.t3.snapshot(reg.input.threadId);
    if (!parent || parent.deleted || parent.archived || parent.settled) throw new Error("Caller thread is absent, archived or settled on this T3");
    let pinned: string|null=null;
    if ("condition" in reg.input && reg.input.condition.kind === "thread") {
      const target = await this.t3.snapshot(reg.input.condition.threadId);
      if (!target || target.deleted) throw new Error("Target thread does not exist on this T3");
      pinned = reg.input.condition.runId ?? target.runs.toSorted((a,b) => b.ordinal-a.ordinal)[0]?.id ?? null;
      if (!pinned || !target.runs.some(r => r.id === pinned)) throw new Error("Target has no accepted run to pin");
    }
    const row = this.store.register(reg,parent.project,pinned,kind === "decision" ? this.phone(reg) : undefined);
    this.options.boundary?.("registered",row.id);
    this.poke();
    return row;
  }
  private phone(reg: Registration): string {
    const q = reg.input as DecisionInput;
    return JSON.stringify({id:"chaldea-decision:" + this.store.environment + ":" + reg.id,
      title:"Chaldea decision",content:q.question + "\nDefault (" + q.defaultAction + "): " + q.default + "\nDeadline: " + q.deadline,
      priority:"default",url:new URL("/decisions/" + reg.id,this.options.answerBaseUrl).toString()});
  }
  answer(id: string, answer: string): Item {
    const row=this.store.answer(id,answer); this.options.boundary?.("resolved",id); this.poke(); return row;
  }
  cancel(id: string): ReturnType<WakeStore["cancel"]> { const result=this.store.cancel(id); this.poke(); return result; }
  private watch(id: string): void {
    if (this.observers.has(id)) return;
    const entry: {abort:AbortController;retry?:NodeJS.Timeout} = {abort:new AbortController()};
    this.observers.set(id,entry);
    let attempts=0;
    const connect=async () => {
      if (this.stopped || entry.abort.signal.aborted || this.fatal) return;
      try {
        await this.t3.observe(id,entry.abort.signal,(snapshot,cursor) => {
          if (this.stopped || entry.abort.signal.aborted) return;
          attempts=0; this.snapshots.set(id,snapshot);
          for (const i of this.store.active()) {
            const input=JSON.parse(i.input) as WaitInput;
            if (input.condition?.kind === "thread" && input.condition.threadId === id) this.store.cursor(i.id,cursor);
          }
          this.poke();
        });
      } catch (error) {
        if (this.stopped || entry.abort.signal.aborted) return;
        this.options.report?.("observation_unavailable");
        if (error instanceof Error && (error.name === "ProtocolIncompatibleError" || error.message.includes("environment mismatch"))) {
          this.fatal=true; this.options.report?.("watcher_needs_attention"); return;
        }
      }
      if (!this.stopped && !entry.abort.signal.aborted) {
        this.snapshots.delete(id);
        entry.retry=setTimeout(connect,Math.min(30_000,250 * 2 ** Math.min(attempts++,7)));
      }
    };
    void connect();
  }
  /** Event/transition driven. This is never installed as a periodic scan. */
  poke(): void {
    if (this.stopped || this.pumping || this.fatal) return;
    this.pumping=true;
    try {
      const now=Date.now();
      for (const item of this.store.active()) {
        if (this.snapshots.has(item.parent)) {
          const p=this.snapshots.get(item.parent);
          if (!p || p.deleted || p.project !== item.project || p.archived || p.settled) {
            this.store.orphan(item.id,!p || p.deleted ? "parent_deleted" : "parent_inactive"); continue;
          }
        }
        if (item.kind === "decision") {
          if (now >= item.deadline) {
            this.store.answer(item.id,(JSON.parse(item.input) as DecisionInput).default,now);
            this.options.boundary?.("resolved",item.id);
          }
          continue;
        }
        const input=JSON.parse(item.input) as WaitInput;
        let outcome = input.condition.kind === "time" && now >= Date.parse(input.condition.at) ? {reason:"time"} : null;
        if (input.condition.kind === "thread") {
          const snapshot=this.snapshots.get(input.condition.threadId);
          if (snapshot?.deleted === true || (this.snapshots.has(input.condition.threadId) && snapshot === null))
            outcome={reason:"target_deleted"};
          else if (snapshot && item.target_run) outcome=completion(snapshot,item.target_run);
        }
        if (now >= item.deadline && (!outcome || input.condition.kind !== "time" || Date.parse(input.condition.at) > item.deadline)) outcome={reason:"timeout"};
        if (outcome) { this.store.resolve(item.id,outcome,undefined,now); this.options.boundary?.("resolved",item.id); }
      }
      this.store.maintain(now);
      const needed=new Set<string>();
      for (const i of this.store.outstanding()) {
        needed.add(i.parent);
        const input=JSON.parse(i.input) as WaitInput;
        if (i.state === "parked" && input.condition?.kind === "thread") needed.add(input.condition.threadId);
      }
      for (const [id,entry] of this.observers) if (!needed.has(id)) {
        entry.abort.abort(); clearTimeout(entry.retry); this.observers.delete(id); this.snapshots.delete(id);
      }
      for (const id of needed) this.watch(id);
      // Network operations run independently: an offline relay never delays a deadline or wake.
      for (const d of this.store.deliveries().sort((a,b) => a.channel === b.channel ? 0 : a.channel === "wake" ? -1 : 1)) {
        if (d.state !== "pending") continue;
        const item=this.store.get(d.item);
        if (d.channel === "phone" && (item.state !== "parked" || (d.expires !== null && now >= d.expires))) {
          this.store.suppress(d.id); continue;
        }
        if (d.next_at <= now && this.inflight.size < 8 && !this.inflight.has(d.id)) {
          this.inflight.add(d.id); void this.deliver(d).finally(() => { this.inflight.delete(d.id); this.poke(); });
        }
      }
      const times:number[]=[];
      for (const i of this.store.active()) {
        times.push(i.deadline);
        const input=JSON.parse(i.input) as WaitInput;
        if (input.condition?.kind === "time") times.push(Date.parse(input.condition.at));
      }
      for (const d of this.store.deliveries()) if (d.state === "pending" && !this.inflight.has(d.id)) {
        times.push(d.next_at); if (d.expires !== null) times.push(d.expires);
      }
      // Tombstone expiry also has a single next deadline, without model involvement.
      const terminal = this.store.db.prepare("SELECT min(terminal) AS t FROM items WHERE state<>'parked' AND id NOT IN (SELECT item FROM outbox WHERE state IN ('pending','sending','blocked'))").get() as {t:number|null};
      if (terminal.t !== null) times.push(terminal.t + 42*86_400_000 + 1);
      this.clock.arm(times.length ? Math.max(now+1,Math.min(...times)) : undefined,() => this.poke(),
        () => { this.fatal=true; this.options.report?.("calendar_timer_failed"); });
    } finally { this.pumping=false; }
  }
  private async deliver(delivery: Delivery): Promise<void> {
    try {
      const item=this.store.get(delivery.item);
      if (delivery.channel === "wake") {
        const parent=await this.t3.snapshot(item.parent);
        if (!parent || parent.deleted || parent.project !== item.project || parent.archived || parent.settled) {
          this.store.orphan(item.id,!parent || parent.deleted ? "parent_deleted" : "parent_inactive"); return;
        }
      }
      // Recheck after async preflight: cancel/answer may have suppressed this row.
      const claimed=this.store.claim(delivery.id); if (!claimed) return;
      this.options.boundary?.("before_send",delivery.item);
      if (claimed.channel === "wake") await this.t3.dispatch(claimed.payload);
      else {
        if (!this.options.notify) throw new Error("Notify relay not provisioned");
        await this.options.notify(claimed.payload);
      }
      this.options.boundary?.("after_send",delivery.item);
      this.store.sent(claimed.id);
      this.options.boundary?.("delivered",delivery.item);
    } catch (error) {
      if (this.stopped) return; // crash/restart reconciles 'sending'
      if (error instanceof Error && error.name === "WakeRejectedError") {
        this.store.block(delivery.id); this.options.report?.("wake_needs_attention"); return;
      }
      if (error instanceof Error && (error.name === "ProtocolIncompatibleError" || error.message.includes("environment mismatch"))) {
        this.fatal=true; this.options.report?.("watcher_needs_attention");
      }
      // Persist retry timing too; neither wire payload nor identity changes.
      this.store.retry(delivery.id,Date.now()+Math.min(30_000,250*2**Math.min(delivery.attempts,7)));
      this.options.report?.("delivery_retry");
    }
  }
  async stop(): Promise<void> {
    this.stopped=true; this.clock.clear();
    for (const e of this.observers.values()) {e.abort.abort();clearTimeout(e.retry);}
    // Service shutdown waits for requests (each has a bounded timeout) before closing SQLite.
    while (this.inflight.size) await new Promise(r => setTimeout(r,10));
  }
}
