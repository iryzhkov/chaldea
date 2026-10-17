import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, openSync, closeSync, constants } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { compactVerify, CompactSign, importJWK } from "jose";
import type { KeyObject } from "node:crypto";
import {
  MAX_TOKEN_SECONDS, MAX_SKEW_SECONDS, compactParts, strictJson, exact, object, requireAccess,
  identifier, issuerName, seconds, audienceName, grants,
} from "./token.ts";
import type { Audience, Grant } from "./token.ts";

export const TRUST_TYPE = "chaldea-trust+jws";
export const TRUST_FRESH_SECONDS = 24 * 60 * 60;
export const TRUST_POLL_SECONDS = 120;
export interface PublicKey { kty: "OKP"; crv: "Ed25519"; x: string }
export interface Ceiling { audience: Audience; profile: string; project: string; grants: Grant[]; source?: string }
export interface TrustedKey {
  issuer: string; kid: string; public_key: PublicKey;
  not_before: number; issue_until: number; verify_until: number; ceilings: Ceiling[];
}
export interface TrustBundle { v: 1; sequence: number; published_at: number; expires_at: number; keys: TrustedKey[] }
export interface TrustAnchor { kid: string; public_key: PublicKey }

/** Only trusted host processes may open this directory. FULL synchronous SQLite commits
 * make revocation and high-water marks durable; SQLite serializes competing processes. */
