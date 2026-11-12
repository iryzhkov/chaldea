import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

test("MCP exposes exactly the two advisory route tools without service configuration", () => {
  const result = spawnSync(process.execPath, ["bin/chaldea", "mcp"], {
    encoding: "utf8", input: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).result.tools.map((tool: { name: string }) => tool.name),
    ["chaldea_route", "chaldea_route_review_pair"]);
});
