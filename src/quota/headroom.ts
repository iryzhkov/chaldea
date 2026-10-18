// Sanitized, independently timestamped quota observations. No provider/account payload is persisted wholesale.
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { collectClaudeUsage, claudeCacheFile } from "../route/claude-usage.ts";
import { capacitySnapshot, publishSnapshot } from "./fleet.ts";
import { loadCapacityConfig } from "./capacity-config.ts";
import { accountKey, capacityKey } from "./account.ts";
import { retainBurnSample } from "./capacity.ts";
import type { BurnSample } from "./capacity.ts";
import { resolve } from "node:path";
import type { SwitchProvider } from "../t3/adapter.ts";
import type { QuotaRecord } from "./observer.ts";
import { BalanceReadError, contextKey, readCodexBalance, type CodexContext, type HeadroomConfig } from "./codex-balance.ts";

export const STALE_AFTER_MS = 15 * 60_000;
export const COLLECT_EVERY_MS = 5 * 60_000;
export const SNAPSHOT_EVERY_MS = 15 * 60_000;
export type MetricState = "fresh" | "stale" | "unknown" | "unsupported" | "error";
export interface Metric<T> {
  readonly value: T | null;
  readonly state: MetricState;
  readonly source: string;
  readonly observedAt: string | null;
  readonly error: string | null;
}
export interface Window {
  readonly id: string;
  readonly kind: string;
  readonly usedPercent: number;
  readonly remainingPercent: number;
  readonly windowDurationMins: number | null;
  readonly resetsAt: string | null;
}
export interface Wallet { readonly balance: string | null; readonly hasCredits: boolean; readonly unlimited: boolean }
export interface Resets { readonly availableCount: number; readonly nextExpiresAt: string | null }
export interface ExtraUsage { readonly usedMinor: number | null; readonly capMinor: number | null; readonly currency: string | null }
export interface ProviderHeadroom {
  readonly alias: string;
  readonly driver: string;
  accountKey?: string;
  creditExpiresAt?: string;
  burnHistory?: ReadonlyArray<BurnSample>;
  binding?: "asserted" | "verified";
  plan: Metric<string>;
  included: Metric<ReadonlyArray<Window>>;
  credits: Metric<Wallet>;
  manualResets: Metric<Resets>;
  extraUsage: Metric<ExtraUsage>;
  ordinaryUsageAllowed: Metric<boolean>;
  spendControlReached: Metric<boolean>;
}
export interface HeadroomState {
  providers: Array<ProviderHeadroom>;
  snapshotSlot: number;
  signature: string;
  low: string;
  sequence: number;
}
export const emptyHeadroom = (): HeadroomState => ({ providers: [], snapshotSlot: -1, signature: "", low: "", sequence: 0 });
const unknown = <T>(source: string, state: MetricState = "unknown", error: string | null = null): Metric<T> =>
  ({ value: null, state, source, observedAt: null, error });
const observed = <T>(value: T, source: string, at: string): Metric<T> =>
  ({ value, state: "fresh", source, observedAt: at, error: null });
export function metricNow<T>(m: Metric<T>, nowMs: number): Metric<T> & { ageSeconds: number | null } {
  const age = m.observedAt === null ? Number.NaN : nowMs - Date.parse(m.observedAt);
  const valid = Number.isFinite(age) && age >= 0;
  return { ...m, state: m.value !== null && (!valid || age >= STALE_AFTER_MS) ? "stale" : m.state,
    ageSeconds: valid ? Math.floor(age / 1000) : null };
}
export function newProvider(alias: string, driver: string): ProviderHeadroom {
  return { alias, driver, plan: unknown("t3"), included: unknown("t3"),
    credits: unknown(driver === "codex" ? "codex-app-server" : "not-a-prepaid-wallet", driver === "codex" ? "unknown" : "unsupported"),
    manualResets: unknown(driver === "claudeAgent" ? "t3-internal-claude-reset-read" : "t3"),
    extraUsage: unknown(driver === "claudeAgent" ? "claude-experimental-not-enabled" : "not-applicable", driver === "claudeAgent" ? "unknown" : "unsupported"),
    ordinaryUsageAllowed: unknown(driver === "codex" ? "codex-app-server" : "not-applicable", driver === "codex" ? "unknown" : "unsupported"),
    spendControlReached: unknown(driver === "codex" ? "codex-app-server" : "not-applicable", driver === "codex" ? "unknown" : "unsupported") };
}
const iso = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const safeId = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_.:/-]{1,100}$/.test(value) ? value : null;
const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const percent = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
const object = (value: unknown): Record<string, any> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;

