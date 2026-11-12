import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchDir } from "../helpers/scratch.ts";

test("MCP exposes exactly the two advisory route tools without service configuration", () => {
  const result = spawnSync(process.execPath, ["bin/chaldea", "mcp"], {
    encoding: "utf8", input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result.tools.map((tool: { name: string }) => tool.name),
    ["chaldea_route", "chaldea_route_review_pair"]);
});

test("MCP ignores the legacy config file and still exposes only route tools", () => {
  const d = scratchDir("mcp-config");
  try {
    const path = join(d.path, "mcp.json");
    writeFileSync(path, "{retired config is not read");
    const result = spawnSync(process.execPath, ["bin/chaldea", "mcp", "--config", path], {
      encoding: "utf8", input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).result.tools.map((tool: { name: string }) => tool.name),
      ["chaldea_route", "chaldea_route_review_pair"]);
  } finally { d.remove(); }
});

test("MCP rejects malformed legacy config arguments", () => {
  for (const args of [["--config"], ["--config", ""], ["--config", "--help"],
    ["--config", "one", "two"], ["--config", "one", "--config", "two"],
    ["--unknown"], ["--help", "extra"], [""]]) {
    const result = spawnSync(process.execPath, ["bin/chaldea", "mcp", ...args], { encoding: "utf8", input: "" });
    assert.equal(result.status, 64, JSON.stringify(args) + result.stderr);
  }
});
