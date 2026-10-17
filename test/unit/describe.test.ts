import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { description } from "../../src/describe.ts";

test("installed discovery and full help never load user state or services", () => {
  const home = mkdtempSync(join(tmpdir(), "chaldea-describe-"));
  assert.notEqual(home, process.env.HOME);
  for (const args of [["--describe"], ["--help"], ["exec", "--help"], ["quota", "--help"], ["t3", "--help"]]) {
    const result = spawnSync(process.execPath, ["bin/chaldea", ...args], {
      encoding: "utf8", env: { ...process.env, HOME: home,
        XDG_CONFIG_HOME: join(home, "missing"), CHALDEA_STATE_DIR: join(home, "state") },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    if (args[0] === "--describe") assert.deepEqual(JSON.parse(result.stdout), description);
    if (args[0] === "--help") for (const command of description.commands)
      assert.ok(result.stdout.includes("chaldea " + command.name));
    assert.deepEqual(readdirSync(home), []);
  }
});

test("stateful verification and exec history are writes", () => {
  const reads = description.commands.filter(c => c.access === "read").map(c => c.name);
  assert.deepEqual(reads, ["quota status", "wait status", "decision status"]);
  for (const command of description.commands) {
    assert.ok(command.summary.length > 0 && !command.summary.includes("\n"));
  }
});