/** Refuse malformed additions once at load, preserving the observer's fail-closed state policy. */
export function validateHeadroom(value: unknown): HeadroomState {
  const s = object(value);
  const metric = (v: unknown) => {
    const m = object(v);
    return m !== null && ["fresh", "stale", "unknown", "unsupported", "error"].includes(m.state) &&
      typeof m.source === "string" && (m.observedAt === null || iso(m.observedAt) !== null) &&
      (m.error === null || typeof m.error === "string") && Object.hasOwn(m, "value");
  };
  if (!s || !Array.isArray(s.providers) || s.providers.length > 64 ||
      !Number.isSafeInteger(s.snapshotSlot) || !count(s.sequence) || typeof s.signature !== "string" || typeof s.low !== "string") {
    throw new Error("invalid_headroom_state");
  }
  for (const p of s.providers) {
    if (!object(p) || !safeId(p.alias) || !safeId(p.driver) ||
        p.accountKey !== undefined && !/^[a-f0-9]{64}$/.test(p.accountKey) ||
        p.creditExpiresAt !== undefined && !iso(p.creditExpiresAt) ||
        p.burnHistory !== undefined && (!Array.isArray(p.burnHistory) || p.burnHistory.length > 288 ||
          !p.burnHistory.every((s: any) => object(s) && iso(s.observedAt) && Array.isArray(s.windows) && s.windows.length <= 32 &&
            s.windows.every((w: any) => object(w) && safeId(w.id) && percent(w.remainingPercent) && percent(w.usedPercent) &&
              (w.resetsAt === null || iso(w.resetsAt))))) ||
        p.binding !== undefined && !["asserted", "verified"].includes(p.binding) ||
        !["plan", "included", "credits", "manualResets", "extraUsage", "ordinaryUsageAllowed", "spendControlReached"].every(k => metric(p[k])) ||
        p.included.value !== null && (!Array.isArray(p.included.value) || p.included.value.length > 32 ||
          !p.included.value.every((w: any) => object(w) && safeId(w.id) && percent(w.usedPercent) && percent(w.remainingPercent))) ||
        p.credits.value !== null && (!object(p.credits.value) || typeof p.credits.value.hasCredits !== "boolean" || typeof p.credits.value.unlimited !== "boolean") ||
        p.manualResets.value !== null && (!object(p.manualResets.value) || !count(p.manualResets.value.availableCount))) {
      throw new Error("invalid_headroom_state");
    }
  }
  return value as HeadroomState;
}

export function applyT3(row: ProviderHeadroom, p: SwitchProvider): void {
  const u = p.usageLimits;
  if (!u) return;
  const at = iso(u.checkedAt);
  if (!at) return;
  const newer = (m: Metric<unknown>) => m.observedAt === null || Date.parse(at) >= Date.parse(m.observedAt);
  const reason = object(u.unavailable)?.reason;
  if (u.unavailable !== undefined && newer(row.included)) {
    if (reason === "unsupported") row.included = unknown("t3", "unsupported");
    else row.included = { ...row.included, error: "probe_failed", state: "error" };
  } else if (u.unavailable === undefined && newer(row.included)) {
    const windows = u.windows.slice(0, 32).map((w, i): Window => ({ id: safeId(w.id) ?? `window_${i}`,
      kind: ["session", "weekly", "monthly", "other"].includes(w.kind ?? "") ? w.kind! : "other",
      usedPercent: w.usedPercent, remainingPercent: 100 - w.usedPercent,
      windowDurationMins: count(w.windowDurationMins) ? w.windowDurationMins : null, resetsAt: iso(w.resetsAt) }));
    if (windows.every(w => percent(w.usedPercent)) && windows.length > 0) {
      retainBurnSample(row, at);
      row.included = observed(windows, "t3", at);
    }
  }
  // A window-only event must not advance reset inventory's successful observation time.
  if (u.resetCredits !== undefined && count(u.resetCredits.availableCount) && u.unavailable === undefined && newer(row.manualResets)) {
    row.manualResets = observed({ availableCount: u.resetCredits.availableCount, nextExpiresAt: iso(u.resetCredits.nextExpiresAt) },
      row.driver === "claudeAgent" ? "t3-internal-claude-reset-read" : "t3", at);
  }
}

