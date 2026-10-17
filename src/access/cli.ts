import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AccessState, Clock, TrustStore } from "./trust.ts";
import type { TrustAnchor } from "./trust.ts";
import { audienceName, exact, object, requireAccess, seconds, strictJson, verifyToken } from "./token.ts";

const USAGE = `Usage:
  chaldea access initialize-state|clock-health|install-bundle|sign-bundle --help
  chaldea access verify --token-file PATH --bundle-file PATH --anchor-file PATH
    --state-file PATH [--initialize-state] --clock-health-file PATH --audience SERVICE --resource RESOURCE --action ACTION

Offline verification only. The state directory must be private (0700).
Anchor file: JSON array [{kid,public_key:{kty:"OKP",crv:"Ed25519",x}}].
Clock-health file: {healthy,offsetSeconds,checked_at}; monitored outside the sandbox,
refreshed within 30 seconds. No key generation, admission or mint endpoint.
`;
function readTrusted(path: string, max: number, privateFile = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    requireAccess(stat.isFile() && stat.size <= max && (stat.uid === 0 || stat.uid === process.geteuid!()) &&
      (stat.mode & (privateFile ? 0o077 : 0o022)) === 0, "unsafe_input");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
export async function accessCli(
  args: readonly string[],
  io = { out: (text: string) => { process.stdout.write(text); }, err: (text: string) => { process.stderr.write(text); } },
): Promise<number> {
  if (["initialize-state", "clock-health", "install-bundle", "sign-bundle"].includes(args[0] ?? "")) {
    const { maintenanceCli } = await import("./maintenance.ts");
    return maintenanceCli(args);
  }
  let state: AccessState | undefined;
  try {
    const { values, positionals } = parseArgs({
      args: [...args], allowPositionals: true, strict: true,
      options: {
        "token-file": { type: "string" }, "bundle-file": { type: "string" }, "anchor-file": { type: "string" },
        "state-file": { type: "string" }, "clock-health-file": { type: "string" },
        audience: { type: "string" }, resource: { type: "string" }, action: { type: "string" },
        "initialize-state": { type: "boolean" }, help: { type: "boolean", short: "h" },
      },
    });
    if (values.help) { io.out(USAGE); return 0; }
    if (positionals.length !== 1 || positionals[0] !== "verify" ||
      ["token-file", "bundle-file", "anchor-file", "state-file", "clock-health-file", "audience", "resource", "action"]
        .some(k => !values[k as keyof typeof values])) { io.err(USAGE); return 64; }
    audienceName(values.audience);
    state = new AccessState(values["state-file"]!, { initialize: values["initialize-state"] === true });
    const clock = new Clock(state, () => {
      const now = Math.floor(Date.now() / 1000);
      const health = object(strictJson(readTrusted(values["clock-health-file"]!, 1024)));
      exact(health, ["healthy", "offsetSeconds", "checked_at"]); seconds(health.checked_at);
      requireAccess(health.checked_at <= now && now - health.checked_at <= 30 &&
        typeof health.offsetSeconds === "number", "clock_health_stale");
      return {
        unixSeconds: now, monotonicSeconds: Number(process.hrtime.bigint()) / 1e9,
        bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
        healthy: health.healthy === true, offsetSeconds: health.offsetSeconds,
      };
    });
    const anchors = strictJson(readTrusted(values["anchor-file"]!, 16384));
    requireAccess(Array.isArray(anchors), "invalid_anchors");
    const trust = new TrustStore(state, clock, anchors as TrustAnchor[]);
    await trust.install(readTrusted(values["bundle-file"]!, 262145).toString("utf8").trim());
    const result = await verifyToken(readTrusted(values["token-file"]!, 16385, true).toString("utf8").trim(),
      { audience: values.audience, resource: values.resource!, action: values.action! }, trust, clock);
    const c = result.claims;
    io.out(JSON.stringify({ v: 1, issuer: c.iss, profile: c.sub, run_id: c.run_id,
      project: c.project, audience: c.aud, valid_until: result.validUntil }) + "\n");
    return 0;
  } catch {
    // Parser/JOSE/OS errors can include input excerpts. Never echo bearer material.
    io.err("chaldea access: verification denied\n");
    return 1;
  } finally { state?.close(); }
}
