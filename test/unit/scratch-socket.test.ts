import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { join } from "node:path";
import { scratchDir, SCRATCH_ROOT } from "../helpers/scratch.ts";
import { testSocketPath } from "../helpers/socket.ts";

assert.ok(process.env.HOME && process.env.HOME !== "/home/igor");
assert.equal(process.env.HOME, process.env.CHALDEA_TRUST_TEST_HOME);
assert.equal(process.env.HOME, SCRATCH_ROOT + "-home");

test("socket path guard enforces the byte limit, including UTF-8", () => {
  assert.equal(testSocketPath("a".repeat(99)), "a".repeat(99));
  assert.throws(() => testSocketPath("a".repeat(100)), /under 100 bytes/);
  assert.throws(() => testSocketPath("é".repeat(50)), /under 100 bytes/);
});

test("native-decisions socket fits below 100 bytes and actually listens", async () => {
  const dir = scratchDir("native-decisions"), server = createServer();
  try {
    const socket = testSocketPath(join(dir.path, "service.sock"));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    assert.equal(server.address(), socket);
  } finally {
    if (server.listening) await new Promise<void>((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve()));
    dir.remove();
  }
});
