// Test scratch space on disk. Never /tmp: on the fleet hosts it is a small
// RAM-backed tmpfs with a per-user quota.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCRATCH_ROOT = process.env.CHALDEA_TEST_SCRATCH ?? join(homedir(), ".cache", "chaldea-test");

export function scratchDir(prefix: string): { path: string; remove: () => void } {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  const path = mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
