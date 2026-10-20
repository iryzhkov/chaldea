// Browser DTOs are constructed here. Raw source objects never cross this interface.
import type { ShellEvent, ShellThread, MissionDetailEvent } from "../t3/adapter.ts";
import { ThreadDetails, aggregateDetails, validResources, safeProviderId, titlePreview, appThreadIdPreview, type Resources, emptyDetail } from "./details.ts";
import { isolateDetail } from "./detail-contract.ts";
import type { HeadroomState, Metric } from "../quota/headroom.ts";
export const MAX_AGENTS = 48, MAX_TURNS = 512, MAX_SAMPLES = 4096;
const tools = new Set(["read","search","navigate","edit_apply","change_plan","verify_run","chaldea exec","t3_thread_read","t3_thread_list","jocasta","watch_pull_request","html_preview","delegate_task","chaldea_decision_prepare"]);
const toolAliases = new Map<string,string>();
for(const tool of tools)for(const prefix of ["","mcp__huyang__","mcp__t3_code__","functions.mcp__huyang__","functions.mcp__t3_code__"])toolAliases.set(prefix+tool,tool);
toolAliases.set("command_execution","Command running");
toolAliases.set("Command running","Command running");
export const fixedTool = (value:unknown):string => typeof value==="string" ? toolAliases.get(value) ?? "Activity unavailable" : "Activity unavailable";
export interface HostSummary {host:string;shown:number;total:number|null;truncated:boolean;observedAt:number|null;freshness:string;connected:boolean|null;states:Record<string,number>;models:{model:string;count:number;usage?:import("./details.ts").Usage}[];resources?:Resources;details?:ReturnType<typeof aggregateDetails>}
export function summarizeHost(host:string,agents:{state:string;model:string}[],total:number|null,truncated:boolean,observedAt:number|null,freshness:string,connected:boolean|null):HostSummary {
  const states:Record<string,number>={},models=new Map<string,number>();
  for(const a of agents){states[a.state]=(states[a.state]??0)+1;models.set(a.model,(models.get(a.model)??0)+1);}
  return {host,shown:agents.length,total,truncated,observedAt,freshness,connected,states,models:[...models].map(([model,count])=>({model,count}))};
}
export function safeLabel(value: unknown, fallback = "Task"): string {
  if (typeof value !== "string") return fallback;
  const s = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  if (!s || /(?:bearer|token|secret|password|api.?key|sk-[\w-]+|[\w.+-]+@[\w.-]+|(?:\/|\\)[\w.~]|[A-Za-z0-9_-]{32,})/i.test(s)) return fallback;
  return s.replace(/[<>&"'`]/g, "").slice(0, 100);
}
const at = (s: string | null | undefined): number | null => s && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
type Thread = { localId: string; row: ShellThread; observed: number; connected: boolean; detailObserved: number | null; steps: string[] };
function threadState(row:ShellThread,details:import("./details.ts").Detail):string {
  if(row.pendingRequest){
    if(!row.pendingRequestKind||row.pendingRequestKind==="user_input")return "waiting-igor";
    return ["command","file-read","file-change","mcp-elicitation","permission"].includes(row.pendingRequestKind)?"waiting-approval":"waiting";
  }
  if(["failed","interrupted"].includes(row.status))return "failed";
  if(row.status==="cancelled")return "cancelled";
  if(row.status==="waiting"){
    if(details.work.children&&details.work.children.active>0)return "waiting-children";
    if(details.work.monitors&&details.work.monitors>0)return "waiting-monitor";
    return "waiting";
  }
  if(["pending","queued","preparing"].includes(row.status))return "queued";
  if(row.activeRunId)return details.activity==="thinking"?"thinking":"working";
  return row.status==="completed"?"completed":"idle";
}
const activeThread = (row:ShellThread):boolean => /^(thinking|working|waiting(?:-|$)|queued$)/.test(threadState(row,emptyDetail()));
export class MissionModel {
  private detailStates = new Map<string,ThreadDetails>();
  private providerCatalog=new Map<string,string|null>();
  setProviderCatalog(rows:ReadonlyArray<{instanceId:string;driver:string}>):void {
    this.providerCatalog.clear();
    for(const p of rows.slice(0,128))if(safeProviderId(p.instanceId))this.providerCatalog.set(p.instanceId,this.providerCatalog.has(p.instanceId)?null:safeProviderId(p.driver)?p.driver:null);
    this.changed();
  }
  private resources:Resources={state:"unavailable",sample:null};
  setResources(resources:Resources):void {this.resources=resources.state==="reported"&&validResources(resources.sample)&&resources.sample.sampledAt<=this.now()?resources:{state:"unavailable",sample:null};this.changed();}
  private threads = new Map<string, Thread>();
  private nextLocalId = 0;
  private turns = new Map<string, { output: number; at: number; live: boolean; fence: number }>();
  private evictedThrough: number | null = null;
  private accountingPartial = false;
  private samples: { at: number; output: number }[] = [];
  private listeners = new Set<() => void>();
  private sequence: number | undefined;
  private connected = false;
  private observed: number | null = null;
  private quota: HeadroomState | null = null;
  private quotaError = false;
  private total = 0;
  private coverageExact = true;
  private startedAt: number;
  private output = 0;
  private usageObserved: number | null = null;
  readonly demo: boolean;
  private now: () => number;
  constructor(demo = false, now = Date.now) { this.demo = demo; this.now = now; this.startedAt = now(); }
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  changed(): void { for (const fn of this.listeners) fn(); }
  cursor(): number | undefined { return this.sequence; }
  ids(): string[] { return [...this.threads.keys()]; }
  shell(event: ShellEvent): void {
    const now = this.now();
    if (event.kind === "synchronized") { this.connected = true; for(const id of this.detailStates.keys())if(!this.threads.has(id))this.detailStates.delete(id);
    this.observed = now; this.changed(); return; }
    if (event.kind !== "snapshot" && this.sequence !== undefined && event.sequence <= this.sequence) return;
    this.sequence = event.sequence;
    if (event.kind === "snapshot") {
      const rows = event.threads.filter(t => !t.archived && !t.deleted && !t.settled);
      this.total = rows.length; this.coverageExact = true;
      const selected = rows.toSorted((a,b) => Number(activeThread(b))-Number(activeThread(a)) || (a.latestRunStartedAt ?? "").localeCompare(b.latestRunStartedAt ?? "") || a.id.localeCompare(b.id)).slice(0, MAX_AGENTS);
      const previous = this.threads; this.threads = new Map();
      for (const row of selected) this.threads.set(row.id, { localId: previous.get(row.id)?.localId ?? "agent-" + this.nextLocalId++, connected: false, detailObserved: null, steps: [], ...previous.get(row.id), row, observed: now });
      for (const id of this.detailStates.keys()) if (!this.threads.has(id)) this.detailStates.delete(id);
    } else if (event.kind === "thread") {
      const row = event.thread;
      if (row.archived || row.deleted || row.settled) {
        this.detailStates.delete(row.id);
        if (this.threads.delete(row.id)) this.total = Math.max(0, this.total - 1);
        else if (this.total > this.threads.size) this.coverageExact = false;
      }
      else if (this.threads.has(row.id)) { this.threads.get(row.id)!.row = row; this.threads.get(row.id)!.observed = now; }
      else {
        if (this.total > this.threads.size || this.threads.size >= MAX_AGENTS) this.coverageExact = false;
        // Active work can replace a retained terminal row without claiming exact coverage.
        if (this.threads.size >= MAX_AGENTS && activeThread(row)) {
          const victim=[...this.threads].find(([,t])=>!activeThread(t.row))?.[0];
          if(victim!==undefined){this.threads.delete(victim);this.detailStates.delete(victim);}
        }
        if (this.threads.size < MAX_AGENTS) {
          this.threads.set(row.id, { localId: "agent-" + this.nextLocalId++, row, observed: now, connected: false, detailObserved: null, steps: [] });
          if (this.coverageExact) this.total++;
        }
      }
    } else if (event.kind === "removed") {
      this.detailStates.delete(event.threadId);
      if (this.threads.delete(event.threadId)) this.total = Math.max(0, this.total - 1);
      else if (this.total > this.threads.size) this.coverageExact = false;
    }
    // Keep both public projections in the same active-first map order, including resumed rows.
    this.threads = new Map([...this.threads].toSorted(([,a],[,b])=>Number(activeThread(b.row))-Number(activeThread(a.row))));
    this.observed = now; this.changed();
  }
  disconnected(): void { this.providerCatalog.clear(); if (this.connected) this.observed = this.now(); this.connected = false; for (const t of this.threads.values()) { if (t.connected) t.detailObserved = this.now(); t.connected = false; } this.changed(); }
  detailDisconnected(id: string): void { const t = this.threads.get(id); if (t) { if (t.connected) t.detailObserved = this.now(); t.connected = false; } this.changed(); }
  detail(id: string, event: MissionDetailEvent): void {
    const t = this.threads.get(id); if (!t) return;
    const now = this.now(); t.detailObserved = now;
    let details=this.detailStates.get(id);if(!details){details=new ThreadDetails();this.detailStates.set(id,details);}
    if((event.kind==="turn-usage"||event.kind==="assistant")&&(!Number.isSafeInteger(event.at)||event.at>now))return;
    if(["reset","clear-activity","assistant","command","metadata","turn-usage","activity-state","recent-item"].includes(event.kind)){details.apply(event as import("./details.ts").DetailEvent);this.changed();return;}
    if (event.kind === "synchronized") t.connected = true;
    if (event.kind === "activity") {
      const label = fixedTool(event.tool);
      if (label !== t.steps[0]) t.steps = [label, ...t.steps].slice(0, 6);
    }
    if (event.kind === "usage" && count(event.output)) {
      if (!Number.isFinite(event.at) || event.startedAt != null && event.startedAt > now) return;
      const key = id + ":" + event.turnId;
      const prev = this.turns.get(key);
      if (prev && event.at <= prev.at) return;
      // Only a live report with a demonstrated post-start turn may count from zero.
      const postStart = event.startedAt != null && event.startedAt >= this.startedAt && event.startedAt <= now && event.startedAt <= event.at;
      // A start beyond every forgotten counter proves this first report was not counted before.
      const knownNew = postStart && (this.evictedThrough === null || event.startedAt! > this.evictedThrough);
      const delta = prev ? event.output >= prev.output ? event.output - prev.output : event.output : !event.baseline && knownNew ? event.output : 0;
      const fence = Math.max(prev?.fence ?? 0, now, event.at, Number.isFinite(event.startedAt) ? event.startedAt! : 0);
      if (!prev && this.turns.size >= MAX_TURNS) {
        const baselineKey = [...this.turns].find(([, value]) => !value.live)?.[0];
        if (event.baseline && baselineKey === undefined) {
          // An unretained snapshot sample is also forgotten knowledge.
          this.evictedThrough = Math.max(this.evictedThrough ?? 0, fence);
          this.accountingPartial = true;
          this.changed();
          return;
        }
        const victim = baselineKey ?? this.turns.keys().next().value!;
        this.evictedThrough = Math.max(this.evictedThrough ?? 0, now, this.turns.get(victim)!.fence);
        this.accountingPartial = true;
        this.turns.delete(victim);
      }
      this.turns.delete(key); this.turns.set(key, { output: event.output, at: event.at, live: prev?.live === true || !event.baseline,
        fence });
      if (!event.baseline && (prev !== undefined || knownNew)) { this.samples.push({ at: now, output: delta }); this.output += delta; this.usageObserved = now; }
      this.samples = this.samples.filter(s => now - s.at <= 60_000).slice(-MAX_SAMPLES);
    }
    this.changed();
  }
  setQuota(state: HeadroomState | null, error = false): void { this.quota = state; this.quotaError = error; this.changed(); }
  quotaTimes():[number|null,number|null][] {
    const seen=new Set<string>();return (this.quota?.providers??[]).slice(0,32).filter(p=>{const k=p.driver+":"+(p.accountKey??p.alias);if(seen.has(k))return false;seen.add(k);return true;}).map(p=>[at(p.credits.observedAt),at(p.manualResets.observedAt)]);
  }
  snapshot() {
    const now = this.now();
    const freshness = (connected: boolean, observed: number | null, stale: number, lost: number) =>
      connected ? "live" : observed === null ? "nosource" : now - observed > lost ? "lost" : now - observed > stale ? "stale" : "disconnected";
    const metric = <T>(m: Metric<T>) => ({ state: m.state, observedAt: at(m.observedAt), ageSeconds: at(m.observedAt) === null ? null : Math.max(0, (now - at(m.observedAt)!) / 1000) });
    const accounts: { label: string; state: string; observedAt: number | null; ageSeconds: number | null; used: number | null; resetsAt: number | null; duration: number | null; credits: string | null; creditState: string; resetState: string; unlimited: boolean | null; manualResets: number | null }[] = [];
    const seen = new Set<string>();
    for (const p of (this.quota?.providers ?? []).slice(0, 32)) {
      // Dedup internally. No account identity/hash or provider alias leaves this process.
      const key = p.accountKey ? p.driver + ":" + p.accountKey : p.driver + ":" + p.alias;
      if (seen.has(key)) continue; seen.add(key);
      const m = p.included, w = m.value?.[0];
      const age = metric(m);
      accounts.push({ label: safeLabel(p.driver, "Provider") + " account " + (accounts.length + 1),
        ...age, state: this.quotaError ? "error" : age.ageSeconds !== null && age.ageSeconds > 5400 ? "lost" : age.ageSeconds !== null && age.ageSeconds > 1800 ? "stale" : m.state,
        used: w && Number.isFinite(w.usedPercent) && w.usedPercent >= 0 && w.usedPercent <= 100 ? w.usedPercent : null,
        resetsAt: at(w?.resetsAt), duration: count(w?.windowDurationMins) ? w.windowDurationMins : null,
        credits: typeof p.credits.value?.balance === "string" && /^\d+(?:\.\d+)?$/.test(p.credits.value.balance) ? p.credits.value.balance.slice(0, 24) : null,
        creditState: p.credits.state, resetState: p.manualResets.state,
        unlimited: p.credits.value?.unlimited ?? null, manualResets: count(p.manualResets.value?.availableCount) ? p.manualResets.value.availableCount : null });
    }
    const agents = [...this.threads.values()].map(t => {
      const instance=t.row.modelSelection?.instanceId??t.row.providerInstanceId;
      const provider=safeProviderId(instance)&&instance===t.row.providerInstanceId?{instanceId:instance,driver:this.providerCatalog.get(instance)??null}:null;
      const details={...emptyDetail(),...isolateDetail({...(this.detailStates.get(t.row.id)??new ThreadDetails()).snapshot(t.row.modelSelection,now,t.connected&&this.connected),provider,identity:{title:titlePreview(t.row.title),appThreadId:appThreadIdPreview(t.row.id)}},now)};
      const state=threadState(t.row,details),completedAt=at(t.row.latestRunCompletedAt);
      return ({
      id: t.localId, title: safeLabel(t.row.title), model: safeLabel(t.row.modelSelection?.model, "Model unknown"),
      host: "omarchy-pc", state,
      startedAt: at(t.row.latestRunStartedAt),
      // Only the owning run's actual completion is authoritative. Unknown time stays unknown.
      completedAt: state==="completed" && completedAt!==null && completedAt>0 && completedAt<=now && completedAt<=t.observed && completedAt>=(at(t.row.latestRunStartedAt)??0) ? completedAt : null,
      observedAt: t.observed, detailObservedAt: t.detailObserved,
      freshness: freshness(this.connected, this.observed, 30_000, 300_000),
      activityFreshness: freshness(t.connected, t.detailObserved, 60_000, 600_000), steps: [...t.steps],
      detailCoverage:"reported" as string,
      details,
    });});
    const usageConnected = agents.length > 0 && [...this.threads.values()].every(t => t.connected);
    const result={ version: 1, demo: this.demo, now, source: { state: freshness(this.connected, this.observed, 30_000, 300_000), observedAt: this.observed },
      hostSummary: [{...summarizeHost("omarchy-pc",agents,this.coverageExact?this.total:null,!this.coverageExact||this.total>agents.length,this.observed,freshness(this.connected,this.observed,30_000,300_000),this.observed===null?null:this.connected),resources:this.resources,details:aggregateDetails(agents.map(a=>a.details),agents.length)}] as HostSummary[],
      resources:this.resources,
      agents, shown: agents.length, total: this.coverageExact ? this.total : null, truncated: !this.coverageExact || this.total > agents.length,
      tokens: { rate: this.usageObserved === null || !usageConnected ? null : this.samples.filter(s => now - s.at <= 60_000).reduce((s,v) => s + v.output, 0) / 60,
        output: this.usageObserved === null ? null : this.output, observedAt: this.usageObserved,
        coverage: this.accountingPartial ? "partial" : "observed",
        scope: this.accountingPartial ? "Partial accounting: known lower bound after bounded counter eviction. Uncertain returning counters establish new baselines. Daily reconciliation unavailable." : "Observed deltas since this process started; 48-thread cap. Daily reconciliation unavailable." },
      quota: { state: this.quotaError ? "error" : this.quota === null ? "unknown" : "cached", accounts } as {state:string;accounts:typeof accounts;hosts?:{host:string;state:string;observedAt:number|null;omitted:number;accounts:typeof accounts}[]},
      unavailable: ["Events","Ops","Lab","host health","exec slots","cost","daily totals"] };
    // Recent text yields before existing identity/resource/base coverage.
    for(const a of [...agents].reverse()){
      if(Buffer.byteLength(JSON.stringify(result))<=128*1024)break;
      a.details.recent=[];
    }
    // Keep every admitted base row; shed optional detail in reverse display order.
    for(const a of [...agents].reverse()){
      if(Buffer.byteLength(JSON.stringify(result))<=128*1024)break;
      a.details={...emptyDetail(),identity:a.details.identity,fieldCoverage:"identity-only"};
      a.detailCoverage="byte-budget";
    }
    return result as typeof result & Partial<import("./contract.ts").OperationsDTO>;
  }
}