const PLANS = new Set(["free", "go", "plus", "pro", "team", "business", "enterprise", "edu", "unknown"]);
export function applyCodex(row: ProviderHeadroom, raw: unknown, at: string): void {
  const result = object(raw);
  if (!result) throw new BalanceReadError("protocol");
  const key = accountKey(result.accountId);
  if (key) row.accountKey = key; else delete row.accountKey;
  const map = object(result.rateLimitsByLimitId);
  const buckets = map ? Object.values(map).map(object).filter(b => b !== null) : [object(result.rateLimits)].filter(b => b !== null);
  // Prefer the map and Codex bucket; never add wallets from duplicate buckets.
  const sameWallet = buckets.length > 0 && buckets.every(b => JSON.stringify(b.credits) === JSON.stringify(buckets[0]?.credits));
  const bucket = map ? object(map.codex) ?? (sameWallet ? buckets[0] : null) : buckets[0];
  const source = "codex-app-server";
  const c = object(bucket?.credits);
  if (c && typeof c.hasCredits === "boolean" && typeof c.unlimited === "boolean" &&
      (c.balance === null || c.balance === undefined || typeof c.balance === "string" && /^\d+(\.\d+)?$/.test(c.balance) && c.balance.length <= 100)) {
    row.credits = { ...observed({ balance: c.balance ?? null, hasCredits: c.hasCredits, unlimited: c.unlimited }, source, at),
      state: c.balance == null && !c.unlimited ? "unknown" : "fresh" };
  } else row.credits = unknown(source);
  const resets = object(result.rateLimitResetCredits);
  if (resets && count(resets.availableCount)) {
    row.manualResets = observed({ availableCount: resets.availableCount, nextExpiresAt: null }, source, at);
  } // A missing count never refreshes an earlier count.
  if (typeof result.ordinaryUsageAllowed === "boolean") row.ordinaryUsageAllowed = observed(result.ordinaryUsageAllowed, source, at);
  if (typeof bucket?.spendControlReached === "boolean") row.spendControlReached = observed(bucket.spendControlReached, source, at);
  if (typeof bucket?.planType === "string" && PLANS.has(bucket.planType)) row.plan = observed(bucket.planType, source, at);
}
export function failCodex(row: ProviderHeadroom, error: string): void {
  for (const key of ["credits", "ordinaryUsageAllowed", "spendControlReached", "plan"] as const) {
    row[key] = { ...row[key], state: "error", error } as never;
  }
  if (row.manualResets.source === "codex-app-server") row.manualResets = { ...row.manualResets, state: "error", error };
}

/** Public, identity-free lanes: reporting inputs only; paid admission stays false without a future policy. */
export function routingLanes(row: ProviderHeadroom, nowMs: number) {
  return {
    ...(row.binding ? { binding: row.binding } : {}),
    included: { windows: metricNow(row.included, nowMs), ordinaryUsageAllowed: metricNow(row.ordinaryUsageAllowed, nowMs) },
    creditFunded: { credits: metricNow(row.credits, nowMs), spendControlReached: metricNow(row.spendControlReached, nowMs),
      extraUsage: metricNow(row.extraUsage, nowMs), admissionAllowed: false as const },
    manualResetInventory: { resets: metricNow(row.manualResets, nowMs), automaticRedemptionAllowed: false as const },
  };
}
export function statusSnapshot(state: HeadroomState, nowMs: number) {
  return { version: 1, generatedAt: new Date(nowMs).toISOString(), providers: state.providers.map(row => ({
    alias: row.alias, driver: row.driver, ...(row.accountKey ? { accountKey: row.accountKey } : {}), plan: metricNow(row.plan, nowMs),
    ...routingLanes(row, nowMs),
  })) };
}
export function humanStatus(state: HeadroomState, nowMs: number): string {
  if (state.providers.length === 0) return "Quota headroom unknown: no cached provider observations.\n";
  const describe = <T>(m: Metric<T>, value: (v: T) => string): string => {
    const current = metricNow(m, nowMs);
    const observation = m.observedAt === null && m.error ? `reason ${m.error}` : `observed ${m.observedAt ?? "never"}`;
    return `${m.value === null ? "unknown" : value(m.value)} [${current.state}; ${m.source}; ${observation}; age ${current.ageSeconds === null ? "unknown" : current.ageSeconds + "s"}${m.error && m.observedAt !== null ? "; " + m.error : ""}]`;
  };
  return state.providers.map(row => [
    `${row.alias}${row.plan.value ? " (" + row.plan.value + ")" : ""}:`,
    ...(row.binding ? ["  binding: " + row.binding] : []),
    "  plan: " + describe(row.plan, String),
    "  included windows: " + describe(row.included, windows => windows.map(w =>
      `${w.id} ${w.usedPercent}% used / ${w.remainingPercent}% remaining; duration ${w.windowDurationMins ?? "unknown"} min; reset ${w.resetsAt ?? "unknown"}`).join("; ")),
    "  aggregate credits: " + describe(row.credits, c => `${c.balance ?? "unknown"} credits; hasCredits=${c.hasCredits}; unlimited=${c.unlimited}`),
    "  manual resets: " + describe(row.manualResets, r => `${r.availableCount}; next expiry ${r.nextExpiresAt ?? "unknown"}`),
    "  extra usage spend/cap: " + describe(row.extraUsage, e => `${e.usedMinor ?? "unknown"}/${e.capMinor ?? "unknown"} ${e.currency ?? "unknown currency"} minor units`),
    "  ordinary usage allowed: " + describe(row.ordinaryUsageAllowed, String),
    "  spend control reached: " + describe(row.spendControlReached, String),
  ].join("\n")).join("\n") + "\n";
}

