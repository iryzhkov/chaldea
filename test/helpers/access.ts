import { generateKeyPairSync } from "node:crypto";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { AccessState, Clock, TrustStore, signTrustBundle } from "../../src/access/trust.ts";
import type { ClockSample, TrustBundle, TrustAnchor } from "../../src/access/trust.ts";
import { HostIssuer } from "../../src/access/issuer.ts";
import type { Operation } from "../../src/access/token.ts";
import { scratchDir } from "./scratch.ts";

export const N = 1800000000;
export const operation: Operation = { audience: "homelab", resource: "host:agent-a", action: "health.summary" };
export const admission = () => ({
  runId: "run-test-1", profile: "daily-health", project: "homelab", expiresAt: N + 3600,
  services: [{ audience: "homelab" as const, grants: [{ resource: operation.resource, actions: [operation.action, "logs.read"] }] }],
});
export interface VectorCase {
  name: string; token: unknown; accept: boolean; clock?: ClockSample; operation?: Operation; bundle?: string; skew?: number;
}
export interface VectorStep { clock?: ClockSample; restart?: boolean; install?: string; token?: string; accept: boolean }
interface VectorSet {
  format: string; anchors: TrustAnchor[]; clock: ClockSample; operation: Operation; bundle: string;
  cases: VectorCase[]; scenarios: Array<{ name: string; steps: VectorStep[] }>;
}
export const vectorSets = ["v1.json", "v1-encoding.json"].map(name =>
  JSON.parse(readFileSync(new URL("../fixtures/access/" + name, import.meta.url), "utf8")) as VectorSet);
export const vectors = vectorSets[0]!;
export async function rig() {
  const scratch = scratchDir("access");
  const issuerPair = generateKeyPairSync("ed25519"), deployment = generateKeyPairSync("ed25519");
  const publicKey = (key: typeof issuerPair.publicKey) => {
    const jwk = key.export({ format: "jwk" });
    return { kty: "OKP" as const, crv: "Ed25519" as const, x: jwk.x! };
  };
  const anchor = { kid: "deployment-1", public_key: publicKey(deployment.publicKey) };
  let sample: ClockSample = { ...vectors.clock };
  let state = new AccessState(join(scratch.path, "state.sqlite"), { initialize: true });
  let clock = new Clock(state, () => sample);
  let trust = new TrustStore(state, clock, [anchor]);
  const bundle: TrustBundle = {
    v: 1, sequence: 1, published_at: N - 10, expires_at: N + 590,
    keys: [{
      issuer: "chaldea:agent-a", kid: "host-1", public_key: publicKey(issuerPair.publicKey),
      not_before: N - 3600, issue_until: N + 3600, verify_until: N + 4410,
      ceilings: [{ audience: "homelab", profile: "daily-health", project: "homelab", grants: admission().services[0]!.grants }],
    }],
  };
  const envelope = await signTrustBundle(bundle, anchor.kid, deployment.privateKey);
  await trust.install(envelope);
  return {
    scratch, issuerPair, deployment, anchor, bundle, envelope,
    get sample() { return sample; }, set sample(value: ClockSample) { sample = value; },
    get state() { return state; }, get clock() { return clock; }, get trust() { return trust; },
    issuer() { return new HostIssuer("chaldea:agent-a", "host-1", issuerPair.privateKey, trust, clock); },
    restart() {
      state.close(); state = new AccessState(join(scratch.path, "state.sqlite"));
      clock = new Clock(state, () => sample); trust = new TrustStore(state, clock, [anchor]);
    },
    sign(b: TrustBundle) { return signTrustBundle(b, anchor.kid, deployment.privateKey); },
    remove() { state.close(); scratch.remove(); },
  };
}
