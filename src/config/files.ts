import { openSync, fstatSync, readSync, closeSync, constants } from "node:fs";

export class ConfigurationError extends Error {
  readonly file: string | undefined;
  readonly reason: string;
  constructor(message: string, file?: string, reason = "schema") {
    super(message); this.file = file; this.reason = reason;
  }
}
export interface FilePolicy { maxBytes?: number; secret?: boolean; private?: boolean; owners?: readonly number[] }
/** Inspect the opened descriptor, then bound the read even if the file grows.
 * NOFOLLOW refuses a symlink leaf; NONBLOCK keeps FIFOs from blocking startup. */
export function readTrustedFile(path: string, policy: FilePolicy = {}): Buffer {
  const max = policy.maxBytes ?? 256 * 1024;
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new ConfigurationError("Cannot open trusted file", path, (error as NodeJS.ErrnoException).code === "ELOOP" ? "symlink" : "open");
  }
  try {
    const stat = fstatSync(fd);
    const uid = process.geteuid?.() ?? process.getuid?.() ?? -1;
    const owners = policy.owners ?? (policy.secret ? [uid] : [0, uid]);
    const reason = !stat.isFile() ? "type" : stat.nlink !== 1 ? "links" : !owners.includes(stat.uid) ? "owner" :
      (stat.mode & (policy.secret ? 0o077 : policy.private ? 0o037 : 0o022)) !== 0 ? "mode" : stat.size > max ? "size" : undefined;
    if (reason) throw new ConfigurationError(policy.secret ? "Credential requires owner uid, mode 0600 or stricter and bounded size" : "Unsafe configuration file", path, reason);
    const bytes = Buffer.alloc(max + 1);
    let size = 0, n: number;
    while (size < bytes.length && (n = readSync(fd, bytes, size, bytes.length - size, null)) > 0) size += n;
    if (size > max) throw new ConfigurationError("Trusted file exceeds size limit", path, "read_size");
    return bytes.subarray(0, size);
  } finally { closeSync(fd); }
}
export function privateFile(path: string): string {
  try {
    const value = readTrustedFile(path, { secret: true, maxBytes: 16 * 1024 }).toString("utf8").trim();
    if (!value) throw new ConfigurationError("Empty credential file", path, "empty");
    return value;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Credential file could not be read", path, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read");
  }
}
export function readJson(path: string, optional = false, decode: (bytes: Buffer) => unknown = bytes => JSON.parse(bytes.toString("utf8")), policy: FilePolicy = {}): Record<string, unknown> {
  let bytes: Buffer;
  try { bytes = readTrustedFile(path, policy); }
  catch (error) {
    if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Configuration file could not be read", path, (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "read");
  }
  try {
    const value = decode(bytes);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ConfigurationError("Configuration requires a JSON object", path, "parse"); }
}
/** Structured diagnostic fields contain locations and categories, never file bytes. */
export function configFailure(error: unknown) {
  return error instanceof ConfigurationError ? { file: error.file, reason: error.reason } : {};
}
export function configString(value: unknown, key: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value || value.includes("\0")) throw new ConfigurationError("Invalid configuration key: " + key);
  return value;
}
export function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new ConfigurationError("Unknown configuration key");
}
