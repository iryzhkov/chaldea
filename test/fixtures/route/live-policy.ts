import { newProvider } from "../../../src/quota/headroom.ts";
import { now, iso } from "./catalog.ts";

// Sanitized client-v0.3.0 observation: about 60,149 credits and one manual reset.
// No burn history or credits-to-weeks conversion was available.
export function liveCodex() {
  const p = newProvider("codex", "codex");
  p.credits = { value: { balance: "60149", hasCredits: true, unlimited: false },
    state: "fresh", source: "codex-app-server", observedAt: iso(now), error: null };
  p.manualResets = { value: { availableCount: 1, nextExpiresAt: null },
    state: "fresh", source: "codex-app-server", observedAt: iso(now), error: null };
  return p;
}
export const liveReportDates = {
  sourceFetchedAt: "2026-10-08T00:00:00Z", endExclusive: "2026-10-08T00:00:00Z",
};
