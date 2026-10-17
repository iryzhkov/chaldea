import { WakeStore, CheckpointBlockedError, type Item, type Registration, type Delivery } from "../wake/store.ts";
import type { WaitT3, WaitSnapshot } from "../t3/waits.ts";
import { NativeDecisions, questionSchema } from "../decisions/native.ts";
import { completion } from "./completion.ts";
import { Deadlines } from "./deadlines.ts";
import type { WaitInput, DecisionInput, NativeDecisionInput, AnswerSource } from "./types.ts";

export interface EngineOptions {
  answerBaseUrl: string;
  threadUrl?: (threadId:string) => string;
  notify?: (payload: string) => Promise<void>;
  // Test seam for abrupt process termination at durable/ambiguous boundaries.
  boundary?: (name: string, item: string) => void;
  report?: (event: string) => void;
}
export class WaitEngine {
  readonly store: WakeStore;
  readonly t3: WaitT3;
  private options: EngineOptions;
  private native: NativeDecisions;
  private clock = new Deadlines();
  private snapshots = new Map<string,WaitSnapshot|null>();
  private cursors = new Map<string,number>();
  private observers = new Map<string,{abort:AbortController; retry?:NodeJS.Timeout}>();
  private inflight = new Map<string,Delivery["channel"]>();
  private hasSlot(channel: Delivery["channel"]): boolean {
    return [...this.inflight.values()].filter(c=>c===channel).length < (channel === "phone" ? 2 : 8);
  }
  private stopped = false;
  private pumping = false;
  private fatal = false;
  private storageFailed = false;
  private failStorage(): void {
    if (this.storageFailed) return;
    this.storageFailed=true;this.fatal=true;
    this.clock.clear();clearTimeout(this.storageRetry);
    const fallback=() => console.error("Chaldea waits: fatal storage error; restarting");
    try { this.options.report ? this.options.report("watcher_needs_attention") : fallback(); }
    catch { fallback(); }
    finally { setImmediate(() => process.exit(1)); }
  }
  private storageRetry: NodeJS.Timeout | undefined;
  private storageAttempts = 0;
  private storageBlocked = false;
  private pendingCommits = new Map<string,() => void>();
  private backoffStorage(): void {
    if (!this.storageBlocked) { this.storageBlocked=true;this.options.report?.("checkpoint_blocked"); }
    if (this.stopped || this.storageRetry) return;
    this.clock.clear();
    this.storageRetry=setTimeout(() => {
      this.storageRetry=undefined;this.poke();
    },Math.min(30_000,250 * 2 ** Math.min(this.storageAttempts++,7)));
  }
  private persistDelivery(id: string, operation: () => void): void {
    try { operation(); }
    catch(error) {
      if (error instanceof CheckpointBlockedError) { this.pendingCommits.set(id,operation);this.backoffStorage(); }
      else this.failStorage();
    }
  }
  constructor(store: WakeStore, t3: WaitT3, options: EngineOptions) { this.store=store; this.t3=t3; this.options=options;
    this.native=new NativeDecisions(store,item=>this.nativePhone(item),options.boundary); }
  start(): void { this.poke(); }
  trackedNative(parent:string):ReturnType<WakeStore["nativeTracking"]>{
    if(this.fatal)throw new Error("Watcher needs attention");
    try{return this.store.nativeTracking(parent);}
    catch(error){
      if(error instanceof CheckpointBlockedError)this.backoffStorage();else this.failStorage();
      throw error;
    }
  }
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
  async registerNative(value:unknown,track=false):Promise<Item>{
    if(this.fatal)throw new Error("Watcher needs attention");
    if(!this.t3.respond)throw new Error("Native responses are unavailable");
    const started=Date.now(),reg=this.store.prepare("native",value);
    if(track && !("runtimeRequestId" in reg.input))throw new Error("runtimeRequestId required for track");
    if(!track && "runtimeRequestId" in reg.input)throw new Error("Use decision track for an explicit runtime request");
    const existing=this.store.existing(reg);if(existing)return existing;
    await this.t3.environment();const parent=await this.t3.snapshot(reg.input.threadId,track?(reg.input as NativeDecisionInput).runtimeRequestId:undefined);
    if(!parent||parent.deleted||parent.archived||parent.settled)throw new Error("Caller thread is absent, archived or settled on this T3");
    let questions:string|null=null,itemId:string|null=null;
    if(track){
      const request=parent.requests?.find(r=>r.id===(reg.input as NativeDecisionInput).runtimeRequestId);
      if(!request)throw new Error("Runtime request does not exist on the caller thread");
      if(request.kind!=="user_input")throw new Error("Only user_input questions can be tracked; permissions and approvals are never answered");
      questions=questionSchema(request.questions);itemId=request.itemId??null;
      if(request.status==="pending" && !questions)throw new Error("Native question schema is unavailable or exceeds 4 KiB; prepare before asking");
    }
    const baseline=(parent.requests??[]).filter(r=>r.created>=started-1000).map(r=>r.id);
    const row=this.store.register(reg,parent.project,null,undefined,Date.now(),baseline,questions,itemId);
    this.snapshots.set(parent.id,parent);
    this.options.boundary?.("registered",row.id);this.poke();return this.store.get(row.id);
  }
  private nativePhone(item:Item):string{
    const input=JSON.parse(item.input) as NativeDecisionInput;
    return JSON.stringify({id:"chaldea-decision:"+this.store.environment+":"+item.id,title:"Chaldea decision",
      content:"Answer the native question in T3.\nNo answer: "+input.defaultAction+" "+input.dependentAction+"\nDeadline: "+input.deadline,
      priority:"default",url:this.options.threadUrl?.(item.parent)??"t3-thread://v1/"+encodeURIComponent(item.parent)});
  }
  private phone(reg: Registration): string {
    const q = reg.input as DecisionInput;
    return JSON.stringify({id:"chaldea-decision:" + this.store.environment + ":" + reg.id,
      title:"Chaldea decision",content:q.question + "\nNo answer: " + q.defaultAction + " " + (q.dependentAction ?? "the dependent action") + "\nDeadline: " + q.deadline,
      priority:"default",url:new URL("/decisions/" + reg.id,this.options.answerBaseUrl).toString()});
  }
  answer(id: string, answer: string, source: AnswerSource): Item {
    const row=this.store.answer(id,answer,source); this.options.boundary?.("resolved",id); this.poke(); return row;
  }
  async answerFromThread(id: string, answer: string, threadId: string): Promise<Item> {
    if (this.store.get(id).parent === threadId) throw new Error("Asking thread cannot answer its own decision");
    await this.t3.environment();
    const caller=await this.t3.snapshot(threadId);
    if (!caller || caller.deleted || caller.archived || caller.settled) throw new Error("Answering thread is absent, archived or settled on this T3");
    return this.answer(id,answer,`mcp:${threadId}`);
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
          attempts=0; this.snapshots.set(id,snapshot); this.cursors.set(id,cursor);
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
    if (this.stopped || this.pumping || this.fatal || this.storageRetry) return;
    this.pumping=true;
    try {
      for (const [id,commit] of this.pendingCommits) { commit();this.pendingCommits.delete(id); }
      const now=Date.now();
      if (!this.options.notify) for (const d of this.store.deliveries())
        if (d.channel === "phone" && d.state === "pending") this.store.undeliverable(d.id);
      for (const item of this.store.active()) {
        if (this.snapshots.has(item.parent)) {
          const p=this.snapshots.get(item.parent);
          if (!p || p.deleted || p.project !== item.project || p.archived || p.settled) {
            this.store.orphan(item.id,!p || p.deleted ? "parent_deleted" : "parent_inactive"); continue;
          }
        }
        if(item.kind==="native"){
          const snapshot=this.snapshots.get(item.parent);
          if(snapshot)this.native.reconcile(item,snapshot,now);
          continue;
        }
        if (item.kind === "decision") {
          if (now >= item.deadline) {
            this.store.expire(item.id,now);
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
        const cursor=input.condition.kind === "thread" ? this.cursors.get(input.condition.threadId) : undefined;
        if (outcome) { this.store.resolve(item.id,outcome,cursor,now); this.options.boundary?.("resolved",item.id); }
        else if (cursor !== undefined && cursor > item.cursor) this.store.cursor(item.id,cursor);
      }
      this.store.maintain(now);
      const needed=new Set<string>();
      for (const i of this.store.outstanding()) {
        needed.add(i.parent);
        const input=JSON.parse(i.input) as WaitInput;
        if (i.state === "parked" && input.condition?.kind === "thread") needed.add(input.condition.threadId);
      }
      for (const [id,entry] of this.observers) if (!needed.has(id)) {
        entry.abort.abort(); clearTimeout(entry.retry); this.observers.delete(id); this.snapshots.delete(id); this.cursors.delete(id);
      }
      for (const id of needed) this.watch(id);
      // Network operations run independently: an offline relay never delays a deadline or wake.
      for (const d of this.store.deliveries().sort((a,b) => a.channel === b.channel ? 0 : a.channel === "phone" ? 1 : -1)) {
        if (d.state !== "pending") continue;
        const item=this.store.get(d.item);
        if(d.channel==="phone" && !this.options.notify){this.store.undeliverable(d.id);continue;}
        if (d.channel === "phone" && (item.state !== "parked" || (d.expires !== null && now >= d.expires))) {
          this.store.suppress(d.id); continue;
        }
        if (d.next_at <= now && this.hasSlot(d.channel) && !this.inflight.has(d.id)) {
          this.inflight.set(d.id,d.channel); void this.deliver(d).finally(() => { this.inflight.delete(d.id); this.poke(); });
        }
      }
      if (this.storageRetry) return; // A synchronous phone claim may have armed storage backoff.
      const times:number[]=[];
      for (const i of this.store.active()) {
        if(i.kind==="native"){
          // Reconnect supplies an authoritative snapshot and drives the next pump.
          // An overdue deadline must not spin while T3 is unreachable.
          if(this.snapshots.get(i.parent)){
            const deadline=this.native.deadline(i);if(deadline!==undefined)times.push(deadline);
          }
          continue;
        }
        times.push(i.deadline);
        const input=JSON.parse(i.input) as WaitInput;
        if (input.condition?.kind === "time") times.push(Date.parse(input.condition.at));
      }
      for (const d of this.store.deliveries()) if (d.state === "pending" && !this.inflight.has(d.id)) {
        // Completion of an in-flight request triggers the next drain; no busy timer loop.
        if (d.next_at > now || this.hasSlot(d.channel)) times.push(d.next_at);
        if (d.expires !== null) times.push(d.expires);
      }
      // Tombstone expiry also has a single next deadline, without model involvement.
      const terminal = this.store.db.prepare("SELECT min(terminal) AS t FROM items WHERE state<>'parked' AND id NOT IN (SELECT item FROM outbox WHERE state IN ('pending','sending','blocked','uncertain'))").get() as {t:number|null};
      if (terminal.t !== null) times.push(terminal.t + 42*86_400_000 + 1);
      this.clock.arm(times.length ? Math.max(now+1,Math.min(...times)) : undefined,() => this.poke(),
        () => { this.options.report?.("calendar_timer_retry"); });
      this.storageAttempts=0;this.storageBlocked=false;
    } catch(error) {
      if (error instanceof CheckpointBlockedError) this.backoffStorage();
      else this.failStorage();
    } finally { this.pumping=false; }
  }
  private async deliver(delivery: Delivery): Promise<void> {
    try {
      const item=this.store.get(delivery.item);
      if (delivery.channel !== "phone") {
        const parent=await this.t3.snapshot(item.parent);
        if (!parent || parent.deleted || parent.project !== item.project || parent.archived || parent.settled) {
          this.persistDelivery(delivery.id,() => this.store.orphan(item.id,!parent || parent.deleted ? "parent_deleted" : "parent_inactive")); return;
        }
        if(delivery.channel==="native" && !this.native.beforeSend(item,delivery,parent))return;
      }
      // Recheck after async preflight: cancel/answer may have suppressed this row.
      const claimed=this.store.claim(delivery.id); if (!claimed) return;
      this.options.boundary?.("before_send",delivery.item);
      if(claimed.channel==="native"){
        const accepted=await this.t3.respond!(claimed.payload);
        this.options.boundary?.("after_send",delivery.item);
        if(accepted)this.persistDelivery(claimed.id,()=>{this.native.accepted(item);this.options.boundary?.("delivered",item.id);});
        else{
          const snapshot=await this.t3.snapshot(item.parent);
          this.persistDelivery(claimed.id,()=>{
            if(!snapshot||snapshot.deleted||snapshot.project!==item.project||snapshot.archived||snapshot.settled)
              this.store.orphan(item.id,!snapshot||snapshot.deleted?"parent_deleted":"parent_inactive");
            else this.native.rejected(item,snapshot);
          });
        }
        return;
      }
      if (claimed.channel === "wake") await this.t3.dispatch(claimed.payload);
      else {
        if (!this.options.notify) throw new Error("Notify relay not provisioned");
        await this.options.notify(claimed.payload);
      }
      this.options.boundary?.("after_send",delivery.item);
      this.persistDelivery(claimed.id,() => {
        this.store.sent(claimed.id);this.options.boundary?.("delivered",delivery.item);
      });
    } catch (error) {
      if (this.stopped) return; // crash/restart reconciles 'sending'
      if (error instanceof CheckpointBlockedError) { this.backoffStorage();return; }
      if (error instanceof Error && error.name === "WakeRejectedError") {
        this.persistDelivery(delivery.id,() => this.store.block(delivery.id)); this.options.report?.("wake_needs_attention"); return;
      }
      if (error instanceof Error && (error.name === "ProtocolIncompatibleError" || error.message.includes("environment mismatch"))) {
        this.fatal=true; this.options.report?.("watcher_needs_attention");
      }
      // Persist retry timing too; neither wire payload nor identity changes.
      this.persistDelivery(delivery.id,() => this.store.retry(delivery.id,Date.now()+Math.min(30_000,250*2**Math.min(delivery.attempts,7))));
      this.options.report?.("delivery_retry");
    }
  }
  async stop(): Promise<void> {
    this.stopped=true; this.clock.clear();clearTimeout(this.storageRetry);
    for (const e of this.observers.values()) {e.abort.abort();clearTimeout(e.retry);}
    // Service shutdown waits for requests (each has a bounded timeout) before closing SQLite.
    while (this.inflight.size) await new Promise(r => setTimeout(r,10));
  }
}
