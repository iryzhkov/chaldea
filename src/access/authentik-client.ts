import { openSync, fstatSync, readSync, closeSync, constants } from "node:fs";
import { resolve } from "node:path";
import { requireAccess } from "./token.ts";

export interface HostCredential { host: string; home: string; uid: number }
/** Linux descriptor-relative walk: no symlink ancestors or leaf, including races. */
export function hostPassword(identity: HostCredential): string {
  const path = identity.home + "/.config/chaldea/authentik/host.app-password";
  requireAccess(resolve(path) === path, "unsafe_credential");
  let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const parts = path.slice(1).split("/");
    for (const part of parts.slice(0, -1)) {
      const s = fstatSync(fd);
      requireAccess((s.uid === 0 || s.uid === identity.uid) && (s.mode & 0o022) === 0, "unsafe_credential");
      const next = openSync("/proc/self/fd/" + fd + "/" + part,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    const parent = fstatSync(fd);
    requireAccess(parent.uid === identity.uid && (parent.mode & 0o777) === 0o700, "unsafe_credential");
    const leaf = openSync("/proc/self/fd/" + fd + "/" + parts.at(-1),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    closeSync(fd); fd = leaf;
    const before = fstatSync(fd);
    requireAccess(before.isFile() && before.uid === identity.uid && before.nlink === 1 &&
      (before.mode & 0o777) === 0o600 && before.size >= 16 && before.size <= 256, "unsafe_credential");
    const bytes = Buffer.alloc(257);
    let size = 0, n: number;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
    const after = fstatSync(fd);
    const password = bytes.subarray(0, size).toString("utf8");
    requireAccess(size === before.size && after.size === before.size && after.mtimeMs === before.mtimeMs &&
      /^[!-~]{16,256}$/.test(password), "unsafe_credential");
    return password;
  } finally { closeSync(fd); }
}
/** One exchange per request, no on-disk or process cache and no PKI fallback. */
export async function authentikToken(identity: HostCredential, host: string,
  fetcher: typeof fetch = fetch, password: () => string = () => hostPassword(identity),
  now: () => number = () => Date.now() / 1000): Promise<string> {
  const registryHost = identity.host === "laptop" ? "omarchy-macbook-air-igor" :
    identity.host === "normandy" ? "omarchy-normandy" : identity.host;
  requireAccess(host === registryHost, "wrong_host");
  const response = await fetcher("https://auth.ryzhkov.dev/application/o/token/", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: "chaldea-akasha",
      username: "chaldea-" + identity.host, password: password(),
      scope: "akasha.ingest", resource: "https://akasha.ryzhkov.dev" }),
  });
  requireAccess(response.ok && response.body !== null, "exchange_failed");
  const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.length; requireAccess(size <= 32768, "exchange_failed"); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const token = body.access_token;
  requireAccess(body.token_type?.toLowerCase() === "bearer" && Number.isInteger(body.expires_in) &&
    body.expires_in > 0 && body.expires_in <= 300 && typeof token === "string" && token.length <= 16384 &&
    /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token), "exchange_failed");
  // Sanity check only. Akasha independently verifies signature and registry authority.
  const claims = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"));
  requireAccess(claims.iss === "https://auth.ryzhkov.dev/application/o/chaldea-akasha/" &&
    (claims.aud === "https://akasha.ryzhkov.dev" || Array.isArray(claims.aud) &&
      claims.aud.length === 1 && claims.aud[0] === "https://akasha.ryzhkov.dev") &&
    claims.host === host && claims.preferred_username === "chaldea-" + host &&
    claims.run_id === "chaldea-" + identity.host && claims.scope?.split(" ").includes("akasha.ingest") &&
    Number.isInteger(claims.iat) && Number.isInteger(claims.exp) &&
    claims.exp > now() && claims.iat <= now() + 60 && claims.exp > claims.iat &&
    claims.exp - claims.iat <= 300, "exchange_failed");
  return token;
}
