// Test scratch space on disk. Never /tmp: on the fleet hosts it is a small
// RAM-backed tmpfs with a per-user quota.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCRATCH_ROOT = process.env.CHALDEA_TEST_SCRATCH ?? join(homedir(), ".cache", "chaldea-test");

/** Fixtures a crashed run left behind are removed once they are a day old. */
export const STALE_FIXTURE_MS = 24 * 60 * 60 * 1000;

export function pruneStaleFixtures(nowMs = Date.now()): void {
  mkdirSync(SCRATCH_ROOT, { recursive: true });
  for (const name of readdirSync(SCRATCH_ROOT)) {
    // tmp is the live TMPDIR of the current run (scripts/with-scratch).
    if (name === "tmp") continue;
    const path = join(SCRATCH_ROOT, name);
    try {
      if (nowMs - statSync(path).mtimeMs > STALE_FIXTURE_MS) rmSync(path, { recursive: true, force: true });
    } catch {
      // Removed concurrently.
    }
  }
}

export function scratchDir(prefix: string): { path: string; remove: () => void } {
  pruneStaleFixtures();
  const path = mkdtempSync(join(SCRATCH_ROOT, `${prefix}-`));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
