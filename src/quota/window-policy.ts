// Included-window policy shared by status and routing. Callers supply fresh observations.
export interface IncludedWindow {
  id?: string; kind: string; remainingPercent: number; windowDurationMins: number | null; resetsAt: string | null;
}
/** Native IDs preserve account-wide and model-specific limits on the existing wire. */
export const modelScopedWindow = (w: IncludedWindow) => /^seven_day_/.test(w.id ?? "");
export const fableModel = (model: string) => /(?:^|[-_/:])(?:claude[-_])?fable(?:[-_.:/]|$)/i.test(model);
export function modelWindowPolicy(input: ReadonlyArray<IncludedWindow>, model: string, now: number, minimum: number, margin: number) {
  const common = windowPolicy(input, now, minimum, margin);
  if (!fableModel(model)) return { ...common, scopedLimit: undefined as IncludedWindow | undefined, scopeKnown: true,
    binding: common.gate ? input.find(w => !modelScopedWindow(w) && (w.kind === "session" || w.windowDurationMins !== null && w.windowDurationMins <= 300) && w.remainingPercent / 100 < minimum) : common.limit ?? common.pacing };
  const scoped = input.find(w => w.id === "seven_day_fable");
  const scopeKnown = !!scoped && Number.isFinite(scoped.remainingPercent) && scoped.remainingPercent >= 0 &&
    scoped.remainingPercent <= 100 && scoped.resetsAt !== null && Date.parse(scoped.resetsAt) > now &&
    scoped.windowDurationMins === 10080 && Date.parse(scoped.resetsAt) - now <= 10080 * 60000;
  const extra = scopeKnown ? windowPolicy([{ ...scoped!, id: "weekly" }], now, minimum, margin) : null;
  const binding = extra && (extra.limit || extra.pace! < (common.pace ?? Infinity)) ? scoped : common.limit ?? common.pacing;
  return { ...common, scopedLimit: extra?.limit ? scoped : undefined, limit: common.limit ?? (extra?.limit ? scoped : undefined),
    pace: scopeKnown && common.pace !== null ? Math.min(common.pace, extra!.pace!) : null,
    scopeKnown, binding, reasons: [...common.reasons, scopeKnown
      ? "seven_day_fable " + scoped!.remainingPercent + "% left; applies to Fable"
      : "seven_day_fable unknown; additional Fable capacity not established"] };
}
export function windowPolicy<T extends IncludedWindow>(input: ReadonlyArray<T>, now: number, minimumRemaining: number, paceMargin: number) {
  const windows = input.filter(w => !modelScopedWindow(w) && Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100 &&
    (w.resetsAt === null || Number.isFinite(Date.parse(w.resetsAt)) && Date.parse(w.resetsAt) > now));
  const short = (w: T) => w.kind === "session" || w.windowDurationMins !== null && w.windowDurationMins <= 300;
  const timed = windows.filter(w => !short(w) && w.windowDurationMins !== null && w.windowDurationMins > 0 &&
    w.resetsAt !== null && Date.parse(w.resetsAt) - now <= w.windowDurationMins * 60_000);
  // A short window alone cannot establish pacing, even if its reset is imminent.
  const weekly = timed.filter(w => w.kind === "weekly");
  const pacing = [...(weekly.length ? weekly : timed)].sort((a, b) =>
    (a.remainingPercent / 100 - (Date.parse(a.resetsAt!) - now) / (a.windowDurationMins! * 60000)) -
    (b.remainingPercent / 100 - (Date.parse(b.resetsAt!) - now) / (b.windowDurationMins! * 60000)))[0];
  const timeLeft = pacing ? (Date.parse(pacing.resetsAt!) - now) / (pacing.windowDurationMins! * 60_000) : null;
  const pace = pacing && timeLeft !== null ? pacing.remainingPercent / 100 - timeLeft : null;
  const reasons = windows.map(w => w === pacing
    ? `${w.kind} ${Math.round(w.remainingPercent)}% left with ${Math.round(timeLeft! * 100)}% of window left: ${pace! >= paceMargin ? "under-paced" : "on/ahead of pace"}`
    : `${w.windowDurationMins === 300 ? "5h" : w.kind} window ${Math.round(w.remainingPercent)}% left; reset ${w.resetsAt ?? "unknown"}`);
  // Short gates override wallets and reserves. An unknown-duration session still gates.
  const blocked = windows.filter(short);
  const gate = blocked.some(w => w.remainingPercent === 0) ? "stopped" as const
    : blocked.some(w => w.remainingPercent / 100 < minimumRemaining) ? "tight" as const : null;
  const limit = windows.find(w => !short(w) && w.remainingPercent / 100 < minimumRemaining);
  return { pacing, timeLeft, pace, reasons, gate, limit };
}
