import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const check = fileURLToPath(new URL("../../scripts/check-host-release", import.meta.url));
test("host release gate accepts main ancestors and annotated tags, rejects unmerged or missing commits", () => {
  assert.notEqual(tmpdir(), "/tmp");
  const root = mkdtempSync(join(tmpdir(), "release-gate-"));
  const env = { ...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" };
  assert.equal(env.HOME, root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8" }).trim();
  const gate = (commit: string) => spawnSync("sh", [check, commit], { cwd: root, env, encoding: "utf8" });
  try {
    git("init", "-q", "-b", "main");
    git("commit", "-q", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    git("switch", "-q", "-c", "merged");
    git("commit", "-q", "--allow-empty", "-m", "merged");
    const merged = git("rev-parse", "HEAD");
    git("tag", "-a", "host-v-test", "-m", "annotated");
    git("switch", "-q", "main"); git("merge", "-q", "--no-ff", "merged", "-m", "merge");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    assert.equal(gate(base).status, 0); assert.equal(gate(merged).status, 0);
    assert.equal(gate("host-v-test").status, 0);
    git("switch", "-q", "-c", "unmerged");
    git("commit", "-q", "--allow-empty", "-m", "unmerged");
    const rejected = gate(git("rev-parse", "HEAD"));
    assert.equal(rejected.status, 1); assert.match(rejected.stderr, /::error::.*not reachable from origin\/main/);
    assert.equal(gate("missing").status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
