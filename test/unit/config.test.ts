import { test } from "node:test";
import { trustedFile } from "../../src/akasha/main.ts";
import assert from "node:assert/strict";
import { chmodSync, linkSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { scratchDir } from "../helpers/scratch.ts";
import { paths, configPath } from "../../src/config/paths.ts";
import { privateFile, readJson, readTrustedFile, ConfigurationError } from "../../src/config/files.ts";
import { createLogger, MAX_LINES_PER_MINUTE } from "../../src/config/log.ts";
import { boundedLog } from "../../src/config/waits-log.ts";
import { aliases } from "../../src/config/compat.ts";
import { akashaConfig } from "../../src/config/akasha.ts";
import { execConfig } from "../../src/config/exec.ts";
import { eventsConfig } from "../../src/config/events.ts";
import { loadConfig } from "../../src/waits/config.ts";
import { loadHeadroomConfig } from "../../src/quota/codex-balance.ts";
import { quotaConfig } from "../../src/config/quota.ts";
import { main } from "../../src/cli.ts";

function environment(values: Record<string, string | undefined>, run: () => void) {
  const old = Object.fromEntries(Object.keys(values).map(k => [k, process.env[k]]));
  try {
    for (const [k, v] of Object.entries(values)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    run();
  } finally {
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
test("XDG paths use absolute overrides and reject relative or empty values", () => {
  assert.deepEqual(paths("/fixture", {}), { config: "/fixture/.config/chaldea", state: "/fixture/.local/state/chaldea", data: "/fixture/.local/share", runtime: "/fixture/.cache" });
  assert.deepEqual(paths("/fixture", { XDG_CONFIG_HOME: "/c", XDG_STATE_HOME: "/s", XDG_DATA_HOME: "/d", XDG_RUNTIME_DIR: "/r" }),
    { config: "/c/chaldea", state: "/s/chaldea", data: "/d", runtime: "/r" });
  assert.equal(paths("/fixture", { XDG_CONFIG_HOME: "relative", XDG_STATE_HOME: "" }).config, "/fixture/.config/chaldea");
});
test("one reader refuses symlinks, hardlinks, directories, FIFOs, unsafe modes and oversized secrets", () => {
  const f = scratchDir("private-config");
  try {
    const path = join(f.path, "secret"); writeFileSync(path, "private-value\n", { mode: 0o600 });
    assert.equal(privateFile(path), "private-value");
    for (const mode of [0o640, 0o604, 0o666]) {
      chmodSync(path, mode); assert.throws(() => privateFile(path), ConfigurationError);
    }
    chmodSync(path, 0o400); assert.equal(privateFile(path), "private-value");
    assert.throws(() => readTrustedFile(path, { secret: true, owners: [-1] }), ConfigurationError);
    symlinkSync(path, join(f.path, "link")); assert.throws(() => privateFile(join(f.path, "link")));
    assert.throws(() => privateFile(f.path));
    const fifo = join(f.path, "fifo"); assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    assert.throws(() => privateFile(fifo));
    assert.throws(() => readTrustedFile(path, { maxBytes: 2 }));
    linkSync(path, join(f.path, "hard")); assert.throws(() => privateFile(path));
    const empty = join(f.path, "empty"); writeFileSync(empty, "", { mode: 0o600 }); assert.throws(() => privateFile(empty));
  } finally { f.remove(); }
});
test("optional config accepts absence only and never exposes invalid input in errors", () => {
  const f = scratchDir("json-config");
  try {
    const path = join(f.path, "config.json");
    assert.deepEqual(readJson(path, true), {}); assert.throws(() => readJson(path));
    writeFileSync(path, '{"token":"DO-NOT-LOG",broken', { mode: 0o600 });
    assert.throws(() => readJson(path, true), error => error instanceof ConfigurationError && error.file === path && error.reason === "parse" && !error.message.includes("DO-NOT-LOG"));
    writeFileSync(path, "[]"); assert.throws(() => readJson(path));
    writeFileSync(path, "{}"); chmodSync(path, 0o666); assert.throws(() => readJson(path, true));
  } finally { f.remove(); }
});
test("fleet waits/quota files keep camelCase and reporting keys under XDG", () => {
  const f = scratchDir("fleet-config");
  try {
    environment({ XDG_CONFIG_HOME: f.path, XDG_STATE_HOME: join(f.path, "state"), XDG_RUNTIME_DIR: join(f.path, "run") }, () => {
      mkdirSync(join(f.path, "chaldea"));
      writeFileSync(configPath("waits"), JSON.stringify({ environment: "fixture", t3BaseDir: "/fixture/t3", answerBaseUrl: "http://127.0.0.1:7385" }));
      const waits = loadConfig();
      assert.equal(waits.t3BaseDir, "/fixture/t3");
      assert.equal(waits.database, join(f.path, "state/chaldea/waits.sqlite"));
      assert.equal(waits.socket, join(f.path, "run/chaldea-waits.sock"));
      writeFileSync(configPath("quota"), JSON.stringify({ tokenFile: "/fixture/token", stateFile: "/fixture/state", contexts: [
        { providers: ["codex"], home: "/fixture/home", codexHome: "/fixture/codex", assertRuntimeHome: true }
      ], lowHeadroomPercent: 17 }));
      const quota = loadHeadroomConfig(f.path);
      assert.equal(quota.lowHeadroomPercent, 17); assert.equal(quota.contexts[0]!.assertRuntimeHome, true);
      assert.equal(quotaConfig().tokenFile, "/fixture/token");
      const exec = { hosts: ["agent-a", "agent-b"], sshConfig: "/fixture/ssh", stateDir: "/fixture/state" };
      writeFileSync(configPath("exec"), JSON.stringify(exec));
      environment({ CHALDEA_SSH_CONFIG: undefined, CHALDEA_STATE_DIR: undefined, CHALDEA_EXEC_HOSTS: undefined }, () => {
        assert.equal(execConfig().sshConfig, exec.sshConfig); assert.deepEqual(execConfig().hosts, exec.hosts);
      });
      writeFileSync(configPath("events"), JSON.stringify({ url: "https://fixture.invalid", tokenHelper: "/fixture/helper" }));
      environment({ AKASHA_URL: undefined, AKASHA_TOKEN_HELPER: undefined }, () => assert.equal(eventsConfig().url, "https://fixture.invalid"));
    });
  } finally { f.remove(); }
});
test("legacy keys log names only and canonical keys win; Akasha retains strict JSON", () => {
  const lines: string[] = [];
  assert.deepEqual(aliases({ old: "SECRET", current: "canonical" }, { old: "current" }, createLogger(line => lines.push(line))), { current: "canonical" });
  assert.equal(lines.length, 1); assert.ok(!lines[0]!.includes("SECRET"));
  assert.equal(JSON.parse(lines[0]!).level, "warn");
  const f = scratchDir("akasha-config");
  try {
    const path = join(f.path, "akasha.json");
    writeFileSync(path, JSON.stringify({ access_state: "/fixture/state", nats_url: "nats://fixture" }));
    assert.deepEqual(akashaConfig(path), { accessState: "/fixture/state", natsUrl: "nats://fixture" });
    writeFileSync(path, '{"database":"a","database":"b"}'); assert.throws(() => akashaConfig(path));
  } finally { f.remove(); }
});
test("JSON logger owns timestamp/level/message; waits rotates old numeric and ISO records", () => {
  const lines: string[] = [], logger = createLogger(line => lines.push(line));
  logger.info("event", { at: "bad", level: "bad", message: "bad" });
  const record = JSON.parse(lines[0]!);
  assert.equal(record.message, "event"); assert.equal(record.level, "info");
  assert.equal(new Date(record.at).toISOString(), record.at);
  for (let n = 0; n < MAX_LINES_PER_MINUTE + 5; n++) logger.warn("bounded");
  logger.error("fatal"); assert.equal(JSON.parse(lines.at(-1)!).message, "fatal");
  const f = scratchDir("waits-log");
  try {
    const path = join(f.path, "waits.log");
    for (const at of [1, "1970-01-01T00:00:00.001Z"]) {
      writeFileSync(path, JSON.stringify({ at, event: "expired" }) + "\n", { mode: 0o600 });
      boundedLog(path)("started");
      const text = readFileSync(path, "utf8"), record = JSON.parse(text);
      assert.equal(record.event, "started"); assert.equal(record.level, "info");
      assert.ok(!text.includes("expired")); assert.equal(typeof record.at, "string");
    }
  } finally { f.remove(); }
});
test("test wrapper ignores inherited desktop XDG bases", () => {
  const f = scratchDir("xdg-scratch");
  try {
    const result = spawnSync("scripts/with-scratch", [process.execPath, "--input-type=module", "-e",
      'import { paths } from "./src/config/paths.ts"; import assert from "node:assert/strict"; for (const value of Object.values(paths())) assert.ok(value.startsWith(process.env.HOME + "/"));'],
      { encoding: "utf8", env: { ...process.env, CHALDEA_TEST_SCRATCH: join(f.path, "isolated"),
        XDG_CONFIG_HOME: "/real-config", XDG_STATE_HOME: "/real-state", XDG_DATA_HOME: "/real-data", XDG_RUNTIME_DIR: "/real-runtime" } });
    assert.equal(result.status, 0, result.stderr);
  } finally { f.remove(); }
});
test("Akasha trusted adapter keeps unsafe_input and waits failures use error level", () => {
  const f = scratchDir("adapter-error");
  try {
    const path = join(f.path, "unsafe"); writeFileSync(path, "not-a-secret", { mode: 0o600 }); chmodSync(path, 0o666);
    assert.throws(() => trustedFile(path, 1024), (error: any) => error.status === 400 && error.message === "unsafe_input");
    const log = join(f.path, "log"); boundedLog(log)("watcher_needs_attention");
    assert.equal(JSON.parse(readFileSync(log, "utf8")).level, "error");
  } finally { f.remove(); }
});
test("waits invalid configuration returns EX_CONFIG", async () => {
  const f = scratchDir("config-exit");
  try {
    const path = join(f.path, "waits.json"); writeFileSync(path, "{broken", { mode: 0o600 });
    assert.equal(await main(["waits", "serve", "--config", path]), 78);
  } finally { f.remove(); }
});
