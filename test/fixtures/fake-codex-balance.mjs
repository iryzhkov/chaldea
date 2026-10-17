#!/usr/bin/env node
// No provider is invoked: this executable implements only the fixed quota-read exchange.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
const home = process.env.HOME;
if (!home || home === "/home/igor" || !existsSync(join(home, "quota-fake-home"))) process.exit(80);
const scenario = JSON.parse(readFileSync(join(home, "scenario.json"), "utf8"));
if (process.argv.slice(2).join(" ") !== "app-server --listen stdio://") process.exit(81);
if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN ||
    process.env.OPENAI_BASE_URL || process.env.T3_TOKEN) process.exit(82);
if (process.env.CODEX_HOME !== scenario.codexHome) process.exit(83);
const send = o => process.stdout.write(JSON.stringify(o) + "\n");
const input = createInterface({ input: process.stdin });
input.on("line", line => {
  const m = JSON.parse(line);
  appendFileSync(join(home, "requests.jsonl"), JSON.stringify(m) + "\n");
  if (m.method === "initialize") {
    send({ id: m.id, result: {} });
  } else if (m.method === "initialized") {
    // notification, no reply
  } else if (m.method === "account/rateLimits/read") {
    if (scenario.mode === "hang") return;
    if (scenario.mode === "overflow") { process.stdout.write("x".repeat(1024 * 1024 + 1)); return; }
    if (scenario.mode === "error") { send({ id: m.id, error: { code: 429, message: "PRIVATE_ERROR_ACCOUNT" } }); return; }
    send({ method: "account/rateLimits/updated", params: { accountId: "PRIVATE_NOTIFICATION", rateLimits: {} } });
    send({ id: m.id, result: scenario.result });
  } else process.exit(84);
});
