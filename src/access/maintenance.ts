import { clockHealth } from "./clock.ts";
import { constants, openSync, closeSync, fstatSync, lstatSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, readSync, fchmodSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID, createPublicKey } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { AccessState, Clock, TrustStore, signTrustBundle, validateBundle, TRUST_FRESH_SECONDS } from "./trust.ts";
import type { TrustAnchor, TrustBundle } from "./trust.ts";
import { loadHostSigningKey } from "./issuer.ts";
import { exact, object, requireAccess, seconds, strictJson } from "./token.ts";

export function trustedBytes(path: string, max: number): Buffer {
  requireAccess(isAbsolute(path), "absolute_path_required");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const s = fstatSync(fd);
    requireAccess(s.isFile() && s.nlink === 1 && s.size <= max &&
      (s.uid === 0 || s.uid === process.geteuid!()) && (s.mode & 0o022) === 0, "unsafe_input");
    const b = Buffer.alloc(max + 1);
    let size = 0, n: number;
    while (size < b.length && (n = readSync(fd, b, size, b.length - size, null)) > 0) size += n;
    requireAccess(size <= max, "input_too_large"); return b.subarray(0, size);
  } finally { closeSync(fd); }
}
export function atomicPublicFile(path: string, bytes: string): void {
  requireAccess(isAbsolute(path), "absolute_path_required");
  const dir = dirname(path), s = lstatSync(dir);
  requireAccess(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.geteuid!() &&
    (s.mode & 0o022) === 0, "unsafe_output_directory");
  const tmp = join(dir, ".trust-" + randomUUID());
  const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
  try {
    try { fchmodSync(fd, 0o644); writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, path);
    const d = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try { fsyncSync(d); } finally { closeSync(d); }
  } finally { try { unlinkSync(tmp); } catch { /* already renamed */ } }
}
export function healthClock(state: AccessState, path: string): Clock {
  return clockHealth(state, () => trustedBytes(path, 1024));
}
export interface Health { healthy: boolean; offsetSeconds: number; checked_at: number }
/** chronyc -n tracking, LC_ALL=C. A local fallback reference is never external health.
 * Accuracy bound from chronyc(1): |system offset| + dispersion + half root delay. */
export function chronyHealth(report: string, now: number): Health {
  const bad = { healthy: false, offsetSeconds: 0, checked_at: now };
  try {
    const fields = new Map<string, string>();
    for (const line of report.trim().split("\n")) {
      const m = /^([^:]+?)\s*:\s*(.*?)\s*$/.exec(line); requireAccess(m, "bad_tracking");
      const name = m[1]!.trim(); requireAccess(!fields.has(name), "duplicate_tracking"); fields.set(name, m[2]!);
    }
    const numeric = (name: string, unit: string) => {
      const raw = fields.get(name) ?? "";
      requireAccess(raw.endsWith(unit), "bad_tracking_unit");
      const value = unit ? raw.slice(0, -unit.length) : raw;
      requireAccess(/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)$/.test(value) &&
        Number.isFinite(Number(value)), "bad_tracking_number"); return Number(value);
    };
    const offset = /^([0-9]+(?:\.[0-9]+)?) seconds (fast|slow) of NTP time$/.exec(fields.get("System time") ?? "");
    requireAccess(offset, "unknown_offset");
    const offsetSeconds = Number(offset[1]) * (offset[2] === "slow" ? -1 : 1);
    const ref = fields.get("Reference ID") ?? "";
    requireAccess(/^[A-Fa-f0-9]{8}(?: \([^\n]*\))?$/.test(ref) &&
      !/^(00000000|7F7F0101)/i.test(ref), "no_external_reference");
    const stratum = numeric("Stratum", ""), delay = numeric("Root delay", " seconds"),
      dispersion = numeric("Root dispersion", " seconds"), interval = numeric("Update interval", " seconds");
    const refTime = Date.parse((fields.get("Ref time (UTC)") ?? "") + " UTC") / 1000;
    requireAccess(stratum >= 1 && stratum <= 15 && Number.isInteger(stratum) &&
      fields.get("Leap status") === "Normal" && delay >= 0 && dispersion >= 0 &&
      interval > 0 && Number.isFinite(refTime) && refTime <= now + 30 &&
      now - refTime <= Math.min(3600, Math.max(120, interval * 3)), "unsynchronised");
    return { healthy: Math.abs(offsetSeconds) + dispersion + delay / 2 <= 30, offsetSeconds, checked_at: now };
  } catch { return bad; }
}
export function sampleChrony(readTracking: () => string = () =>
  execFileSync("/usr/bin/chronyc", ["-n", "-h", "/run/chrony/chronyd.sock", "tracking"],
    { encoding: "utf8", timeout: 3000, maxBuffer: 8192, env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] })): Health {
  const now = Math.floor(Date.now() / 1000);
  try {
    const report = readTracking();
    return chronyHealth(report, now);
  } catch { return { healthy: false, offsetSeconds: 0, checked_at: now }; }
}

