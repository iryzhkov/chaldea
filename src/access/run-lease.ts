import { requireAccess, identifier, seconds, audienceName, grants, subset } from "./token.ts";
import type { Audience } from "./token.ts";
import type { AccessState, Clock } from "./trust.ts";
import type { HostIssuer, TokenGrant } from "./issuer.ts";

export const MAX_LEASE_RECORDS = 10000;
export const LEASE_RETENTION_SECONDS = 14 * 86400;
export interface RunAdmission {
  runId: string; profile: string; project: string; expiresAt: number; services: TokenGrant[];
}
interface LeaseRecord { admission: RunAdmission; status: "active" | "cancelled" | "ended"; revision: number }
function validateAdmission(value: RunAdmission, now: number): void {
  identifier(value.runId); identifier(value.profile); identifier(value.project); seconds(value.expiresAt);
  requireAccess(value.expiresAt > now && value.expiresAt <= now + 86400, "invalid_run_deadline");
  requireAccess(Array.isArray(value.services) && value.services.length > 0 && value.services.length <= 7, "invalid_services");
  const audiences = new Set<string>();
  for (const s of value.services) {
    audienceName(s.audience); grants(s.grants);
    requireAccess(!audiences.has(s.audience), "duplicate_audience"); audiences.add(s.audience);
    if (s.audience === "feed" || s.audience === "akasha") identifier(s.source);
    else requireAccess(s.source === undefined, "unexpected_source");
  }
}
function narrowing(next: RunAdmission, old: RunAdmission): boolean {
  return next.runId === old.runId && next.profile === old.profile && next.project === old.project &&
    next.expiresAt <= old.expiresAt && next.services.every(s => old.services.some(o =>
      s.audience === o.audience && s.source === o.source && subset(s.grants, o.grants)));
}
/** One instance per process may share the same durable DB with others. No background
 * resurrection: callers drive renew on host run lifecycle events/timers. */
export class RunLeases {
  readonly state: AccessState;
  readonly clock: Clock;
  constructor(state: AccessState, clock: Clock) {
    this.state = state; this.clock = clock;
    requireAccess(state === clock.state, "invalid_lease_store");
    state.transaction(() => state.db.exec(
      "CREATE TABLE IF NOT EXISTS access_runs (run_id TEXT PRIMARY KEY, body TEXT NOT NULL, deadline INTEGER NOT NULL)",
    ));
  }
  private get(runId: string): LeaseRecord {
    const row = this.state.db.prepare("SELECT body FROM access_runs WHERE run_id=?").get(runId) as { body: string } | undefined;
    requireAccess(row, "unknown_run");
    return JSON.parse(row.body) as LeaseRecord;
  }
  private save(record: LeaseRecord): void {
    this.state.db.prepare("UPDATE access_runs SET body=?,deadline=? WHERE run_id=?")
      .run(JSON.stringify(record), record.admission.expiresAt, record.admission.runId);
  }
  admit(admission: RunAdmission): void {
    const now = this.clock.check(); validateAdmission(admission, now);
    this.state.transaction(() => {
      // Erase old grant payloads, retaining one-use run IDs to prevent resurrection.
      this.pruneWithin(now);
      const count = (this.state.db.prepare("SELECT count(*) AS n FROM access_runs").get() as { n: number }).n;
      requireAccess(count < MAX_LEASE_RECORDS, "lease_store_full");
      const old = this.state.db.prepare("SELECT run_id FROM access_runs WHERE run_id=?").get(admission.runId);
      requireAccess(!old, "run_already_admitted");
      // All run IDs are one-use, including after their grant payloads have been pruned.
      const record: LeaseRecord = { admission: structuredClone(admission), status: "active", revision: 1 };
      this.state.db.prepare("INSERT INTO access_runs VALUES (?,?,?)").run(admission.runId, JSON.stringify(record), admission.expiresAt);
    });
  }
  cancel(runId: string): void { this.stop(runId, "cancelled"); }
  end(runId: string): void { this.stop(runId, "ended"); }
  private stop(runId: string, status: "cancelled" | "ended"): void {
    identifier(runId);
    // Cancellation must still be possible with unhealthy clocks or stale trust.
    this.state.transaction(() => {
      const record = this.get(runId);
      if (record.status !== "active") return;
      record.status = status; record.revision++; this.save(record);
    });
  }
  async renew(
    runId: string, audience: Audience, issuer: HostIssuer,
    authorize: (admission: Readonly<RunAdmission>) => Promise<RunAdmission | null>,
  ): Promise<string> {
    requireAccess(issuer.clock === this.clock, "invalid_lease_issuer");
    const now = this.clock.check();
    const initial = this.get(runId);
    requireAccess(initial.status === "active" && now < initial.admission.expiresAt, "run_inactive");
    const authorized = await authorize(structuredClone(initial.admission));
    if (!authorized) { this.cancel(runId); throw new Error("run_not_authorized"); }
    const current = structuredClone(authorized);
    validateAdmission(current, this.clock.check());
    requireAccess(narrowing(current, initial.admission), "grant_expansion");
    const service = current.services.find(s => s.audience === audience);
    requireAccess(service, "audience_not_admitted");
    const token = await issuer.mint({ ...service, profile: current.profile, project: current.project,
      runId, expiresAt: current.expiresAt });
    const completedAt = this.clock.check();
    // Do not yield between the final cancellation/revision check, durable narrowing and
    // releasing the bearer. A concurrent cancellation during async work discards it.
    this.state.transaction(() => {
      const latest = this.get(runId);
      requireAccess(latest.status === "active" && latest.revision === initial.revision &&
        completedAt < latest.admission.expiresAt, "run_changed");
      latest.admission = structuredClone(current); latest.revision++; this.save(latest);
    });
    return token;
  }
  private pruneWithin(now: number): void {
    // Retain IDs forever, bounded by MAX_LEASE_RECORDS; erase old grants/identity data.
    // Capacity exhaustion parks admissions for operator epoch migration. Never evict a
    // cancellation tombstone and let an old admitted run be recreated.
    const rows = this.state.db.prepare("SELECT run_id,body FROM access_runs WHERE deadline<?")
      .all(now - LEASE_RETENTION_SECONDS) as Array<{ run_id: string; body: string }>;
    for (const row of rows) {
      const r = JSON.parse(row.body) as LeaseRecord;
      if (r.admission.services.length === 0) continue;
      r.status = r.status === "cancelled" ? "cancelled" : "ended";
      r.admission = { runId: row.run_id, profile: "expired", project: "expired", expiresAt: r.admission.expiresAt, services: [] };
      r.revision++; this.save(r);
    }
  }
  prune(): void { const now = this.clock.check(); this.state.transaction(() => this.pruneWithin(now)); }
}
