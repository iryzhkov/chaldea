import { compactVerify, createLocalJWKSet } from "jose";
import type { JSONWebKeySet } from "jose";
import { identifier, object, segment, strictJson } from "../access/token.ts";
import { ensure } from "./schema.ts";

export interface AuthentikConfig {
  issuer: string; audience: string; jwksUrl: string; jwksTtlSeconds?: number | undefined;
}
export interface HostToken {
  iat: number; nbf: number; exp: number; host: string; runId: string; source: string | undefined; validUntil: number;
  checkCurrent(): void;
}
/** The JWT source is a selector, never a grant. Registry entries supply all authority. */
export class AuthentikVerifier {
  private keys: JSONWebKeySet = { keys: [] };
  private fetchedAt = -Infinity;
  private refreshFinishedAt = -Infinity;
  private pending: Promise<void> | undefined;
  private readonly ttl: number;
  private readonly config: AuthentikConfig;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly monotonic: () => number;
  constructor(config: AuthentikConfig, fetcher: typeof fetch = fetch,
    now: () => number = () => Date.now() / 1000,
    monotonic: () => number = () => performance.now() / 1000) {
    this.fetcher = fetcher; this.now = now; this.monotonic = monotonic;
    this.config = { ...config };
    for (const value of [config.issuer, config.audience, config.jwksUrl]) {
      const url = new URL(value);
      ensure(url.protocol === "https:" && !url.username && !url.password && !url.hash, "invalid_authentik_url");
    }
    this.ttl = config.jwksTtlSeconds ?? 60;
    // The cache TTL may not be shorter than the 30 s refresh cooldown, or the
    // expiry refresh would be refused and cached keys rejected each cycle.
    ensure(Number.isInteger(this.ttl) && this.ttl >= 30 && this.ttl <= 300, "invalid_jwks_ttl");
  }
  private async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    ensure(this.monotonic() - this.refreshFinishedAt >= 30, "jwks_refresh_cooldown", 401);
    this.pending = (async () => {
      const response = await this.fetcher(this.config.jwksUrl, {
        redirect: "error", signal: AbortSignal.timeout(5000), headers: { accept: "application/json" },
      });
      ensure(response.ok && response.body, "jwks_unavailable", 401);
      const chunks: Uint8Array[] = []; let size = 0;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.length; ensure(size <= 262144, "jwks_too_large", 401); chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      const body = object(strictJson(Buffer.concat(chunks)));
      ensure(Array.isArray(body.keys) && body.keys.length <= 128, "invalid_jwks", 401);
      this.keys = { keys: body.keys.map(object).filter(k =>
        k.kty === "RSA" && k.use === "sig" && (k.alg === undefined || k.alg === "RS256") && k.d === undefined) };
      // One reading for cache age and cooldown, so a TTL of at least the
      // cooldown can never expire the cache while the cooldown still runs.
      const now = this.monotonic();
      this.fetchedAt = now;
      this.refreshFinishedAt = now;
    })().catch((error: unknown) => {
      // Failed fetches also start the cooldown, bounding retries.
      this.refreshFinishedAt = this.monotonic();
      throw error;
    }).finally(() => {
      this.pending = undefined;
    });
    await this.pending;
  }
  async verify(token: string): Promise<HostToken> {
    ensure(Buffer.byteLength(token) <= 16384, "invalid_token", 401);
    const parts = token.split(".");
    ensure(parts.length === 3 && parts.every(Boolean), "invalid_token", 401);
    const header = object(strictJson(segment(parts[0]!), true));
    ensure(header.alg === "RS256" && typeof header.kid === "string" && header.kid.length <= 128,
      "invalid_jwt_header", 401);
    if (this.monotonic() - this.fetchedAt >= this.ttl) await this.refresh();
    if (!this.keys.keys.some(k => k.kid === header.kid)) await this.refresh();
    await compactVerify(token, createLocalJWKSet(this.keys), { algorithms: ["RS256"] });
    const c = object(strictJson(segment(parts[1]!), true));
    ensure(c.iss === this.config.issuer, "wrong_issuer", 401);
    // A resource token must have exactly this audience, not a multi-resource audience.
    ensure(c.aud === this.config.audience ||
      (Array.isArray(c.aud) && c.aud.length === 1 && c.aud[0] === this.config.audience), "wrong_audience", 401);
    for (const key of ["iat", "exp", ...(c.nbf === undefined ? [] : ["nbf"])])
      ensure(Number.isSafeInteger(c[key]) && (c[key] as number) >= 0, "invalid_jwt_time", 401);
    const iat = c.iat as number, nbf = (c.nbf ?? c.iat) as number, exp = c.exp as number;
    ensure(nbf >= iat && exp > nbf && exp - iat <= 300, "invalid_jwt_lifetime", 401);
    const checkCurrent = () => {
      const now = this.now();
      ensure(iat <= now + 60 && nbf <= now + 60 && now < exp + 60, "token_time", 401);
    };
    checkCurrent();
    identifier(c.host);
    const username = c.preferred_username ?? c.sub;
    ensure(username === "chaldea-" + c.host && typeof c.sub === "string" && c.sub.length > 0 &&
      (!c.sub.startsWith("chaldea-") || c.sub === username), "host_subject_mismatch", 401);
    if (c.source !== undefined) identifier(c.source);
    identifier(c.run_id);
    return { iat, nbf, exp, host: c.host, runId: c.run_id, source: c.source as string | undefined,
      validUntil: exp + 60, checkCurrent };
  }
}
