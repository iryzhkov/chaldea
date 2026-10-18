import { compactParts, strictJson, validateClaims, verifyToken } from "../access/token.ts";
import type { VerifiedAccess } from "../access/token.ts";
import type { Clock, TrustStore } from "../access/trust.ts";
import { ensure, KINDS, record, fields, text } from "./schema.ts";
import type { Identity, Kind } from "./schema.ts";

export interface Registration {
  issuer: string; source: string; host: string; source_id: string;
  profile: string; project: string; mode: "report" | "service" | "operator";
  kinds: Kind[]; mission_control_read_sources?: string[]; route_scores_read?: boolean; quota_fleet_read?: boolean; global_read?: boolean; roots?: string[];
}
export interface Scope { issuer: string; profile: string; project: string; source: string; host: string; global: boolean; quotaFleet?: boolean; routeScores?: boolean; missionControlSources?: string[] }
export interface Principal {
  identity: Identity; scope: Scope; registration: Registration; access: VerifiedAccess;
  recheck(): Promise<void>;
  checkCommit(): void;
}
export class Authorization {
  readonly registry: readonly Registration[];
  readonly trust: TrustStore;
  readonly clock: Clock;
  constructor(registry: Registration[], trust: TrustStore, clock: Clock) {
    ensure(Array.isArray(registry) && registry.length > 0 && registry.length <= 1024, "invalid_registry");
    const ids = new Set<string>(), identities = new Set<string>();
    for (const entry of registry) {
      const e = record(entry);
      fields(e, ["issuer", "source", "host", "source_id", "profile", "project", "mode", "kinds", "global_read", "route_scores_read", "quota_fleet_read", "mission_control_read_sources", "roots"]);
      for (const k of ["issuer", "source", "host", "profile", "project"]) text(e[k], 128, true);
      ensure(entry.issuer === "chaldea:" + entry.host, "registry_host_mismatch");
      ensure(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(entry.source_id) && entry.source_id !== "legacy-feed" &&
        !ids.has(entry.source_id), "duplicate_or_invalid_source_id");
      const key = JSON.stringify([entry.issuer, entry.source, entry.host]);
      ensure(!identities.has(key), "duplicate_registry_identity"); identities.add(key); ids.add(entry.source_id);
      ensure(["report", "service", "operator"].includes(entry.mode) &&
        Array.isArray(entry.kinds) && entry.kinds.length > 0 && entry.kinds.every(k => KINDS.includes(k)), "invalid_registry");
      ensure(entry.route_scores_read === undefined || (entry.route_scores_read === true && entry.mode === "service" && entry.source === "route"), "invalid_route_scores_read");
      ensure(entry.quota_fleet_read === undefined || (entry.quota_fleet_read === true && entry.mode === "service" && entry.source === "quota"), "invalid_quota_fleet_read");
      ensure(entry.global_read === undefined || (entry.global_read === true && entry.mode === "operator"), "invalid_global_read");
      ensure(entry.roots === undefined || (Array.isArray(entry.roots) && entry.roots.length <= 32 &&
        entry.roots.every(r => typeof r === "string" && r.startsWith("/") && r.length <= 512)), "invalid_roots");
    }
    const publishers = registry.filter(e => e.profile === "mission-control-publisher");
    ensure(publishers.length <= 4, "mission_control_source_limit");
    for (const entry of registry) if (entry.mission_control_read_sources !== undefined) {
      const sources=entry.mission_control_read_sources;
      ensure(entry.mode==="service"&&entry.profile==="mission-control-reader"&&entry.project==="chaldea"&&entry.source==="mission-control-reader"&&entry.host==="omarchy-normandy"&&entry.kinds.length===1&&entry.kinds[0]==="agent_status"&&!entry.global_read&&!entry.quota_fleet_read&&!entry.route_scores_read, "invalid_mission_control_reader");
      ensure(Array.isArray(sources)&&sources.length>0&&sources.length<=4&&new Set(sources).size===sources.length&&sources.every(id=>typeof id==="string"&&publishers.some(p=>p.source_id===id&&p.mode==="service"&&p.project==="chaldea"&&p.issuer==="chaldea:"+p.host&&p.source===p.host+".mission-control"&&p.source_id===p.host+"--mission-control"&&p.kinds.length===1&&p.kinds[0]==="agent_status")), "invalid_mission_control_sources");
    }
    this.registry = structuredClone(registry); this.trust = trust; this.clock = clock;
  }
  async authorize(token: string, action: "append" | "read"): Promise<Principal> {
    ensure(Buffer.byteLength(token) <= 16384, "invalid_token", 401);
    // Unverified source is only a selector for package C; no identity is used until verification.
    const hint = validateClaims(strictJson(compactParts(token).payload, true));
    ensure(typeof hint.source === "string", "missing_source", 401);
    const access = await verifyToken(token, { audience: "akasha", resource: hint.source, action }, this.trust, this.clock);
    const c = access.claims;
    const r = this.registry.find(r => r.issuer === c.iss && r.source === c.source && r.host === c.host &&
      r.profile === c.sub && r.project === c.project);
    ensure(r, "unregistered_source", 403);
    ensure(action !== "append" || r.mission_control_read_sources === undefined, "read_only", 403);
    ensure(c.grants.every(g => g.resource === c.source), "source_grant_mismatch", 403);
    ensure(action !== "read" || r.mode !== "report", "append_only", 403);
    const identity: Identity = { issuer: c.iss, profile: c.sub, project: c.project, source: c.source!,
      host: c.host!, source_id: r.source_id, run_id: c.run_id };
    const clock = this.clock, trust = this.trust;
    let sequence: number | undefined;
    return { identity, registration: r, access,
      scope: { ...(action === "read" && r.mission_control_read_sources ? { missionControlSources: [...r.mission_control_read_sources] } : {}), issuer: c.iss, profile: c.sub, project: c.project, source: c.source!, host: c.host!, global: r.global_read === true, routeScores: action === "read" && r.route_scores_read === true, quotaFleet: action === "read" && r.quota_fleet_read === true },
      async recheck() {
        const bundle = await trust.snapshot(); await access.recheck(); trust.assertCurrent(bundle.sequence);
        ensure(clock.check() < access.validUntil, "expired", 401); sequence = bundle.sequence;
      },
      checkCommit() { ensure(sequence !== undefined, "recheck_required", 401); trust.assertCurrent(sequence);
        ensure(clock.check() < access.validUntil, "expired", 401); },
    };
  }
  validateDelivery(event: import("./schema.ts").Envelope): void {
    if (event.provenance.type === "legacy-feed") return;
    const r = this.registry.find(r => r.source_id === event.source_id);
    ensure(r && r.issuer === event.issuer && r.profile === event.profile && r.project === event.project &&
      r.source === event.source && r.host === event.host && r.kinds.includes(event.kind), "broker_registry_mismatch", 403);
    if (event.data.root !== undefined) ensure(r.roots?.includes(event.data.root as string), "root_forbidden", 403);
  }
}
export function ownedKind(principal: Principal, kind: Kind, data: Record<string, unknown>): void {
  if (principal.identity.profile === "mission-control-publisher") ensure(kind === "agent_status" && data.snapshot !== undefined, "snapshot_required", 403);
  ensure(principal.registration.kinds.includes(kind), "kind_forbidden", 403);
  if (data.root !== undefined) ensure(principal.registration.roots?.includes(data.root as string), "root_forbidden", 403);
}