const SKIP_REASONS = ["context_not_configured", "remote_t3", "provider_not_found", "provider_driver_mismatch",
  "provider_disabled", "provider_not_installed", "provider_unavailable", "auth_not_authenticated",
  "auth_type_not_chatgpt", "instance_environment_unsupported", "runtime_home_unknown", "runtime_home_mismatch"] as const;
type SkipReason = typeof SKIP_REASONS[number];
type BalanceReason = SkipReason | BalanceReadError["code"] | "read_started" | "read_completed" | "read_failed" | "context_mismatch";
function rejection(p: SwitchProvider | undefined, ctx: CodexContext, local: boolean): SkipReason | undefined {
  if (!local) return "remote_t3";
  if (!p) return "provider_not_found";
  if (p.driver !== "codex") return "provider_driver_mismatch";
  if (!p.enabled) return "provider_disabled";
  if (!p.installed) return "provider_not_installed";
  if (p.availability === "unavailable") return "provider_unavailable";
  if (p.auth.status !== "authenticated") return "auth_not_authenticated";
  if (p.auth.type !== "chatgpt") return "auth_type_not_chatgpt";
  if (p.quotaContextBlocked) return "instance_environment_unsupported";
  if (p.runtimeHome === undefined) return ctx.assertRuntimeHome ? undefined : "runtime_home_unknown";
  if (resolve(p.runtimeHome) !== ctx.codexHome) return "runtime_home_mismatch";
}

