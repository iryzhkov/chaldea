// Browser DTOs are constructed here. Raw source objects never cross this interface.
import type { ShellEvent, ShellThread, MissionDetailEvent } from "../t3/adapter.ts";
import type { HeadroomState, Metric } from "../quota/headroom.ts";
export const MAX_AGENTS = 48, MAX_TURNS = 512, MAX_SAMPLES = 4096;
const tools = new Set(["read","search","navigate","edit_apply","change_plan","verify_run","chaldea exec","t3_thread_read","t3_thread_list","jocasta","watch_pull_request","html_preview","delegate_task","chaldea_decision_prepare"]);
export function safeLabel(value: unknown, fallback = "Task"): string {
  if (typeof value !== "string") return fallback;
  const s = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  if (!s || /(?:bearer|token|secret|password|api.?key|sk-[\w-]+|[\w.+-]+@[\w.-]+|(?:\/|\\)[\w.~]|[A-Za-z0-9_-]{32,})/i.test(s)) return fallback;
  return s.replace(/[<>&"'`]/g, "").slice(0, 100);
}
const at = (s: string | null | undefined): number | null => s && Number.isFinite(Date.parse(s)) ? Date.parse(s) : null;
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
type Thread = { row: ShellThread; observed: number; connected: boolean; detailObserved: number | null; steps: string[] };
export class MissionModel {
  private threads = new Map<string, Thread>();
  private turns = new Map<string, { output: number; at: number; live: boolean }>();
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
    if (event.kind === "synchronized") { this.connected = true; this.observed = now; this.changed(); return; }
    if (event.kind !== "snapshot" && this.sequence !== undefined && event.sequence <= this.sequence) return;
    this.sequence = event.sequence;
    if (event.kind === "snapshot") {
      const rows = event.threads.filter(t => !t.archived && !t.deleted && !t.settled);
      this.total = rows.length; this.coverageExact = true;
      const selected = rows.toSorted((a,b) => (a.latestRunStartedAt ?? "").localeCompare(b.latestRunStartedAt ?? "") || a.id.localeCompare(b.id)).slice(0, MAX_AGENTS);
      const previous = this.threads; this.threads = new Map();
      for (const row of selected) this.threads.set(row.id, { connected: false, detailObserved: null, steps: [], ...previous.get(row.id), row, observed: now });
    } else if (event.kind === "thread") {
      const row = event.thread;
      if (row.archived || row.deleted || row.settled) {
        if (this.threads.delete(row.id)) this.total = Math.max(0, this.total - 1);
        else if (this.total > this.threads.size) this.coverageExact = false;
      }
      else if (this.threads.has(row.id)) { this.threads.get(row.id)!.row = row; this.threads.get(row.id)!.observed = now; }
      else {
        if (this.total > this.threads.size || this.threads.size >= MAX_AGENTS) this.coverageExact = false;
        if (this.threads.size < MAX_AGENTS) {
          this.threads.set(row.id, { row, observed: now, connected: false, detailObserved: null, steps: [] });
          if (this.coverageExact) this.total++;
        }
      }
    } else if (event.kind === "removed") {
      if (this.threads.delete(event.threadId)) this.total = Math.max(0, this.total - 1);
      else if (this.total > this.threads.size) this.coverageExact = false;
    }
    this.observed = now; this.changed();
  }
  disconnected(): void { if (this.connected) this.observed = this.now(); this.connected = false; for (const t of this.threads.values()) { if (t.connected) t.detailObserved = this.now(); t.connected = false; } this.changed(); }
  detailDisconnected(id: string): void { const t = this.threads.get(id); if (t) { if (t.connected) t.detailObserved = this.now(); t.connected = false; } this.changed(); }
  detail(id: string, event: MissionDetailEvent): void {
    const t = this.threads.get(id); if (!t) return;
    const now = this.now(); t.detailObserved = now;
    if (event.kind === "synchronized") t.connected = true;
    if (event.kind === "activity") {
      const label = event.tool && tools.has(event.tool) ? event.tool : "Activity unavailable";
      if (label !== t.steps[0]) t.steps = [label, ...t.steps].slice(0, 6);
    }
    if (event.kind === "usage" && count(event.output)) {
      const key = id + ":" + event.turnId;
      const prev = this.turns.get(key);
      if (prev && event.at <= prev.at) return;
      // Only a live report with a demonstrated post-start turn may count from zero.
      const postStart = event.startedAt != null && event.startedAt >= this.startedAt && event.startedAt <= now;
      const delta = prev ? event.output >= prev.output ? event.output - prev.output : event.output : !event.baseline && postStart ? event.output : 0;
      if (!prev && this.turns.size >= MAX_TURNS) {
        const baselineKey = [...this.turns].find(([, value]) => !value.live)?.[0];
        if (event.baseline && baselineKey === undefined) return;
        this.turns.delete(baselineKey ?? this.turns.keys().next().value!);
      }
      this.turns.delete(key); this.turns.set(key, { output: event.output, at: event.at, live: prev?.live === true || !event.baseline });
      if (!event.baseline && (prev !== undefined || postStart)) { this.samples.push({ at: now, output: delta }); this.output += delta; this.usageObserved = now; }
      this.samples = this.samples.filter(s => now - s.at <= 60_000).slice(-MAX_SAMPLES);
    }
    this.changed();
  }
  setQuota(state: HeadroomState | null, error = false): void { this.quota = state; this.quotaError = error; this.changed(); }
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
    const agents = [...this.threads.values()].map((t,i) => ({
      id: "agent-" + i, title: safeLabel(t.row.title), model: safeLabel(t.row.modelSelection?.model, "Model unknown"),
      host: "omarchy-pc", state: t.row.pendingRequest ? "waiting-igor" : ["failed","interrupted"].includes(t.row.status) ? "failed" : t.row.status === "waiting" ? "waiting" : t.row.activeRunId ? "working" : "idle",
      startedAt: at(t.row.latestRunStartedAt), observedAt: t.observed, detailObservedAt: t.detailObserved,
      freshness: freshness(this.connected, this.observed, 30_000, 300_000),
      activityFreshness: freshness(t.connected, t.detailObserved, 60_000, 600_000), steps: [...t.steps],
    }));
    const usageConnected = agents.length > 0 && [...this.threads.values()].every(t => t.connected);
    return { version: 1, demo: this.demo, now, source: { state: freshness(this.connected, this.observed, 30_000, 300_000), observedAt: this.observed },
      agents, shown: agents.length, total: this.coverageExact ? this.total : null, truncated: !this.coverageExact || this.total > agents.length,
      tokens: { rate: this.usageObserved === null || !usageConnected ? null : this.samples.filter(s => now - s.at <= 60_000).reduce((s,v) => s + v.output, 0) / 60,
        output: this.usageObserved === null ? null : this.output, observedAt: this.usageObserved, scope: "Observed deltas since this process started; 48-thread cap. Daily reconciliation unavailable." },
      quota: { state: this.quotaError ? "error" : this.quota === null ? "unknown" : "cached", accounts },
      unavailable: ["Fleet","Events","Ops","Lab","host health","exec slots","cost","daily totals"] };
  }
}
