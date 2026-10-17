import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { accessCli } from "../../src/access/cli.ts";
import { rig, N, admission } from "../helpers/access.ts";

test("access CLI is composed into the entrypoint with no mint command", () => {
  const result = spawnSync(process.execPath, [new URL("../../src/cli.ts", import.meta.url).pathname, "access", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /access verify/);
  assert.match(result.stdout, /No key generation/);
});
test("access CLI verifies locally, denies stale clock health, and never prints a token", async () => {
  const r = await rig();
  const time = mock.method(Date, "now", () => N * 1000);
  try {
    const token = await r.issuer().mint({ ...admission().services[0]!, profile: "daily-health", project: "homelab", runId: "run-cli", expiresAt: N + 300 });
    const put = (name: string, data: string) => {
      const path = join(r.scratch.path, name); writeFileSync(path, data, { mode: 0o600 }); return path;
    };
    const tokenFile = put("token", token), bundle = put("bundle", r.envelope);
    const anchors = put("anchors", JSON.stringify([r.anchor]));
    const health = put("health", JSON.stringify({ healthy: true, offsetSeconds: 0, checked_at: N }));
    const args = ["verify", "--token-file", tokenFile, "--bundle-file", bundle, "--anchor-file", anchors,
      "--clock-health-file", health, "--state-file", join(r.scratch.path, "cli", "state.sqlite"),
      "--audience", "homelab", "--resource", "host:agent-a", "--action", "health.summary"];
    let stdout = "", stderr = "";
    const io = { out: (text: string) => { stdout += text; }, err: (text: string) => { stderr += text; } };
    assert.equal(await accessCli([...args, "--initialize-state"], io), 0);
    assert.equal(JSON.parse(stdout).run_id, "run-cli"); assert.equal(stderr, "");
    writeFileSync(health, JSON.stringify({ healthy: true, offsetSeconds: 0, checked_at: N - 31 }));
    assert.equal(await accessCli(args, io), 1);
    assert.match(stderr, /verification denied/);
    assert.ok(!(stdout + stderr).includes(token));
    writeFileSync(tokenFile, "SECRET_BAD_TOKEN"); writeFileSync(health, JSON.stringify({ healthy: true, offsetSeconds: 0, checked_at: N }));
    assert.equal(await accessCli(args, io), 1);
    assert.ok(!(stdout + stderr).includes("SECRET_BAD_TOKEN"));
    assert.equal(await accessCli(["mint"], io), 64);
  } finally { time.mock.restore(); r.remove(); }
});
