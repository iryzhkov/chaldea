import { randomUUID } from "node:crypto";
import { constants, openSync, fstatSync, closeSync, readSync } from "node:fs";
import { parseArgs } from "node:util";
import { HostIssuer, loadHostSigningKey } from "./issuer.ts";
import { AccessState, TrustStore } from "./trust.ts";
import type { TrustAnchor } from "./trust.ts";
import { healthClock, trustedBytes } from "./maintenance.ts";
import { exact, identifier, issuerName, object, requireAccess, seconds, strictJson, MAX_TOKEN_SECONDS } from "./token.ts";

export const TOKEN_FLAGS = ["audience", "action", "source", "host", "kind"] as const;
export interface TokenRequest { audience: "akasha"; action: "append" | "read"; source: string; host: string; kind: string }
export interface ProducerGrant extends TokenRequest { uid: number; profile: string; project: string }
export interface HelperConfig {
  issuer: { uid: number; key_file: string; name: string; kid: string };
  state_file: string; bundle_file: string; anchor_file: string; clock_health_file: string; grants: ProducerGrant[];
}
export function tokenRequest(args: readonly string[]): TokenRequest {
  // Exactly five pairs. Reject duplicate options and positional/unknown arguments.
  requireAccess(args.length === 10 && TOKEN_FLAGS.every(f => args.filter(a => a === "--" + f).length === 1),
    "invalid_helper_arguments");
  const { values } = parseArgs({ args: [...args], strict: true,
    options: Object.fromEntries(TOKEN_FLAGS.map(f => [f, { type: "string" as const }])) });
  return validateRequest(values);
}
function validateRequest(value: unknown): TokenRequest {
  const r = object(value); exact(r, [...TOKEN_FLAGS]);
  requireAccess(r.audience === "akasha" && (r.action === "append" || r.action === "read"), "unsupported_operation");
  identifier(r.source); identifier(r.host); identifier(r.kind);
  return r as unknown as TokenRequest;
}
export function helperConfig(value: unknown): HelperConfig {
  const c = object(value); exact(c, ["issuer", "state_file", "bundle_file", "anchor_file", "clock_health_file", "grants"]);
  const i = object(c.issuer); exact(i, ["uid", "key_file", "name", "kid"]);
  seconds(i.uid); requireAccess(Number(i.uid) > 0 && Number(i.uid) < 4294967295, "invalid_issuer_uid");
  requireAccess(typeof i.key_file === "string" && i.key_file.startsWith("/"), "absolute_path_required");
  issuerName(i.name); identifier(i.kid);
  for (const field of ["state_file", "bundle_file", "anchor_file", "clock_health_file"])
    requireAccess(typeof c[field] === "string" && (c[field] as string).startsWith("/"), "absolute_path_required");
  requireAccess(Array.isArray(c.grants) && c.grants.length > 0 && c.grants.length <= 128, "invalid_producer_grants");
  for (const item of c.grants) {
    const g = object(item); exact(g, [...TOKEN_FLAGS, "uid", "profile", "project"]);
    seconds(g.uid); identifier(g.profile); identifier(g.project);
    validateRequest(Object.fromEntries(TOKEN_FLAGS.map(f => [f, g[f]])));
  }
  return structuredClone(c) as unknown as HelperConfig;
}
/** Service producers only. The sudo-authenticated UID and operator grants are the
 * admission boundary. Scheduled/model runs must still use RunLeases. */
export async function producerToken(request: TokenRequest, uid: number, grants: ProducerGrant[], issuer: HostIssuer): Promise<string> {
  request = validateRequest(request);
  const matches = grants.filter(g => g.uid === uid && TOKEN_FLAGS.every(f => g[f] === request[f]));
  requireAccess(matches.length === 1 && issuer.issuer === "chaldea:" + request.host, "producer_not_authorized");
  const grant = matches[0]!;
  return issuer.mint({ audience: request.audience, source: grant.source, profile: grant.profile,
    project: grant.project, runId: randomUUID(), expiresAt: issuer.clock.check() + MAX_TOKEN_SECONDS,
    grants: [{ resource: grant.source, actions: [grant.action] }] });
}
export interface HelperRuntime {
  uid: number; caller: string | undefined; config: () => unknown;
}
function rootConfig(): unknown {
  const path = "/etc/chaldea/token-helper.json";
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    requireAccess(s.isFile() && s.uid === 0 && (s.mode & 0o022) === 0 && s.nlink === 1 && s.size <= 65536,
      "unsafe_helper_config");
    const bytes = Buffer.alloc(65537);
    let size = 0, n: number;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
    requireAccess(size <= 65536, "helper_config_too_large");
    return strictJson(bytes.subarray(0, size));
  } finally { closeSync(fd); }
}
export async function tokenHelperCli(args: readonly string[], io = {
  out: (s: string) => { process.stdout.write(s); }, err: (s: string) => { process.stderr.write(s); },
}, runtime: HelperRuntime = {
  uid: process.geteuid!(), caller: process.env.SUDO_UID, config: rootConfig,
}): Promise<number> {
  let state: AccessState | undefined;
  try {
    const request = tokenRequest(args);
    // SUDO_UID is set by sudo, never accepted from argv. No direct-user mint path.
    requireAccess(typeof runtime.caller === "string" &&
      /^(0|[1-9][0-9]{0,9})$/.test(runtime.caller), "issuer_identity_required");
    const config = helperConfig(runtime.config());
    requireAccess(runtime.uid === config.issuer.uid, "issuer_identity_required");
    const uid = Number(runtime.caller);
    requireAccess(config.grants.some(g => g.uid === uid && TOKEN_FLAGS.every(f => g[f] === request[f])),
      "producer_not_authorized");
    state = new AccessState(config.state_file);
    const clock = healthClock(state, config.clock_health_file);
    const anchors = strictJson(trustedBytes(config.anchor_file, 16384));
    requireAccess(Array.isArray(anchors), "invalid_anchors");
    const trust = new TrustStore(state, clock, anchors as TrustAnchor[]);
    await trust.install(trustedBytes(config.bundle_file, 262144).toString("utf8").trim());
    const issuer = new HostIssuer(config.issuer.name, config.issuer.kid, loadHostSigningKey(config.issuer.key_file), trust, clock);
    const token = await producerToken(request, uid, config.grants, issuer);
    io.out(token + "\n");
    return 0;
  } catch {
    io.err("chaldea token helper: denied\n"); return 1;
  } finally { state?.close(); }
}
