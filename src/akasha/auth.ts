import { decodeProtectedHeader } from "jose";
import type { AuthentikVerifier } from "./authentik.ts";
import { compactParts, strictJson, validateClaims, verifyToken } from "../access/token.ts";
import type { VerifiedAccess } from "../access/token.ts";
import type { Clock, TrustStore } from "../access/trust.ts";
import { ensure, KINDS, record, fields, text } from "./schema.ts";
import type { Identity, Kind } from "./schema.ts";

export interface Registration {
  issuer: string; source: string; host: string; source_id: string;
  profile: string; project: string; mode: "report" | "service" | "operator";
  revoked?: boolean; kinds: Kind[]; route_scores_read?: boolean; global_read?: boolean; roots?: string[];
}
export interface Scope { issuer: string; profile: string; project: string; source: string; host: string; global: boolean; routeScores?: boolean }
export interface Principal {
  identity: Identity; scope: Scope; registration: Registration; access: VerifiedAccess;
  now?(): number;
  recheck(): Promise<void>;
  checkCommit(): void;
}
export class Authorization {
  readonly registry: readonly Registration[];
  readonly trust: TrustStore;
  readonly clock: Clock;
  private readonly authentik: AuthentikVerifier | undefined;
  constructor(registry: Registration[], trust: TrustStore, clock: Clock, authentik?: AuthentikVerifier) {
    ensure(Array.isArray(registry) && registry.length > 0 && registry.length <= 1024, "invalid_registry");
    const ids = new Set<string>(), identities = new Set<string>();
    for (const entry of registry) {
      const e = record(entry);
      fields(e, ["issuer", "source", "host", "source_id", "profile", "project", "mode", "kinds", "global_read", "route_scores_read", "quota_fleet_read", "roots", "revoked"]);
      for (const k of ["issuer", "source", "host", "profile", "project"]) text(e[k], 128, true);
      ensure(entry.issuer === "chaldea:" + entry.host, "registry_host_mismatch");
      ensure(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(entry.source_id) && entry.source_id !== "legacy-feed" &&
        !ids.has(entry.source_id), "duplicate_or_invalid_source_id");
      const key = JSON.stringify([entry.issuer, entry.source, entry.host]);
      ensure(!identities.has(key), "duplicate_registry_identity"); identities.add(key); ids.add(entry.source_id);
      ensure(["report", "service", "operator"].includes(entry.mode) &&
        Array.isArray(entry.kinds) && entry.kinds.length > 0 && entry.kinds.every(k => KINDS.includes(k)), "invalid_registry");
      ensure(entry.route_scores_read === undefined || (entry.route_scores_read === true && entry.mode === "service" && entry.source === "route"), "invalid_route_scores_read");
      ensure(entry.revoked === undefined || typeof entry.revoked === "boolean", "invalid_revoked");
      // Ignore quota_fleet_read until enrollment stops emitting it; it grants nothing.
      ensure(e.quota_fleet_read === undefined || typeof e.quota_fleet_read === "boolean", "invalid_quota_fleet_read");
      ensure(entry.global_read === undefined || (entry.global_read === true && entry.mode === "operator"), "invalid_global_read");
      ensure(entry.roots === undefined || (Array.isArray(entry.roots) && entry.roots.length <= 32 &&
        entry.roots.every(r => typeof r === "string" && r.startsWith("/") && r.length <= 512)), "invalid_roots");
    }
    this.authentik = authentik;
    this.registry = structuredClone(registry); this.trust = trust; this.clock = clock;
  }
  async authorize(token: string, action: "append" | "read", source?: string): Promise<Principal> {
    ensure(Buffer.byteLength(token) <= 16384, "invalid_token", 401);
    // Format chooses exactly one verifier; a failed JWT never falls back to PKI.
    if (decodeProtectedHeader(token).typ !== "chaldea-run+jwt") {
      ensure(this.authentik, "authentik_disabled", 401);
      const proof = await this.authentik.verify(token);
      const selected = source ?? proof.source;
      ensure(selected && (!proof.source || proof.source === selected), "missing_or_mismatched_source", 403);
      const r = this.registry.find(r => r.host === proof.host && r.source === selected);
      ensure(r && !this.registry.some(e => e.host === proof.host && e.revoked), "unregistered_source", 403);
      ensure(action !== "read" || r.mode !== "report", "append_only", 403);
      let checked = false;
      return {
        identity: { issuer: r.issuer, profile: r.profile, project: r.project, source: r.source,
          host: r.host, source_id: r.source_id, run_id: proof.runId },
        scope: { issuer: r.issuer, profile: r.profile, project: r.project, source: r.source,
          host: r.host, global: r.global_read === true, routeScores: action === "read" && r.route_scores_read === true },
        registration: r, now: () => Math.floor(Date.now() / 1000),
        // Normalized compatibility view; verification retains its own immutable proof.
        access: { claims: { v: 1, iss: r.issuer, sub: r.profile, aud: "akasha", project: r.project,
          source: r.source, host: r.host, run_id: proof.runId, iat: proof.iat, nbf: proof.nbf, exp: proof.exp,
          jti: proof.runId, grants: [{ resource: r.source, actions: r.mode === "report" ? ["append"] : ["append", "read"] }] },
          validUntil: proof.validUntil, checkCurrent: proof.checkCurrent,
          async recheck() { proof.checkCurrent(); } },
        async recheck() { checked = false; proof.checkCurrent(); checked = true; },
        checkCommit() { ensure(checked, "recheck_required", 401); proof.checkCurrent(); },
      };
    }
    ensure(Buffer.byteLength(token) <= 16384, "invalid_token", 401);
    // Unverified source is only a selector for package C; no identity is used until verification.
    const hint = validateClaims(strictJson(compactParts(token).payload, true));
    ensure(typeof hint.source === "string", "missing_source", 401);
    const access = await verifyToken(token, { audience: "akasha", resource: hint.source, action }, this.trust, this.clock);
    const c = access.claims;
    const r = this.registry.find(r => r.issuer === c.iss && r.source === c.source && r.host === c.host &&
      r.profile === c.sub && r.project === c.project);
    ensure(r, "unregistered_source", 403);
    ensure(c.grants.every(g => g.resource === c.source), "source_grant_mismatch", 403);
    ensure(action !== "read" || r.mode !== "report", "append_only", 403);
    const identity: Identity = { issuer: c.iss, profile: c.sub, project: c.project, source: c.source!,
      host: c.host!, source_id: r.source_id, run_id: c.run_id };
    let checked = false;
    return { identity, registration: r, access, now: () => this.clock.check(),
      scope: { issuer: c.iss, profile: c.sub, project: c.project, source: c.source!, host: c.host!, global: r.global_read === true, routeScores: action === "read" && r.route_scores_read === true },
      async recheck() {
        checked = false;
        access.checkCurrent(); checked = true;
      },
      checkCommit() { ensure(checked, "recheck_required", 401); access.checkCurrent(); },
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
  ensure(principal.registration.kinds.includes(kind), "kind_forbidden", 403);
  if (data.root !== undefined) ensure(principal.registration.roots?.includes(data.root as string), "root_forbidden", 403);
}