export type BalanceReader = (context: CodexContext, signal: AbortSignal) => Promise<unknown>;
/** Explicit clock/random seams make cadence tests deterministic, without wall-clock assertions. */
export interface HeadroomMonitorOptions {
  state: HeadroomState; config: HeadroomConfig; local: boolean;
  save: (records: ReadonlyArray<QuotaRecord>) => void;
  activeStops?: () => ReadonlySet<string>;
  claudeRead?: typeof collectClaudeUsage;
  read?: BalanceReader; now?: () => number; random?: () => number;
  diagnostic?: (detail: { provider: string; reason: BalanceReason; binding?: "asserted" }) => void;
}
export class HeadroomMonitor {
  #providers: ReadonlyArray<SwitchProvider> = [];
  #active = false;
  #changed = false;
  #baseline = false;
  #flight: Promise<void> | null = null;
  #due = new Map<string, number>();
  #failures = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #reported = new Map<string, string>();
  #started = new Set<string>();
  readonly #abort = new AbortController();
  readonly options: HeadroomMonitorOptions;
  constructor(options: HeadroomMonitorOptions) { this.options = options; }
  get state() { return this.options.state; }
  now() { return (this.options.now ?? Date.now)(); }
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.tick(); }, 10_000);
    this.#timer.unref();
  }
  update(providers: ReadonlyArray<SwitchProvider>): void {
    const before = JSON.stringify(this.state.providers);
    const identity = (p: SwitchProvider) => JSON.stringify([p.runtimeHome, p.quotaContextBlocked, p.quotaAccountKey, p.auth.status, p.auth.type]);
    const priorContexts = new Map(this.#providers.map(p => [p.instanceId, identity(p)]));
    this.#providers = providers;
    const previous = new Map(this.state.providers.map(p => [p.alias, p]));
    this.state.providers = providers.slice(0, 64).map(p => {
      const row = previous.get(p.instanceId);
      // Cached balances are not transferable to a newly configured HOME, including the first
      // config after restart (persisted observations have no credential identifiers).
      const next = row?.driver === p.driver ? row : newProvider(p.instanceId, p.driver);
      if (!priorContexts.has(p.instanceId) || priorContexts.get(p.instanceId) !== identity(p)) {
        const clean = newProvider(p.instanceId, p.driver);
        delete next.burnHistory;
        delete next.accountKey;
        next.credits = clean.credits; next.ordinaryUsageAllowed = clean.ordinaryUsageAllowed;
        next.spendControlReached = clean.spendControlReached; next.plan = clean.plan;
        if (next.manualResets.source === "codex-app-server") next.manualResets = clean.manualResets;
      }
      applyT3(next, p);
      return next;
    });
    for (const ctx of this.options.config.claudeContexts ?? []) {
      if (!this.state.providers.some(p => p.alias === ctx.providerInstanceId) && this.state.providers.length < 64)
        this.state.providers.push(previous.get(ctx.providerInstanceId) ?? newProvider(ctx.providerInstanceId, "claudeAgent"));
    }
    this.#diagnose();
    this.#changed ||= before !== JSON.stringify(this.state.providers);
    this.#active = true;
    // Include the bounded startup balance read in the first snapshot/baseline.
    if (this.#baseline) this.emit();
    void this.tick();
  }
  inactive(): void { this.#active = false; }
  async close(): Promise<void> {
    this.inactive(); if (this.#timer) clearInterval(this.#timer);
    this.#abort.abort(); await this.#flight;
  }
  tick(): Promise<void> {
    if (this.#flight) return this.#flight;
    if (!this.#active || this.#abort.signal.aborted) return Promise.resolve();
    this.#flight = this.#collect().finally(() => { this.#flight = null; });
    return this.#flight;
  }
  #report(provider: string, reason: BalanceReason): void {
    const binding = this.state.providers.find(p => p.alias === provider)?.binding;
    const signature = JSON.stringify([reason, binding]);
    if (this.#reported.get(provider) === signature) return;
    this.#reported.set(provider, signature);
    try { this.options.diagnostic?.({ provider, reason, ...(binding === "asserted" ? { binding } : {}) }); } catch { /* Logging cannot stop collection. */ }
  }
  #diagnose(): void {
    const bindings = new Map(this.options.config.contexts.flatMap(ctx => ctx.providers.map(alias => [alias, ctx] as const)));
    const before = JSON.stringify(this.state.providers);
    for (const [alias, ctx] of bindings) {
      const reason = rejection(this.#providers.find(p => p.instanceId === alias), ctx, this.options.local);
      if (!this.state.providers.some(p => p.alias === alias)) {
        if (this.state.providers.length < 64) this.state.providers.push(newProvider(alias, "codex"));
        else if (reason) this.#report(alias, reason);
      }
    }
    // Retain only current aliases and configured bindings, not historical catalog entries.
    for (const alias of this.#reported.keys()) {
      if (!bindings.has(alias) && !this.state.providers.some(p => p.alias === alias)) this.#reported.delete(alias);
    }
    for (const row of this.state.providers) {
      const ctx = bindings.get(row.alias);
      if (!ctx && row.driver !== "codex") continue;
      const p = this.#providers.find(p => p.instanceId === row.alias);
      const reason = ctx ? rejection(p, ctx, this.options.local) : "context_not_configured";
      // Keep provenance visible even while a temporary rejection marks cached metrics as errors.
      if (ctx && p?.driver === "codex" && p.runtimeHome === undefined && ctx.assertRuntimeHome) row.binding = "asserted";
      else if (ctx && p?.runtimeHome !== undefined && resolve(p.runtimeHome) === ctx.codexHome) row.binding = "verified";
      else delete row.binding;
      if (reason) {
        if (row.driver === "codex") failCodex(row, reason);
        else row.credits = { ...row.credits, error: reason };
        this.#report(row.alias, reason);
      } else {
        // Identity changes are cleared in update(). Eligibility flaps keep the same observations.
        const resume = <T>(m: Metric<T>, observedState: MetricState = "fresh"): Metric<T> => SKIP_REASONS.some(r => r === m.error) ||
          m.value === null && m.error === null ? { ...m,
            state: m.value === null ? "unknown" : observedState, error: m.value === null ? "read_scheduled" : null } : m;
        row.credits = resume(row.credits, row.credits.value?.balance === null && !row.credits.value.unlimited ? "unknown" : "fresh");
        row.ordinaryUsageAllowed = resume(row.ordinaryUsageAllowed);
        row.spendControlReached = resume(row.spendControlReached); row.plan = resume(row.plan);
        if (row.manualResets.source === "codex-app-server") row.manualResets = resume(row.manualResets);
      }
    }
    this.#changed ||= before !== JSON.stringify(this.state.providers);
  }
  #currentRow(p: SwitchProvider, ctx: CodexContext): ProviderHeadroom | undefined {
    const current = this.#providers.find(v => v.instanceId === p.instanceId);
    if (!current || rejection(current, ctx, this.options.local) !== undefined || current.runtimeHome !== p.runtimeHome ||
        current.quotaAccountKey !== p.quotaAccountKey) return;
    return this.state.providers.find(r => r.alias === p.instanceId);
  }
  async #collect(): Promise<void> {
    this.#diagnose();
    for (const ctx of this.options.config.claudeContexts ?? []) {
      if (!ctx.enabled || this.#abort.signal.aborted || !this.options.local) continue;
      const row = this.state.providers.find(p => p.alias === ctx.providerInstanceId);
      if (!row || row.driver !== "claudeAgent") continue;
      const usage = await (this.options.claudeRead ?? collectClaudeUsage)({ enabled: true, credentialFile: ctx.credentialFile,
        cacheFile: claudeCacheFile(homedir(), ctx.credentialFile),
        now: this.now() });
      if (!usage.value) continue;
      if (ctx.accountKey && usage.value.accountKey !== ctx.accountKey) {
        delete row.accountKey;
        row.included = { ...row.included, state: "error", error: "context_mismatch" };
        this.#changed = true;
        continue;
      }
      const u = usage.value;
      if (!row.included.observedAt || Date.parse(u.observedAt) > Date.parse(row.included.observedAt) || row.included.source === "t3") {
        retainBurnSample(row, u.observedAt);
        row.included = observed(u.windows.map(w => ({ ...w, id: w.kind, usedPercent: 100 - w.remainingPercent })), "claude-usage", u.observedAt);
        if (u.accountKey) row.accountKey = u.accountKey; else delete row.accountKey;
        this.#changed = true;
      }
    }
    // Policies may differ across aliases sharing one executable/HOME tuple.
    const contexts = new Map(this.options.config.contexts.map(ctx => [contextKey(ctx), ctx]));
    if (this.options.local) for (const [key, ctx] of contexts) {
      const now = this.now();
      if ((this.#due.get(key) ?? 0) > now || this.#abort.signal.aborted || !this.#active) continue;
      const matching = this.options.config.contexts.filter(c => contextKey(c) === key).flatMap(binding =>
        this.#providers.filter(p => binding.providers.includes(p.instanceId) && rejection(p, binding, this.options.local) === undefined)
          .map(p => ({ p, binding })));
      if (matching.length === 0) continue; // unknown context never falls back to this shell's login
      try {
        if (!this.#started.has(key)) {
          this.#started.add(key);
          for (const { p } of matching) this.#report(p.instanceId, "read_started");
        }
        const raw = await (this.options.read ?? readCodexBalance)(ctx, this.#abort.signal);
        if (this.#abort.signal.aborted) return;
        const at = new Date(this.now()).toISOString();
        // Match again after await: aliases can be reconfigured during a read.
        for (const { p, binding } of matching) {
          const row = this.#currentRow(p, binding);
          if (!row) continue;
          const accountId = object(raw)?.accountId;
          if ((binding.accountKey ?? p.quotaAccountKey) && accountKey(accountId) !== (binding.accountKey ?? p.quotaAccountKey)) {
            delete row.accountKey;
            row.included = { ...row.included, state: "error", error: "context_mismatch" };
            failCodex(row, "context_mismatch"); this.#report(p.instanceId, "context_mismatch");
          } else { applyCodex(row, raw, at); this.#report(p.instanceId, "read_completed"); }
        }
        this.#failures.delete(key);
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        this.#failures.set(key, Math.min(5, (this.#failures.get(key) ?? 0) + 1));
        for (const { p, binding } of matching) {
          const row = this.#currentRow(p, binding);
          if (!row) continue;
          const reason = error instanceof BalanceReadError ? error.code : "read_failed";
          failCodex(row, reason);
          this.#report(p.instanceId, reason);
        }
      }
      this.#changed = true;
      const failures = this.#failures.get(key) ?? 0;
      const jitter = 0.9 + (this.options.random ?? Math.random)() * 0.2;
      this.#due.set(key, this.now() + COLLECT_EVERY_MS * 2 ** failures * jitter);
    }
    this.emit();
    const fleet = this.options.config.fleet;
    if (fleet?.enabled) {
      try {
        const capacity = loadCapacityConfig(homedir());
        for (const row of this.state.providers) {
          const expiry = capacity.providers[row.accountKey ? capacityKey(row.driver, row.accountKey) : row.alias]?.creditExpiresAt;
          if (expiry) row.creditExpiresAt = expiry; else delete row.creditExpiresAt;
        }
        const snapshot = capacitySnapshot(fleet.host, this.state.providers, this.options.activeStops?.() ?? new Set(), this.now());
        await publishSnapshot(fleet, snapshot, this.now());
      } catch { /* Optional publication never interrupts the observer. */ }
    }
  }
  emit(): void {
    if (!this.#active) return;
    const now = this.now();
    const eligible = new Set(this.#providers.filter(p => p.enabled && p.installed && p.availability !== "unavailable" &&
      (p.usageLimits?.unavailable === undefined || object(p.usageLimits.unavailable)?.reason === "unsupported")).map(p => p.instanceId));
    const providers = this.state.providers.filter(p => eligible.has(p.alias) &&
      [p.plan, p.included, p.credits, p.manualResets, p.extraUsage, p.ordinaryUsageAllowed, p.spendControlReached]
        .some(m => metricNow<unknown>(m, now).state === "fresh")).sort((a, b) => a.alias.localeCompare(b.alias));
    const snapshot = statusSnapshot({ ...this.state, providers }, now);
    // Ages and successful-read timestamps are not changes in availability/inventory.
    const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
    const signature = digest(providers.map(p => ({ alias: p.alias,
      states: [p.included, p.credits, p.manualResets, p.extraUsage, p.ordinaryUsageAllowed, p.spendControlReached].map(m => metricNow<unknown>(m, now).state),
      count: p.manualResets.value?.availableCount ?? null, walletAvailable: p.credits.value?.hasCredits ?? null, ordinary: p.ordinaryUsageAllowed.value, spendControl: p.spendControlReached.value })));
    const low = providers.filter(p => {
      const m = metricNow(p.included, now);
      return m.state === "fresh" && m.value?.some(w => w.remainingPercent <= this.options.config.lowHeadroomPercent);
    }).map(p => p.alias).sort().join(",");
    const records: Array<QuotaRecord> = [];
    const add = (kind: "quota_headroom_snapshot" | "quota_headroom_changed" | "quota_headroom_low") => {
      this.state.sequence++;
      records.push({ kind, severity: kind === "quota_headroom_low" ? "warn" : "info",
        threadId: "headroom", runId: `${now}-${this.state.sequence}`, provider: "all",
        resetAt: null, subagent: false, headroom: snapshot });
    };
    const slot = Math.floor(now / SNAPSHOT_EVERY_MS);
    if (providers.length > 0 && slot !== this.state.snapshotSlot) {
      this.state.snapshotSlot = slot;
      if (!this.options.config.fleet?.enabled) add("quota_headroom_snapshot");
    }
    if (this.#baseline && providers.length > 0) {
      if (signature !== this.state.signature) add("quota_headroom_changed");
      if (low !== this.state.low && low) add("quota_headroom_low");
    }
    // The first usable catalog after startup establishes a silent transition baseline.
    this.#baseline ||= providers.length > 0;
    this.state.signature = signature;
    this.state.low = low;
    if (records.length > 0 || this.#changed) {
      this.options.save(records); // snapshot and delivery intents are persisted before poster enqueue
      this.#changed = false;
    }
  }
}