/** systemd's typed D-Bus NTPMessage: uuuuittayttttbtt, in microseconds.
 * Reject unknown layouts rather than interpreting localized status prose. */
export function timesyncdHealth(synchronized: string, report: string, poll: string, now: number): Health {
  const bad = { healthy: false, offsetSeconds: 0, checked_at: now };
  try {
    requireAccess(synchronized.trim() === "b true", "unsynchronised");
    const values = report.trim().split(/\s+/);
    requireAccess(values.shift() === "(uuuuittayttttbtt)" && values.length === 19, "unknown_ntp_message");
    const integer = (i: number) => {
      requireAccess(/^-?[0-9]+$/.test(values[i]!), "bad_ntp_number");
      const n = Number(values[i]); requireAccess(Number.isSafeInteger(n), "bad_ntp_number"); return n;
    };
    const [type, interval, ...rest] = poll.trim().split(/\s+/);
    requireAccess(type === "t" && rest.length === 0 && /^[0-9]+$/.test(interval!), "unknown_poll");
    const update = Number(interval) / 1e6;
    const leap = integer(0), version = integer(1), mode = integer(2), stratum = integer(3);
    integer(4);
    const delay = integer(5) / 1e6, dispersion = integer(6) / 1e6;
    requireAccess(integer(7) === 4, "unknown_reference");
    const ref = [8, 9, 10, 11].map(integer);
    requireAccess(ref.every(n => n >= 0 && n <= 255) && ref.some(n => n !== 0) &&
      ref.join(".") !== "127.127.1.1" && ref.join(".") !== "76.79.67.76", "local_reference");
    const origin = integer(12) / 1e6, receive = integer(13) / 1e6,
      transmit = integer(14) / 1e6, destination = integer(15) / 1e6;
    requireAccess(leap >= 0 && leap <= 2 && [3, 4].includes(version) && mode === 4 &&
      stratum >= 1 && stratum <= 15 && delay >= 0 && dispersion >= 0 &&
      Number.isFinite(update) && update > 0 && values[16] === "false" &&
      integer(17) > 0 && integer(18) >= 0 && origin > 0 && receive > 0 &&
      transmit >= receive && destination >= origin && destination <= now + 30 &&
      now - destination <= Math.min(3600, Math.max(120, update * 3)), "unsynchronised");
    const offsetSeconds = ((receive - origin) + (transmit - destination)) / 2;
    return { healthy: Math.abs(offsetSeconds) + dispersion + delay / 2 <= 30, offsetSeconds, checked_at: now };
  } catch { return bad; }
}
const clockCommand = (program: string, args: string[]): string =>
  execFileSync(program, args, { encoding: "utf8", timeout: 1000, maxBuffer: 8192,
    env: { ...process.env, LC_ALL: "C" }, stdio: ["ignore", "pipe", "pipe"] });
export function sampleClock(run: (program: string, args: string[]) => string = clockCommand): Health {
  const now = Math.floor(Date.now() / 1000), bad = { healthy: false, offsetSeconds: 0, checked_at: now };
  try {
    const active = run("/usr/bin/systemctl", ["show", "systemd-timesyncd.service", "--property=ActiveState", "--value"]).trim();
    if (active === "inactive") return sampleChrony(() =>
      run("/usr/bin/chronyc", ["-n", "-h", "/run/chrony/chronyd.sock", "tracking"]));
    if (active !== "active") return bad;
    const property = (service: string, iface: string, name: string) =>
      run("/usr/bin/busctl", ["--system", "--no-pager", "get-property", service,
        "/" + service.replaceAll(".", "/"), iface, name]);
    return timesyncdHealth(
      property("org.freedesktop.timedate1", "org.freedesktop.timedate1", "NTPSynchronized"),
      property("org.freedesktop.timesync1", "org.freedesktop.timesync1.Manager", "NTPMessage"),
      property("org.freedesktop.timesync1", "org.freedesktop.timesync1.Manager", "PollIntervalUSec"), now);
  } catch { return bad; }
}

