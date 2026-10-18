import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { chmodSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { collectClaudeUsage, CLAUDE_CADENCE_MS, tokenSource, claudeSourceId } from "../../src/route/claude-usage.ts";
import { claudeContexts } from "../../src/quota/fleet.ts";
import { loadRouteConfig } from "../../src/route/config.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";
import { now, iso } from "../fixtures/route/catalog.ts";
const fixture = { organization_id: "fixture-account", five_hour: { utilization: 20, resets_at: iso(now + 300 * 60000) },
  seven_day: { utilization: 38, resets_at: iso(now + .4 * 7 * 86400000) } };
test("env source extracts only the selected variable without shell evaluation or credential writes", async () => {
  const d = routeScratch();
  try {
    const envFile = join(d.path, "oauth.env"), cacheFile = join(d.path, "claude-usage.json");
    const text = "UNRELATED=$(touch /never-run-this)\nBROKEN_OTHER='unclosed\nexport CLAUDE_CODE_OAUTH_TOKEN='fixture-env-token'\n";
    writeFileSync(envFile, text, { mode: 0o600 });
    const before = statSync(envFile);
    let calls = 0;
    const fetcher: typeof fetch = async (_, init) => {
      calls++; assert.equal(new Headers(init?.headers).get("authorization"), "Bearer fixture-env-token");
      return Response.json(fixture);
    };
    const options = { enabled: true, envFile, cacheFile, now, fetcher };
    assert.equal((await collectClaudeUsage(options)).value?.windows[1]?.remainingPercent, 62);
    assert.equal(calls, 1);
    assert.equal(readFileSync(envFile, "utf8"), text);
    assert.equal(statSync(envFile).mtimeMs, before.mtimeMs);
    assert.doesNotMatch(readFileSync(cacheFile, "utf8"), /fixture-env-token|UNRELATED|BROKEN_OTHER/);
    for (const [name, text] of [
      ["missing", "OTHER=fixture-private\n"], ["duplicate", "TOKEN=one\nTOKEN=two\n"],
      ["expansion", "TOKEN=$(never-run-this)\n"], ["unclosed", "TOKEN='fixture-token\n"],
    ] as const) {
      writeFileSync(envFile, text);
      const result = await collectClaudeUsage({ ...options, envVar: "TOKEN", cacheFile: join(d.path, name + ".json") });
      assert.match(result.reason!, /credential_unavailable/);
    }
    assert.equal(calls, 1);
    writeFileSync(envFile, 'TOKEN="fixture-env-token"\n');
    assert.ok((await collectClaudeUsage({ ...options, envVar: "TOKEN", cacheFile: join(d.path, "custom.json") })).value);
    chmodSync(envFile, 0o644);
    assert.match((await collectClaudeUsage({ ...options, cacheFile: join(d.path, "mode.json") })).reason!, /credential_unavailable/);
    chmodSync(envFile, 0o600);
    const link = join(d.path, "link.env"); symlinkSync(envFile, link);
    assert.match((await collectClaudeUsage({ ...options, envFile: link, cacheFile: join(d.path, "link.json") })).reason!, /credential_unavailable/);
  } finally { d.remove(); }
});
test("expired JSON credentials report and persist credential_expired without HTTP", async () => {
  const d = routeScratch();
  try {
    const credentialFile = join(d.path, "credential.json");
    let calls = 0;
    const fetcher: typeof fetch = async () => { calls++; return Response.json(fixture); };
    for (const expiresAt of [0, now - 1, now]) {
      const cacheFile = join(d.path, String(expiresAt) + ".json");
      const text = JSON.stringify({ claudeAiOauth: { accessToken: "fixture-json-token", refreshToken: "fixture-refresh", expiresAt } });
      writeFileSync(credentialFile, text, { mode: 0o600 });
      const options = { enabled: true, credentialFile, cacheFile, now, fetcher };
      assert.match((await collectClaudeUsage(options)).reason!, /credential_expired/);
      assert.match((await collectClaudeUsage({ ...options, now: now + 1 })).reason!, /credential_expired/);
      const disk = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(disk.failureReason, "credential_expired"); assert.equal(disk.fetchedAt, null);
      assert.equal(readFileSync(credentialFile, "utf8"), text);
      assert.doesNotMatch(JSON.stringify(disk), /fixture-json-token|fixture-refresh/);
    }
    assert.equal(calls, 0);
  } finally { d.remove(); }
});
test("429 honors seconds and HTTP-date Retry-After, preserving last success and its age", async () => {
  const d = routeScratch();
  try {
    const envFile = join(d.path, "oauth.env"); writeFileSync(envFile, "TOKEN=fixture-token\n", { mode: 0o600 });
    for (const retryAfter of ["1800", iso(now + CLAUDE_CADENCE_MS + 1800000)]) {
      const cacheFile = join(d.path, "usage-" + (retryAfter === "1800" ? "seconds" : "date") + ".json");
      let calls = 0;
      const fetcher: typeof fetch = async () => { calls++; return calls === 1 ? Response.json(fixture)
        : new Response("fixture-sensitive-body", { status: 429, headers: { "Retry-After": retryAfter } }); };
      const options = { enabled: true, envFile, envVar: "TOKEN", cacheFile, now, fetcher };
      await collectClaudeUsage(options);
      const limitedAt = now + CLAUDE_CADENCE_MS;
      const result = await collectClaudeUsage({ ...options, now: limitedAt });
      assert.equal(result.value?.observedAt, iso(now)); assert.equal(result.fetchedAt, iso(now));
      assert.match(result.reason!, /rate_limited.*age 300s/);
      const disk = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(disk.failureReason, "rate_limited");
      assert.equal(disk.retryAt, limitedAt + 1800000);
      assert.equal(disk.failureCount, 1);
      assert.doesNotMatch(JSON.stringify(disk), /fixture-token|fixture-sensitive-body/);
      await collectClaudeUsage({ ...options, now: disk.retryAt - 1 }); assert.equal(calls, 2);
      await collectClaudeUsage({ ...options, now: disk.retryAt }); assert.equal(calls, 3);
    }
  } finally { d.remove(); }
});
test("429 without valid Retry-After backs off 5m to 1h across processes and resets after success", async () => {
  const d = routeScratch();
  try {
    const envFile = join(d.path, "oauth.env"), cacheFile = join(d.path, "claude-usage.json");
    writeFileSync(envFile, "TOKEN=fixture-token\n", { mode: 0o600 });
    let calls = 0, success = false;
    const fetcher: typeof fetch = async () => { calls++; return success ? Response.json(fixture)
      : new Response("", { status: 429, headers: { "Retry-After": "invalid" } }); };
    const options = { enabled: true, envFile, envVar: "TOKEN", cacheFile, now, fetcher };
    let at = now;
    for (const delay of [5, 10, 20, 40, 60, 60]) {
      assert.match((await collectClaudeUsage({ ...options, now: at })).reason!, /rate_limited/);
      const disk = JSON.parse(readFileSync(cacheFile, "utf8"));
      assert.equal(disk.retryAt, at + delay * 60000);
      const count = calls;
      await collectClaudeUsage({ ...options, now: disk.retryAt - 1 }); assert.equal(calls, count);
      at = disk.retryAt;
    }
    success = true;
    assert.equal((await collectClaudeUsage({ ...options, now: at })).reason, null);
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).failureReason, undefined);
    success = false;
    at += CLAUDE_CADENCE_MS;
    await collectClaudeUsage({ ...options, now: at });
    assert.equal(JSON.parse(readFileSync(cacheFile, "utf8")).retryAt, at + CLAUDE_CADENCE_MS);
  } finally { d.remove(); }
});
test("401 persists unauthorized and generic failures never persist exception text", async () => {
  const d = routeScratch();
  try {
    const envFile = join(d.path, "oauth.env");
    writeFileSync(envFile, "TOKEN=fixture-token\n", { mode: 0o600 });
    for (const [name, fetcher] of [
      ["unauthorized", async () => new Response("fixture-sensitive-body", { status: 401 })],
      ["collection_failed", async () => { throw new Error("Bearer fixture-token"); }],
    ] as const) {
      const cacheFile = join(d.path, name + ".json");
      const options = { enabled: true, envFile, envVar: "TOKEN", cacheFile, now, fetcher };
      assert.match((await collectClaudeUsage(options)).reason!, new RegExp(name));
      assert.match((await collectClaudeUsage({ ...options, now: now + 1 })).reason!, new RegExp(name));
      const disk = readFileSync(cacheFile, "utf8");
      assert.equal(JSON.parse(disk).failureReason, name);
      assert.doesNotMatch(disk, /fixture-token|fixture-sensitive-body/);
    }
  } finally { d.remove(); }
});
test("token sources are exclusive, default explicitly, and partition caches by source and variable", () => {
  const d = routeScratch();
  try {
    assert.deepEqual(tokenSource({ envVar: "TOKEN" }, d.path), { envFile: join(d.path, ".config/claude/oauth.env"), envVar: "TOKEN" });
    assert.deepEqual(tokenSource({ envFile: "/fixture/env" }, d.path), { envFile: "/fixture/env", envVar: "CLAUDE_CODE_OAUTH_TOKEN" });
    const configFile = join(d.path, "route.json");
    writeFileSync(configFile, JSON.stringify({ claudeUsage: { enabled: true, envFile: "/fixture/env" } }));
    const config = loadRouteConfig(d.path, configFile);
    assert.equal(config.claudeUsage.credentialFile, undefined);
    assert.equal(config.claudeUsage.envVar, "CLAUDE_CODE_OAUTH_TOKEN");
    assert.notEqual(claudeSourceId(config.claudeUsage), claudeSourceId({ envFile: "/fixture/env", envVar: "OTHER" }));
    assert.equal(claudeContexts([{ enabled: true, providerInstanceId: "claudeAgent", envFile: "/fixture/env" }])[0]?.envVar, "CLAUDE_CODE_OAUTH_TOKEN");
    for (const source of [
      { credentialFile: "/fixture/json", envFile: "/fixture/env" },
      { envFile: "relative" }, { envVar: "TOKEN;echo" }, { envFile: 123 },
    ]) {
      assert.throws(() => tokenSource(source as never, d.path), /Invalid/);
      writeFileSync(configFile, JSON.stringify({ claudeUsage: source }));
      assert.throws(() => loadRouteConfig(d.path, configFile), /Invalid/);
    }
  } finally { d.remove(); }
});
