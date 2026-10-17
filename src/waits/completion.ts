import type { WaitSnapshot, WaitRun } from "../t3/waits.ts";
import type { Outcome } from "./types.ts";

const LIVE = new Set(["preparing","queued","starting","running","waiting","pending","idle"]);
export function completion(snapshot: WaitSnapshot, pinnedRun: string): Outcome | null {
  const root = snapshot.runs.find(r => r.id === pinnedRun);
  if (!root) return null; // A compacted/missing run needs attention; it is never success.
  const cohort = new Set([root.id]);
  // workStartedAt is T3's public work lineage for quota/provider-switch/delegated wakes.
  const anchor = root.workStarted ?? root.started;
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of snapshot.runs) {
      if (!cohort.has(r.id) && ((r.restartOf && cohort.has(r.restartOf)) || (r.continuationOf && cohort.has(r.continuationOf)) ||
        (anchor !== null && r.workStarted === anchor))) { cohort.add(r.id); grew=true; }
    }
  }
  const runs = snapshot.runs.filter(r => cohort.has(r.id)).sort((a,b) => a.ordinal-b.ordinal);
  const latest = runs.at(-1) as WaitRun;
  if (runs.some(r => LIVE.has(r.status))) return null;
  if (snapshot.pendingRuns.some(r => r !== null && cohort.has(r))) return null;
  if (latest.failure === "usage_limit") return null;
  if (snapshot.children.some(c => c.runId !== null && cohort.has(c.runId) && (LIVE.has(c.status) || c.delivery === "pending" || c.delivery === "claimed"))) return null;
  // A native child's completion wake may be queued but not yet run. Wait until the cohort closes.
  if (latest.status === "completed") return {reason:"completed",runId:latest.id};
  if (["failed","interrupted","cancelled","rolled_back"].includes(latest.status)) return {reason:latest.status,runId:latest.id};
  return null;
}
