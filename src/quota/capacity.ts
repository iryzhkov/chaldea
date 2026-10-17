// Capacity is advice over cached observations. This module performs no IO or redemption.
import type { ObserverState } from "./state.ts";
import type { Metric, ProviderHeadroom, Window } from "./headroom.ts";
export type CapacityClass = "unlimited" | "use-it" | "paced" | "tight" | "stopped" | "unknown";
export interface BurnSample { observedAt: string; windows: ReadonlyArray<Window> }
export interface CapacityConfig {
  heavyMultiplier: number; recentWindowMs: number; maxAgeMs: number; minimumResetLeadHours: number;
  paceMargin: number; minimumRemaining: number; reserveFraction: number; expiryHorizonMs: number;
  providers: Record<string, {
    creditsPerFullWeek?: number;
    creditExpiresAt?: string;
    claudeRefills?: { count: number; expiresAt: string };
  }>;
}
export const DEFAULT_CAPACITY: CapacityConfig = {
  heavyMultiplier: 2, recentWindowMs: 24 * 3600000, maxAgeMs: 15 * 60000, minimumResetLeadHours: 72,
  paceMargin: .1, minimumRemaining: .1, reserveFraction: .05, expiryHorizonMs: 86400000, providers: {},
};
export interface Capacity {
  class: CapacityClass; reasons: string[];
  remainingFraction: number | null; reserveWeeks: number;
  observedBurnPerHour: number | null; projectedHeavyUse: number | null; burnTargetPerHour: number | null;
  observedAt: string | null;
}
const fresh = <T>(m: Metric<T>, now: number, maxAge: number): T | null =>
  m.state === "fresh" && m.observedAt !== null && now >= Date.parse(m.observedAt) &&
    now - Date.parse(m.observedAt) < maxAge ? m.value : null;
const unexpired = (at: string | null | undefined, now: number) => !!at && Number.isFinite(Date.parse(at)) && Date.parse(at) > now;
function burnRate(p: ProviderHeadroom, current: Window, now: number, recentMs: number): number | null {
  const at = Date.parse(p.included.observedAt!);
  let oldestAt = at, oldestRemaining = current.remainingPercent, newerRemaining = current.remainingPercent;
  for (const sample of [...(p.burnHistory ?? [])].sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt))) {
    const t = Date.parse(sample.observedAt);
    if (!Number.isFinite(t) || t >= oldestAt || now - t > recentMs) continue;
    const w = sample.windows.find(w => w.id === current.id && w.resetsAt === current.resetsAt);
    // A refill/reset starts a new segment; never project across it.
    if (!w || w.remainingPercent < newerRemaining) break;
    oldestAt = t; oldestRemaining = w.remainingPercent; newerRemaining = w.remainingPercent;
  }
  return at - oldestAt >= 5 * 60000 ? (oldestRemaining - current.remainingPercent) / 100 / ((at - oldestAt) / 3600000) : null;
}
/** Value each reserve at its projected redemption time. Subsequent exhaustion follows
 * one full quota allowance, but every reserve is valued only through native reset.
 * Closed-form arithmetic keeps even oversized inventories bounded.
 */
