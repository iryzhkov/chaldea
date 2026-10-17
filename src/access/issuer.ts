import { createPrivateKey, createPublicKey, randomBytes } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { openSync, fstatSync, readFileSync, closeSync, constants, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { SignJWT } from "jose";
import {
  MAX_TOKEN_SECONDS, MAX_SKEW_SECONDS, TOKEN_TYPE, issuerName, identifier, requireAccess,
  validateClaims, allows, checkTime,
} from "./token.ts";
import type { Audience, Grant, RunClaims } from "./token.ts";
import type { Clock, TrustStore } from "./trust.ts";

export interface TokenGrant { audience: Audience; grants: Grant[]; source?: string }
export interface MintRequest extends TokenGrant { profile: string; project: string; runId: string; expiresAt: number }

/** Existing, operator-provisioned key only; never generates a key or searches env/keyrings.
 * Parent directory and file are owned by the issuer UID, inaccessible to run UIDs. */
export function loadHostSigningKey(path: string): KeyObject {
  requireAccess(isAbsolute(path), "absolute_key_path_required");
  const dir = lstatSync(dirname(path));
  requireAccess(dir.isDirectory() && !dir.isSymbolicLink() && dir.uid === process.geteuid!() &&
    (dir.mode & 0o077) === 0, "unsafe_key_directory");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireAccess(stat.isFile() && stat.uid === process.geteuid!() && (stat.mode & 0o077) === 0 &&
      stat.size <= 8192 && stat.nlink === 1, "unsafe_key_file");
    const key = createPrivateKey(readFileSync(fd));
    requireAccess(key.asymmetricKeyType === "ed25519", "invalid_signer");
    return key;
  } finally { closeSync(fd); }
}
/** Trusted host-side primitive. RunLeases admits scheduled runs; the token helper
 * admits fixed service producers by sudo UID and operator-owned grants.
 * Never expose raw mint requests to a sandbox or a general CLI. */
export class HostIssuer {
  private readonly privateKey: KeyObject;
  readonly publicX: string;
  readonly issuer: string;
  readonly kid: string;
  readonly trust: TrustStore;
  readonly clock: Clock;
  constructor(issuer: string, kid: string, privateKey: KeyObject, trust: TrustStore, clock: Clock) {
    this.issuer = issuer; this.kid = kid; this.trust = trust; this.clock = clock;
    issuerName(issuer); identifier(kid);
    requireAccess(clock === trust.clock && privateKey.type === "private" &&
      privateKey.asymmetricKeyType === "ed25519", "invalid_signer");
    this.privateKey = privateKey;
    this.publicX = createPublicKey(privateKey).export({ format: "jwk" }).x!;
  }
  async mint(request: MintRequest, lifetime = MAX_TOKEN_SECONDS): Promise<string> {
    requireAccess(Number.isInteger(lifetime) && lifetime > 0 && lifetime <= MAX_TOKEN_SECONDS, "invalid_lifetime");
    request = structuredClone(request);
    const bundle = await this.trust.snapshot();
    const now = this.clock.check();
    const key = bundle.keys.find(k => k.issuer === this.issuer && k.kid === this.kid && k.public_key.x === this.publicX);
    requireAccess(key, "unknown_signer");
    // Fresh trust is required to mint, but does not shorten the bearer lifetime:
    // every verifier independently checks its current trust lease.
    const exp = Math.min(now + lifetime, request.expiresAt, key.verify_until - MAX_SKEW_SECONDS);
    const claims: RunClaims = validateClaims({
      v: 1, iss: this.issuer, sub: request.profile, aud: request.audience, run_id: request.runId,
      project: request.project, iat: now, nbf: now, exp, jti: randomBytes(16).toString("base64url"),
      grants: structuredClone(request.grants),
      ...(request.source === undefined ? {} : { source: request.source, host: this.issuer.slice("chaldea:".length) }),
    });
    checkTime(claims, key, now, 0); requireAccess(allows(claims, key), "issuer_ceiling");
    const token = await new SignJWT({ ...claims }).setProtectedHeader({ alg: "EdDSA", typ: TOKEN_TYPE, kid: this.kid })
      .sign(this.privateKey);
    this.trust.assertCurrent(bundle.sequence); checkTime(claims, key, this.clock.check(), 0);
    return token;
  }
}
