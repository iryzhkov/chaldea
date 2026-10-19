import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { CompactSign } from "jose";
import { AccessState, Clock, TrustStore, signTrustBundle, TRUST_FRESH_SECONDS } from "../../src/access/trust.ts";
import type { TrustBundle, ClockSample } from "../../src/access/trust.ts";
import { Authorization } from "../../src/akasha/auth.ts";
import type { Registration } from "../../src/akasha/auth.ts";
import { EventStore } from "../../src/akasha/store.ts";
import type { Envelope, Input } from "../../src/akasha/schema.ts";
import { hash, eventId } from "../../src/akasha/schema.ts";

export const N = Math.floor(Date.now() / 1000);
export function scratch() {
  const root = process.env.CHALDEA_TEST_SCRATCH ?? process.env.TMPDIR;
  if (!root || root === "/tmp" || root.startsWith("/tmp/")) throw new Error("explicit disk scratch required");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = mkdtempSync(join(root, "akasha-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
export const registration: Registration = {
  issuer: "chaldea:agent-a", source: "chaldea.daily-health.agent-a", host: "agent-a",
  source_id: "agent-a-daily-health", profile: "daily-health", project: "homelab", mode: "report", kinds: ["report", "feed_post"],
};
export async function rig(mode: "report" | "service" | "operator" = "report", host = registration.host) {
  const dir = scratch(), issuer = generateKeyPairSync("ed25519"), deployment = generateKeyPairSync("ed25519");
  const publicKey = (key: typeof issuer.publicKey) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: key.export({ format: "jwk" }).x! });
  let state = new AccessState(join(dir.path, "access.db"), { initialize: true });
  let sample: ClockSample = { unixSeconds: N, monotonicSeconds: 100, bootId: "test-boot", healthy: true, offsetSeconds: 0 };
  let clock = new Clock(state, () => sample);
  const anchor = { kid: "deployment", public_key: publicKey(deployment.publicKey) };
  let trust = new TrustStore(state, clock, [anchor]);
  const r = { ...registration, host, issuer: "chaldea:" + host, mode, ...(mode === "operator" ? { global_read: true } : {}) };
  const bundle: TrustBundle = { v: 1, sequence: 1, published_at: N - 1, expires_at: N + TRUST_FRESH_SECONDS - 1,
    keys: [{ issuer: r.issuer, kid: "host-1", public_key: publicKey(issuer.publicKey),
      not_before: N - 3600, issue_until: N + 3600, verify_until: N + 4410,
      ceilings: [{ audience: "akasha", profile: r.profile, project: r.project, source: r.source,
        grants: [{ resource: r.source, actions: ["append", "read"] }] }] }] };
  await trust.install(await signTrustBundle(bundle, anchor.kid, deployment.privateKey));
  let auth = new Authorization([r], trust, clock);
  const storePath = join(dir.path, "events.db");
  let store = new EventStore(storePath, { initialize: true });
  const claims = { v: 1, iss: r.issuer, sub: r.profile, aud: "akasha", run_id: "run-1", project: r.project,
    source: r.source, host: r.host, iat: N, nbf: N, exp: N + 300, jti: "abcdefghijklmnopqrstuv",
    grants: [{ resource: r.source, actions: ["append"] }] };
  const token = async (overrides: Record<string, unknown> = {}) => new CompactSign(Buffer.from(JSON.stringify({ ...claims, ...overrides })))
    .setProtectedHeader({ alg: "EdDSA", typ: "chaldea-run+jwt", kid: "host-1" }).sign(issuer.privateKey);
  return { dir, r, bundle, issuer, deployment,
    get state() { return state; }, get clock() { return clock; }, get trust() { return trust; },
    get auth() { return auth; }, get store() { return store; },
    get sample() { return sample; }, set sample(s: ClockSample) { sample = s; }, token,
    async install(b: TrustBundle) { await trust.install(await signTrustBundle(b, anchor.kid, deployment.privateKey)); },
    restart() {
      state.close(); state = new AccessState(join(dir.path, "access.db"));
      clock = new Clock(state, () => sample); trust = new TrustStore(state, clock, [anchor]);
      auth = new Authorization([r], trust, clock); store.close(); store = new EventStore(storePath);
    },
    close() { store.close(); state.close(); dir.remove(); },
  };
}
export function event(i: number, kind: Envelope["kind"] = "feed_post", occurred = N): Envelope {
  const input: Input = { kind, title: "event " + i, body: "body", severity: "info", tags: ["test"], link: "", data: {}, occurred_at: null };
  return { ...input, v: 1, event_id: eventId(["fixture", String(i)]), source_id: registration.source_id,
    issuer: registration.issuer, profile: registration.profile, project: registration.project, source: registration.source,
    host: registration.host, run_id: "run-1", occurred_at: new Date(occurred * 1000).toISOString(), received_at: new Date(N * 1000).toISOString(),
    provenance: { type: "verified", request_hash: hash(input), feed_id: null } };
}
export function project(store: EventStore, now = N): void {
  let seq = store.cursor("nats");
  for (const row of store.pending(now, 1000)) store.project(JSON.parse(row.envelope), ++seq, now);
}