function timedReserves(count: number, expiresAt: string | null, hours: number,
  rate: number | null, remaining: number, minLead: number, now: number) {
  if (rate === null || !Number.isFinite(rate) || rate <= 0)
    return { useful: 0, weeks: 0, reason: "projected exhaustion unknown or absent; no timed reserve value" };
  const first = remaining / rate, step = 1 / rate;
  const expiry = expiresAt === null ? Infinity : (Date.parse(expiresAt) - now) / 3600000;
  const byLead = Math.max(0, Math.floor((hours - minLead - first + 1e-9) / step) + 1);
  const byExpiry = Math.max(0, Math.ceil((expiry - first) / step));
  const useful = Math.min(count, byLead, byExpiry);
  const lead = hours - first;
  const full = Math.min(useful, Math.max(0, Math.floor((lead - 168) / step) + 1));
  const tail = useful - full;
  const valueHours = full * 168 + tail * (lead - full * step) - step * tail * (tail - 1) / 2;
  return { useful, weeks: Math.max(0, valueHours / 168),
    reason: `projected first exhaustion in ${first.toFixed(1)}h; ${useful}/${count} reserves usable before expiry with at least ${minLead}h lead to native reset` };
}
export function classifyCapacity(p: ProviderHeadroom, activeStop: boolean, now: number, config: CapacityConfig = DEFAULT_CAPACITY): Capacity {
  const c: Capacity = { class: "unknown", reasons: [], remainingFraction: null, reserveWeeks: 0,
    observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null, observedAt: p.included.observedAt };
  const finish = (kind: CapacityClass, reason: string) => { c.class = kind; c.reasons.push(reason); return c; };
  if (activeStop) return finish("stopped", "active usage stop; reserves do not authorize redemption");
  const maxAge = p.included.source === "operator-weekly-target" ? 7 * 86400000 : config.maxAgeMs;
  const windows = fresh(p.included, now, maxAge)?.filter(w => unexpired(w.resetsAt, now)) ?? [];
  if (!windows.length) return finish("unknown", "missing, stale or expired native window; never assumed unlimited");
  const w = [...windows].filter(w => w.windowDurationMins !== null && w.windowDurationMins > 0)
    .sort((a, b) => b.windowDurationMins! - a.windowDurationMins!)[0];
  if (!w) return finish("unknown", "window duration missing");
  const hours = (Date.parse(w.resetsAt!) - now) / 3600000, durationHours = w.windowDurationMins! / 60;
  if (hours > durationHours) return finish("unknown", "reset outside the native window");
  const remaining = w.remainingPercent / 100;
  c.remainingFraction = remaining;
  c.burnTargetPerHour = Math.max(0, remaining - config.reserveFraction) / hours;
  c.observedBurnPerHour = burnRate(p, w, now, config.recentWindowMs);
  const heavyRate = c.observedBurnPerHour === null ? null : c.observedBurnPerHour * config.heavyMultiplier;
  c.projectedHeavyUse = heavyRate === null || heavyRate <= 0 ? null : heavyRate * hours;
  const reserves = config.providers[p.alias] ?? {};
  let expiring = false;
  const near = (at: string | null | undefined) => unexpired(at, now) && Date.parse(at!) - now <= config.expiryHorizonMs;
  if (p.driver === "codex") {
    const resets = fresh(p.manualResets, now, config.maxAgeMs);
    // availableCount is the currently redeemable inventory. A known expired earliest
    // deadline invalidates it until refreshed; an omitted expiry uses only the fresh count.
    if (resets?.availableCount && (resets.nextExpiresAt === null || unexpired(resets.nextExpiresAt, now))) {
      const timing = timedReserves(resets.availableCount, resets.nextExpiresAt, hours, heavyRate, remaining, config.minimumResetLeadHours, now);
      c.reserveWeeks += timing.weeks;
      expiring ||= timing.useful > 0 && near(resets.nextExpiresAt);
      c.reasons.push(`${resets.availableCount} Codex resets: ${timing.reason}; timed value ${timing.weeks.toFixed(3)} weeks`);
    } else if (resets?.availableCount) c.reasons.push("reset expiry unknown/expired; reserve value unknown");
    const credits = fresh(p.credits, now, config.maxAgeMs);
    const balance = Number(credits?.balance);
    const usable = credits && credits.balance !== null && Number.isFinite(balance) && balance > 0 &&
      (reserves.creditExpiresAt === undefined || unexpired(reserves.creditExpiresAt, now));
    if (usable) {
      expiring ||= near(reserves.creditExpiresAt);
      if (reserves.creditsPerFullWeek !== undefined && reserves.creditsPerFullWeek > 0) {
        c.reserveWeeks += balance / reserves.creditsPerFullWeek;
        c.reasons.push(`${balance} aggregate credits at operator conversion ${reserves.creditsPerFullWeek} credits/full week`);
      } else c.reasons.push("positive credits balance; credits/full-week conversion unknown");
    }
    // A provider-declared unlimited wallet is still not an unlimited quota window.
  } else if (p.driver === "claudeAgent") {
    const refill = reserves.claudeRefills;
    if (refill && refill.count > 0 && unexpired(refill.expiresAt, now)) {
      const timing = timedReserves(refill.count, refill.expiresAt, hours, heavyRate, remaining, 0, now);
      c.reserveWeeks += timing.weeks;
      expiring ||= timing.useful > 0 && near(refill.expiresAt);
      c.reasons.push(`${refill.count} Claude refills retain native reset: ${timing.reason}; timed value ${timing.weeks.toFixed(3)} weeks`);
    }
  }
  const low = windows.some(v => v.remainingPercent / 100 < config.minimumRemaining);
  if (low && c.reserveWeeks === 0) return finish("tight", "under minimum remaining quota with no usable reserves");
  if (expiring) return finish("use-it", "a reserve will expire unused soon; recommend use before expiry");
  if (!low && remaining - hours / durationHours >= config.paceMargin)
    return finish("use-it", "window under-paced; quota will expire unused at the native reset");
  if (c.projectedHeavyUse !== null && remaining + c.reserveWeeks - config.reserveFraction >= c.projectedHeavyUse)
    return finish("unlimited", `remaining quota plus reserves cover projected heavy use until native reset, retaining ${config.reserveFraction * 100}% reserve`);
  if (c.projectedHeavyUse === null) c.reasons.push("positive recent burn rate unknown; reserves cannot establish unlimited capacity");
  return finish("paced", `use within burn target to retain ${config.reserveFraction * 100}% at native reset`);
}
export function classifyCapacities(state: Pick<ObserverState, "headroom" | "parked">, now: number, config: CapacityConfig = DEFAULT_CAPACITY): Record<string, Capacity> {
  const stopped = new Set([...state.parked.values()].filter(s => s.resetAt === null ||
    !Number.isFinite(Date.parse(s.resetAt)) || Date.parse(s.resetAt) > now).map(s => s.provider));
  const result = Object.fromEntries(state.headroom.providers.map(p => [p.alias, classifyCapacity(p, stopped.has(p.alias), now, config)]));
  for (const alias of stopped) if (!result[alias]) result[alias] = { class: "stopped",
    reasons: ["active usage stop; no cached native window"], observedAt: null, remainingFraction: null, reserveWeeks: 0,
    observedBurnPerHour: null, projectedHeavyUse: null, burnTargetPerHour: null };
  return result;
}
/** Keep at most 288 previous window observations, sampled no more than every five minutes. */
export function retainBurnSample(row: ProviderHeadroom, nextAt: string): void {
  const old = row.included;
  if (!old.value || !old.observedAt || old.state !== "fresh" || Date.parse(nextAt) <= Date.parse(old.observedAt)) return;
  const history = row.burnHistory ?? [];
  const last = history.at(-1);
  if (last && Date.parse(old.observedAt) - Date.parse(last.observedAt) < 5 * 60000) return;
  const samples = [...history, { observedAt: old.observedAt, windows: old.value }]
    .filter(s => Date.parse(nextAt) - Date.parse(s.observedAt) <= 48 * 3600000).slice(-288);
  // <=1 MiB across the observer's 64-provider cap, leaving room for its durable outbox.
  let bytes = 2;
  const kept: BurnSample[] = [];
  for (const sample of samples.toReversed()) {
    bytes += Buffer.byteLength(JSON.stringify(sample)) + 1;
    if (bytes > 16 * 1024) break;
    kept.push(sample);
  }
  row.burnHistory = kept.toReversed();
}
