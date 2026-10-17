import assert from "node:assert/strict";
import { homedir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
export function routeScratch() {
  const home = homedir();
  assert.equal(home, process.env.CHALDEA_TRUST_TEST_HOME, "Run with scripts/with-scratch");
  assert.notEqual(home, "/home/igor");
  const path = mkdtempSync(join(home, "route-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}
