// Included-window policy shared by status and routing. Callers supply fresh observations.
export interface IncludedWindow {
  kind: string; remainingPercent: number; windowDurationMins: number | null; resetsAt: string | null;
}
export function windowPolicy<T extends IncludedWindow>(input: ReadonlyArray<T>, now: number, minimumRemaining: number, paceMargin: number) {
  const windows = input.filter(w => Number.isFinite(w.remainingPercent) && w.remainingPercent >= 0 && w.remainingPercent <= 100 &&
    (w.resetsAt === null || Number.isFinite(Date.parse(w.resetsAt)) && Date.parse(w.resetsAt) > now));
  const short = (w: T) => w.kind === "session" || w.windowDurationMins !== null && w.windowDurationMins <= 300;
  const timed = windows.filter(w => !short(w) && w.windowDurationMins !== null && w.windowDurationMins > 0 &&
    w.resetsAt !== null && Date.parse(w.resetsAt) - now <= w.windowDurationMins * 60_000);
  // A short window alone cannot establish pacing, even if its reset is imminent.
  const pacing = timed.find(w => w.kind === "weekly") ??
    [...timed].sort((a, b) => b.windowDurationMins! - a.windowDurationMins!)[0];
  const timeLeft = pacing ? (Date.parse(pacing.resetsAt!) - now) / (pacing.windowDurationMins! * 60_000) : null;
  const pace = pacing && timeLeft !== null ? pacing.remainingPercent / 100 - timeLeft : null;
  const reasons = windows.map(w => w === pacing
    ? `${w.kind} ${Math.round(w.remainingPercent)}% left with ${Math.round(timeLeft! * 100)}% of window left: ${pace! >= paceMargin ? "under-paced" : "on/ahead of pace"}`
    : `${w.windowDurationMins === 300 ? "5h" : w.kind} window ${Math.round(w.remainingPercent)}% left; reset ${w.resetsAt ?? "unknown"}`);
  // Short gates override wallets and reserves. An unknown-duration session still gates.
  const blocked = windows.filter(short);
  const gate = blocked.some(w => w.remainingPercent === 0) ? "stopped" as const
    : blocked.some(w => w.remainingPercent / 100 < minimumRemaining) ? "tight" as const : null;
  return { pacing, timeLeft, pace, reasons, gate };
}
