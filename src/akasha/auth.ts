import { compactParts, strictJson, validateClaims, verifyToken } from "../access/token.ts";
import type { VerifiedAccess } from "../access/token.ts";
import type { Clock, TrustStore } from "../access/trust.ts";
import { ensure, KINDS, record, fields, text } from "./schema.ts";
import type { Identity, Kind } from "./schema.ts";

export interface Registration {
  issuer: string; source: string; host: string; source_id: string;
  profile: string; project: string; mode: "report" | "service" | "operator";
  kinds: Kind[]; global_read?: boolean; roots?: string[];
}
export interface Scope { issuer: string; profile: string; project: string; source: string; host: string; global: boolean }
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
      fields(e, ["issuer", "source", "host", "source_id", "profile", "project", "mode", "kinds", "global_read", "roots"]);
      for (const k of ["issuer", "source", "host", "profile", "project"]) text(e[k], 128, true);
      ensure(entry.issuer === "chaldea:" + entry.host, "registry_host_mismatch");
      ensure(/^[a-z0-9][a-z0-9_-]{0,127}$/.test(entry.source_id) && entry.source_id !== "legacy-feed" &&
        !ids.has(entry.source_id), "duplicate_or_invalid_source_id");
      const key = JSON.stringify([entry.issuer, entry.source, entry.host]);
      ensure(!identities.has(key), "duplicate_registry_identity"); identities.add(key); ids.add(entry.source_id);
      ensure(["report", "service", "operator"].includes(entry.mode) &&
        Array.isArray(entry.kinds) && entry.kinds.length > 0 && entry.kinds.every(k => KINDS.includes(k)), "invalid_registry");
      ensure(entry.global_read === undefined || (entry.global_read === true && entry.mode === "operator"), "invalid_global_read");
      ensure(entry.roots === undefined || (Array.isArray(entry.roots) && entry.roots.length <= 32 &&
        entry.roots.every(r => typeof r === "string" && r.startsWith("/") && r.length <= 512)), "invalid_roots");
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
    ensure(c.grants.every(g => g.resource === c.source), "source_grant_mismatch", 403);
    ensure(action !== "read" || r.mode !== "report", "append_only", 403);
    const identity: Identity = { issuer: c.iss, profile: c.sub, project: c.project, source: c.source!,
      host: c.host!, source_id: r.source_id, run_id: c.run_id };
    const clock = this.clock, trust = this.trust;
    let sequence: number | undefined;
    return { identity, registration: r, access,
      scope: { issuer: c.iss, profile: c.sub, project: c.project, source: c.source!, host: c.host!, global: r.global_read === true },
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
  ensure(principal.registration.kinds.includes(kind), "kind_forbidden", 403);
  if (data.root !== undefined) ensure(principal.registration.roots?.includes(data.root as string), "root_forbidden", 403);
}