export class AccessState {
  readonly db: DatabaseSync;
  constructor(path: string, options: { initialize?: boolean } = {}) {
    requireAccess(isAbsolute(path), "absolute_state_path_required");
    if (options.initialize === true) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const dir = lstatSync(dirname(path));
    requireAccess(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.geteuid!() &&
      (dir.mode & 0o077) === 0, "unsafe_state_directory");
    const create = options.initialize === true ? constants.O_CREAT | constants.O_EXCL : 0;
    const fd = openSync(path, create | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
    closeSync(fd);
    const stat = lstatSync(path);
    requireAccess(stat.isFile() && stat.uid === process.geteuid!() && (stat.mode & 0o077) === 0, "unsafe_state");
    requireAccess(options.initialize === true || stat.size > 0, "uninitialized_state");
    this.db = new DatabaseSync(path);
    try {
      // Set the busy handler before any statement that can encounter another writer.
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;");
      if (options.initialize === true) {
        this.db.exec("PRAGMA journal_mode=DELETE");
        this.transaction(() => {
          this.db.exec("CREATE TABLE access_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
          this.put("format", "chaldea-access-state-v1");
        });
      } else {
        // Reopening never creates a schema or repairs erased state. Acquire the write
        // lock before schema reads, avoiding SQLite's non-waiting read-to-write upgrade.
        this.transaction(() => {
          requireAccess(this.get("format") === "chaldea-access-state-v1", "invalid_state_format");
          const mode = this.db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
          requireAccess(mode.journal_mode === "delete", "invalid_journal_mode");
        });
      }
    } catch (error) { this.db.close(); throw error; }
  }
  get(name: string): string | undefined {
    return (this.db.prepare("SELECT value FROM access_meta WHERE name=?").get(name) as { value: string } | undefined)?.value;
  }
  put(name: string, value: string): void {
    this.db.prepare("INSERT INTO access_meta VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(name, value);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close(): void { this.db.close(); }
}
export interface ClockSample {
  unixSeconds: number; monotonicSeconds: number; bootId: string;
  /** Supplied by host time-health monitoring, never a model or token. Unknown = false. */
  healthy: boolean; offsetSeconds: number;
}
export class Clock {
  readonly state: AccessState;
  readonly sample: () => ClockSample;
  constructor(state: AccessState, sample: () => ClockSample) { this.state = state; this.sample = sample; }
  check(): number {
    return this.state.transaction(() => {
      // Sample only after acquiring the write lock. Another process may have committed
      // a newer sample while we waited; an earlier sample would falsely look like rollback.
      const s = this.sample();
      seconds(s.unixSeconds);
      requireAccess(s.healthy === true && Number.isFinite(s.offsetSeconds) && Math.abs(s.offsetSeconds) <= 30 &&
        Number.isFinite(s.monotonicSeconds) && s.monotonicSeconds >= 0 &&
        typeof s.bootId === "string" && s.bootId.length > 0, "clock_unhealthy");
      const saved = this.state.get("clock");
      let anchorUnixSeconds = s.unixSeconds, anchorMonotonicSeconds = s.monotonicSeconds;
      if (saved !== undefined) {
        const previous = JSON.parse(saved) as ClockSample & { anchorUnixSeconds: number; anchorMonotonicSeconds: number };
        requireAccess(s.unixSeconds >= previous.unixSeconds, "clock_rollback");
        if (s.bootId === previous.bootId) {
          anchorUnixSeconds = previous.anchorUnixSeconds;
          anchorMonotonicSeconds = previous.anchorMonotonicSeconds;
          // Compare with a boot anchor, not only the previous call: frequent requests
          // must not hide a frozen or slowly regressing wall clock.
          requireAccess(s.monotonicSeconds >= previous.monotonicSeconds &&
            s.unixSeconds - anchorUnixSeconds + MAX_SKEW_SECONDS >= s.monotonicSeconds - anchorMonotonicSeconds, "clock_rollback");
        }
      }
      this.state.put("clock", JSON.stringify({ ...s, anchorUnixSeconds, anchorMonotonicSeconds }));
      return s.unixSeconds;
    });
  }
}
export function publicKey(value: unknown): asserts value is PublicKey {
  const k = object(value); exact(k, ["kty", "crv", "x"]);
  requireAccess(k.kty === "OKP" && k.crv === "Ed25519" && typeof k.x === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(k.x) && Buffer.from(k.x, "base64url").toString("base64url") === k.x, "invalid_public_key");
}
export function validateBundle(value: unknown): TrustBundle {
  const b = object(value); exact(b, ["v", "sequence", "published_at", "expires_at", "keys"]);
  requireAccess(b.v === 1, "invalid_bundle_version"); seconds(b.sequence);
  requireAccess(b.sequence > 0, "invalid_sequence"); seconds(b.published_at); seconds(b.expires_at);
  requireAccess(b.expires_at > b.published_at && b.expires_at - b.published_at <= TRUST_FRESH_SECONDS, "invalid_freshness");
  requireAccess(Array.isArray(b.keys) && b.keys.length <= 128, "invalid_keys");
  const ids = new Set<string>();
  for (const item of b.keys) {
    const k = object(item); exact(k, ["issuer", "kid", "public_key", "not_before", "issue_until", "verify_until", "ceilings"]);
    issuerName(k.issuer); identifier(k.kid); publicKey(k.public_key);
    const id = k.issuer + "/" + k.kid; requireAccess(!ids.has(id), "duplicate_key"); ids.add(id);
    seconds(k.not_before); seconds(k.issue_until); seconds(k.verify_until);
    requireAccess(k.not_before < k.issue_until && k.issue_until <= k.verify_until &&
      k.verify_until - k.issue_until <= MAX_TOKEN_SECONDS + MAX_SKEW_SECONDS, "invalid_key_window");
    requireAccess(Array.isArray(k.ceilings) && k.ceilings.length > 0 && k.ceilings.length <= 64, "invalid_ceilings");
    for (const value of k.ceilings) {
      const c = object(value); exact(c, ["audience", "profile", "project", "grants"], ["source"]);
      audienceName(c.audience); identifier(c.profile); identifier(c.project); grants(c.grants);
      if (c.audience === "feed" || c.audience === "akasha") identifier(c.source);
      else requireAccess(c.source === undefined, "unexpected_source");
    }
  }
  return b as unknown as TrustBundle;
}
interface KeyHistory { x: string; not_before: number; issue_until: number; verify_until: number; removed: boolean }
export class TrustStore {
  readonly anchors: TrustAnchor[];
  readonly state: AccessState;
  readonly clock: Clock;
  constructor(state: AccessState, clock: Clock, anchors: TrustAnchor[]) {
    this.state = state; this.clock = clock;
    requireAccess(state === clock.state && anchors.length > 0 && anchors.length <= 8, "invalid_trust_store");
    this.anchors = structuredClone(anchors);
    const ids = new Set<string>();
    for (const a of this.anchors) {
      identifier(a.kid); publicKey(a.public_key);
      requireAccess(!ids.has(a.kid), "duplicate_anchor"); ids.add(a.kid);
    }
  }
  private async authenticate(envelope: string): Promise<TrustBundle> {
    const { header, payload } = compactParts(envelope, 262144);
    exact(header, ["alg", "typ", "kid"]);
    requireAccess(header.alg === "EdDSA" && header.typ === TRUST_TYPE, "invalid_trust_header");
    const anchor = this.anchors.find(a => a.kid === header.kid); requireAccess(anchor, "unknown_anchor");
    await compactVerify(envelope, await importJWK(anchor.public_key, "EdDSA"), { algorithms: ["EdDSA"] });
    const bundle = validateBundle(strictJson(payload, true));
    requireAccess(bundle.keys.every(k => !this.anchors.some(a => a.public_key.x === k.public_key.x)), "issuer_is_trust_anchor");
    return bundle;
  }
  private fresh(bundle: TrustBundle): void {
    const now = this.clock.check();
    // No freshness leeway: publisher failure cannot extend trust.
    requireAccess(bundle.published_at <= now + MAX_SKEW_SECONDS && now < bundle.expires_at, "stale_trust");
  }
  async install(envelope: string): Promise<void> {
    const bundle = await this.authenticate(envelope); this.fresh(bundle);
    this.state.transaction(() => {
      const raw = this.state.get("trust");
      const old = raw === undefined ? undefined : JSON.parse(raw) as { sequence: number; envelope: string };
      requireAccess(!old || bundle.sequence > old.sequence || (bundle.sequence === old.sequence && envelope === old.envelope), "trust_rollback");
      if (old && envelope === old.envelope) return;
      const history = JSON.parse(this.state.get("key_history") ?? "{}") as Record<string, KeyHistory>;
      const next = new Set(bundle.keys.map(k => k.issuer + "/" + k.kid));
      for (const [id, h] of Object.entries(history)) if (!next.has(id)) h.removed = true;
      for (const k of bundle.keys) {
        const id = k.issuer + "/" + k.kid; const h = history[id];
        requireAccess(Object.entries(history).every(([otherId, other]) =>
          otherId === id || other.x !== k.public_key.x), "key_material_reused");
        requireAccess(!h || (!h.removed && h.x === k.public_key.x && h.not_before === k.not_before &&
          k.issue_until <= h.issue_until && k.verify_until <= h.verify_until), "key_reactivation");
        history[id] = { x: k.public_key.x, not_before: k.not_before, issue_until: k.issue_until, verify_until: k.verify_until, removed: false };
      }
      // Bounded durable tombstones; at capacity park for operator epoch migration, never forget removals.
      requireAccess(Object.keys(history).length <= 4096, "key_history_full");
      this.state.put("key_history", JSON.stringify(history));
      this.state.put("trust", JSON.stringify({ sequence: bundle.sequence, envelope }));
    });
  }
  async snapshot(): Promise<TrustBundle> {
    const raw = this.state.get("trust"); requireAccess(raw, "missing_trust");
    const saved = JSON.parse(raw) as { sequence: number; envelope: string };
    const bundle = await this.authenticate(saved.envelope); this.fresh(bundle);
    requireAccess(this.state.get("trust") === raw, "trust_changed");
    return bundle;
  }
  assertCurrent(sequence: number): void {
    const raw = this.state.get("trust"); requireAccess(raw, "missing_trust");
    const saved = JSON.parse(raw) as { sequence: number; envelope: string };
    requireAccess(saved.sequence === sequence, "trust_changed");
    const payload = compactParts(saved.envelope, 262144).payload;
    this.fresh(validateBundle(strictJson(payload, true)));
  }
}
/** Publisher-side library only. The separate deployment key must never be on a run issuer. */
export async function signTrustBundle(bundle: TrustBundle, kid: string, privateKey: KeyObject): Promise<string> {
  validateBundle(bundle); identifier(kid);
  requireAccess(privateKey.type === "private" && privateKey.asymmetricKeyType === "ed25519", "invalid_signer");
  return new CompactSign(new TextEncoder().encode(JSON.stringify(bundle)))
    .setProtectedHeader({ alg: "EdDSA", typ: TRUST_TYPE, kid }).sign(privateKey);
}