export async function installBundle(store: TrustStore, envelope: string, output: string): Promise<TrustBundle> {
  await store.install(envelope);
  const bundle = await store.snapshot();
  // State is committed before exposing the file. A crash retries the identical envelope.
  store.assertCurrent(bundle.sequence);
  atomicPublicFile(output, envelope);
  return bundle;
}

export const MAINTENANCE_USAGE = `Usage: chaldea access
  initialize-state --state-file PATH
  clock-health --output PATH
  install-bundle --state-file PATH --clock-health-file PATH --anchor-file PATH --bundle-file PATH --output PATH
  sign-bundle --state-file PATH --clock-health-file PATH --key-file PATH --kid ID
    --grants-file PATH --sequence N --output PATH [--lifetime 86400]

Grants file: JSON array of operator-owned TrustedKey records (public keys only).
Sign on omarchy-pc only; private deployment key must never be on a run host.
State initialization is explicit and exclusive. Never reset/restore high-water state.
`;
export async function maintenanceCli(args: readonly string[], healthSample: () => Health = sampleClock): Promise<number> {
  let state: AccessState | undefined;
  try {
    process.umask(0o077);
    const { values: v, positionals } = parseArgs({ args: [...args], allowPositionals: true, options: {
      "state-file": { type: "string" }, "clock-health-file": { type: "string" }, "anchor-file": { type: "string" },
      "bundle-file": { type: "string" }, output: { type: "string" }, "key-file": { type: "string" },
      kid: { type: "string" }, "grants-file": { type: "string" }, sequence: { type: "string" },
      lifetime: { type: "string" }, help: { type: "boolean" },
    } });
    if (v.help) { process.stdout.write(MAINTENANCE_USAGE); return 0; }
    requireAccess(positionals.length === 1, "usage");
    const required = (name: keyof typeof v): string => {
      const value = v[name]; requireAccess(typeof value === "string" && value.length > 0, "missing_option"); return value;
    };
    const command = positionals[0];
    if (command === "clock-health") {
      const health = healthSample(); atomicPublicFile(required("output"), JSON.stringify(health) + "\n");
      return health.healthy ? 0 : 1;
    }
    requireAccess(["initialize-state", "install-bundle", "sign-bundle"].includes(command!), "usage");
    state = new AccessState(required("state-file"), { initialize: command === "initialize-state" });
    if (command === "initialize-state") return 0;
    const clock = healthClock(state, required("clock-health-file"));
    let anchors: TrustAnchor[], envelope: string;
    if (command === "sign-bundle") {
      const key = loadHostSigningKey(required("key-file")), kid = required("kid");
      const jwk = createPublicKey(key).export({ format: "jwk" });
      anchors = [{ kid, public_key: { kty: "OKP", crv: "Ed25519", x: jwk.x! } }];
      const now = clock.check(), lifetime = Number(v.lifetime ?? TRUST_FRESH_SECONDS);
      const bundle = validateBundle({ v: 1, sequence: Number(required("sequence")), published_at: now,
        expires_at: now + lifetime, keys: strictJson(trustedBytes(required("grants-file"), 196608), true) });
      envelope = await signTrustBundle(bundle, kid, key);
    } else {
      const a = strictJson(trustedBytes(required("anchor-file"), 16384));
      requireAccess(Array.isArray(a), "invalid_anchors"); anchors = a as TrustAnchor[];
      envelope = trustedBytes(required("bundle-file"), 262144).toString("utf8").trim();
    }
    const bundle = await installBundle(new TrustStore(state, clock, anchors), envelope, required("output"));
    process.stdout.write(JSON.stringify({ sequence: bundle.sequence, expires_at: bundle.expires_at }) + "\n");
    return 0;
  } catch { process.stderr.write("chaldea access: trust maintenance failed\n"); return 1; }
  finally { state?.close(); }
}
if (import.meta.main) process.exitCode = await maintenanceCli(process.argv.slice(2));
