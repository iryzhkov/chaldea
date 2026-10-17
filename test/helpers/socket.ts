import assert from "node:assert/strict";

// Leave room below Linux sockaddr_un's 108-byte limit, including its terminator.
export function testSocketPath(path: string): string {
  const bytes = Buffer.byteLength(path);
  assert.ok(bytes < 100, `test Unix socket path must be under 100 bytes (got ${bytes}): ${path}`);
  return path;
}
