import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { startDisposableT3, t3Version } from "../helpers/disposable-t3.ts";
import { emptyState, saveState } from "../../src/quota/state.ts";
import { newProvider } from "../../src/quota/headroom.ts";
import { writeJson } from "../../src/route/cache.ts";

test("route CLI fixture gives native delegate target without services or credentials", () => {
  const d = routeScratch();
  try {
    const result = spawnSync(process.execPath, ["bin/chaldea", "route", "--role", "builder", "--fixture", "test/fixtures/route/builder.json"],
      { encoding: "utf8", env: { ...process.env, HOME: d.path } });
    assert.equal(result.status, 0, result.stderr);
    const r = JSON.parse(result.stdout);
    assert.equal(r.providerInstanceId, "claudeAgent"); assert.equal(r.model, "claude-opus-5-5");
    assert.deepEqual(r.options, { effort: "high" }); assert.match(r.reasons.join(" "), /62% left with 40%/);
    assert.equal(r.byProvider.claudeAgent.model, "claude-opus-5-5");
    assert.equal(r.byProvider.codex.model, "gpt-6.1-sol");
    const state = emptyState(), p = newProvider("codex", "codex"), at = Date.now();
    p.included = { value: [{ id: "weekly", kind: "weekly", usedPercent: 20, remainingPercent: 80,
      windowDurationMins: 10080, resetsAt: new Date(at + .4 * 7 * 86400000).toISOString() }],
      state: "fresh", source: "fixture", observedAt: new Date(at).toISOString(), error: null };
    state.headroom.providers.push(p);
    const stateFile = join(d.path, "quota.json"); saveState(stateFile, state, at);
    for (const json of [false, true]) {
      const status = spawnSync(process.execPath, ["bin/chaldea", "quota", "status", "--state-file", stateFile, ...(json ? ["--json"] : [])],
        { encoding: "utf8", env: { ...process.env, HOME: d.path } });
      assert.equal(status.status, 0, status.stderr);
      if (json) assert.equal(JSON.parse(status.stdout).capacity.codex.class, "use-it");
      else assert.match(status.stdout, /codex capacity: use-it/);
    }
    for (const args of [["--role", "builder", "--effort", "max"], ["--role", "haiku"]]) {
      const bad = spawnSync(process.execPath, ["bin/chaldea", "route", ...args], { encoding: "utf8", env: { ...process.env, HOME: d.path } });
      assert.notEqual(bad.status, 0);
    }
  } finally { d.remove(); }
});
const skip = t3Version() === "t3 v0.1.0" ? false : "Needs pinned disposable T3 0.1.0";
if (skip && process.env.CHALDEA_REQUIRE_E2E === "1") throw new Error(skip);
test("CLI and existing MCP route against real T3 cached catalog; no wait service or child launch", { skip, timeout: 120000 }, async () => {
  const d = routeScratch();
  const t3 = await startDisposableT3({ scratchRoot: d.path, scenario: "no-reset", autoResume: false, codex: "available", claudeModel: "claude-opus-5-5" });
  try {
    const now = Date.now(), stateFile = join(d.path, "state.json"), cacheDir = join(d.path, "cache"), tokenFile = join(d.path, "token");
    const configPath = join(d.path, "route.json");
    writeFileSync(tokenFile, t3.issueToken(["orchestration:read"]), { mode: 0o600 });
    saveState(stateFile, emptyState(), now);
    writeJson(join(cacheDir, "slopalytics.json"), { attemptedAt: now, fetchedAt: new Date(now).toISOString(),
      value: { fetchedAt: new Date(now).toISOString(), sourceFetchedAt: new Date(now).toISOString(), endExclusive: new Date(now).toISOString(), models: {} } });
    writeFileSync(configPath, JSON.stringify({ t3BaseDir: t3.baseDir, tokenFile, stateFile, cacheDir }));
    const env = { ...process.env, HOME: d.path, CHALDEA_ROUTE_CONFIG: configPath };
    const cli = spawnSync(process.execPath, ["bin/chaldea", "route", "--role", "builder"], { encoding: "utf8", env, timeout: 20000 });
    assert.equal(cli.status, 0, cli.stderr);
    const target = JSON.parse(cli.stdout);
    assert.equal(target.model, "claude-opus-5-5");
    const frames = [{ jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "chaldea_route", arguments: { role: "builder" } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "chaldea_route", arguments: { role: "builder", effortOverride: "max" } } }];
    const mcp = spawnSync(process.execPath, ["--input-type=module", "-e",
      'const {runMcp} = await import(' + JSON.stringify(resolve("src/mcp.ts")) + '); await runMcp("/missing-waits.sock");'],
      { env, encoding: "utf8", timeout: 30000, input: frames.map(f => JSON.stringify(f)).join("\n") + "\n" });
    assert.equal(mcp.status, 0, mcp.stderr);
    const replies = mcp.stdout.trim().split("\n").map(line => JSON.parse(line));
    assert.ok(replies[0].result.tools.some((t: { name: string }) => t.name === "chaldea_route"));
    assert.equal(replies[1].result.isError, undefined);
    assert.equal(JSON.parse(replies[1].result.content[0].text).model, target.model);
    assert.deepEqual(JSON.parse(replies[1].result.content[0].text).byProvider, target.byProvider);
    assert.equal(replies[2].result.isError, true);
    assert.equal(t3.fakeClaudeEvents().filter(e => e.event === "turn").length, 0);
  } finally { await t3.stop(); d.remove(); }
});

test("builder review CLI rejects a same-driver pin through the runtime", { skip, timeout: 120000 }, async () => {
  const d = routeScratch();
  const t3 = await startDisposableT3({ scratchRoot: d.path, scenario: "no-reset", autoResume: false,
    codex: "available", claudeModel: "claude-opus-5-5" });
  try {
    const now = Date.now(), cacheDir = join(d.path, "cache"), tokenFile = join(d.path, "token");
    const configPath = join(d.path, "route.json"), stateFile = join(d.path, "state.json");
    writeFileSync(tokenFile, t3.issueToken(["orchestration:read"]), { mode: 0o600 });
    saveState(stateFile, emptyState(), now);
    // Reserve analytics collection without data or network. AA and Claude collection stay off.
    writeJson(join(cacheDir, "slopalytics.json"), { attemptedAt: now, fetchedAt: null, value: null });
    writeFileSync(configPath, JSON.stringify({ t3BaseDir: t3.baseDir, tokenFile, stateFile, cacheDir,
      pins: { builder: { providerInstanceId: "codex", model: "gpt-6.1-sol" } } }));
    const cli = spawnSync(process.execPath, ["bin/chaldea", "route", "--role", "builder",
      "--author-provider", "codex", "--config", configPath],
      { encoding: "utf8", env: { ...process.env, HOME: d.path }, timeout: 20000 });
    assert.notEqual(cli.status, 0, "same-provider review must refuse, received: " + cli.stdout);
    assert.match(cli.stderr, /No eligible/);
    assert.equal(t3.fakeClaudeEvents().filter(e => e.event === "turn").length, 0);
  } finally { await t3.stop(); d.remove(); }
});
