import { constants, openSync, closeSync, fchmodSync, fsyncSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

/** The caller owns directory creation and validation. Publish only fully synced bytes. */
export function atomicWrite(path: string, bytes: string | Uint8Array, mode = 0o600): void {
  const dir = dirname(path), temporary = join(dir, ".chaldea-" + randomUUID());
  const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    try { fchmodSync(fd, mode); writeFileSync(fd, bytes); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temporary, path);
    syncDirectory(dir);
  } finally { try { unlinkSync(temporary); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } }
}
export function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
