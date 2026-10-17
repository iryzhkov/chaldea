import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rig, project, scratch } from "./helpers.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { httpServer } from "../../src/akasha/http.ts";

type Result = { status: number | null; out: string; err: string };
function runner(home: string, base: string) {
  return async (args: string[], credential: Record<string, string>, stdin = ""): Promise<Result> => {
    const child = spawn("bash", ["test/akasha/fixtures/homelab-cli/bin/feed", ...args], { env: {
      PATH: process.env.PATH!, HOME: home, TMPDIR: home, FEED_URL: base, TOOLFEEDBACK: "0", USER: "legacy-agent",
      FEED_CONFIG: join(home, "absent"), FEED_KEY_FILE: join(home, "key"), XDG_CONFIG_HOME: join(home, ".config"),
      ...credential,
    }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
    child.stdin.end(stdin); const [status] = await once(child, "close");
    return { status, out, err };
  };
}
function ok(result: Result): string { assert.equal(result.status, 0, result.err); return result.out; }
function refused(result: Result): void {
  assert.notEqual(result.status, 0); assert.equal(result.out, ""); assert.ok(result.err.length > 0);
}
async function listen(server: Server): Promise<string> {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return "http://127.0.0.1:" + (server.address() as { port: number }).port;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}

// Upstream d0b64f6, unchanged; see fixtures/homelab-cli/README.md.
test("feed CLI: legacy key file retains defaults, bearer header and open/url", { timeout: 30_000 }, async () => {
  const dir = scratch(), home = join(dir.path, "home"); mkdirSync(home, { mode: 0o700 });
  const key = "legacy-fixture-key"; writeFileSync(join(home, "key"), key + "\n", { mode: 0o600 });
  const requests: Array<{ method: string; url: string; authorization: string | undefined; key: string | undefined; body: Record<string, unknown> }> = [];
  // Akasha accepts scoped JWTs only. This loopback legacy contract fixture proves
  // the dotless credential branch without claiming Akasha accepts static keys.
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const request = { method: req.method!, url: req.url!, authorization: req.headers.authorization,
      key: req.headers["idempotency-key"] as string | undefined, body: body ? JSON.parse(body) : {} };
    requests.push(request);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.method === "POST" ? { id: 1, ...request.body } : []));
  });
  try {
    const base = await listen(server), cli = runner(home, base);
    const row = JSON.parse(ok(await cli(["post", "legacy title", "--json"], {})));
    assert.equal(row.source, "legacy-agent"); assert.equal(typeof row.host, "string"); assert.ok(row.host);
    assert.deepEqual(JSON.parse(ok(await cli(["recent", "--json"], {}))), []);
    assert.equal(ok(await cli(["open"], {})), base + "/?token=" + key + "\n");
    assert.equal(ok(await cli(["url"], {})), base + "/?token=" + key + "\n");
    assert.equal(requests.length, 2);
    assert.ok(requests.every(r => r.authorization === "Bearer " + key));
    assert.match(requests[0]!.key!, /^[0-9a-f-]{36}$/);
    assert.equal(requests[0]!.url, "/api/entries");
    const query = new URL(requests[1]!.url, base).searchParams;
    assert.equal(query.get("since"), "7d"); assert.equal(query.get("limit"), "50");
  } finally { await close(server); dir.remove(); }
});

test("feed CLI against Akasha: scoped matrix, helper, idempotency and error exits", { timeout: 60_000 }, async () => {
  const r = await rig("operator");
  const ingress = new Ingress(r.auth, r.store, () => { queueMicrotask(() => project(r.store)); });
  const server = httpServer(ingress);
  const home = join(r.dir.path, "home"); mkdirSync(home, { mode: 0o700 });
  const token = await r.token({ grants: [{ resource: r.r.source, actions: ["append", "read"] }] });
  const credential = { FEED_TOKEN: token };
  try {
    const base = await listen(server), cli = runner(home, base);
    const body = join(home, "body.txt"); writeFileSync(body, "fixture body\nsecond line\n");
    const args = ["post", "fixture title", "--source", r.r.source, "--host", r.r.host,
      "--severity", "warn", "--tag", "hello cli", "--link", "https://example.com/thread", "--body-file", body, "--json"];
    const keyed = { ...credential, FEED_IDEMPOTENCY_KEY: "fixture-stable-key" };
    const created = JSON.parse(ok(await cli(args, keyed))) as { id: number };
    assert.equal(JSON.parse(ok(await cli(args, keyed))).id, created.id);
    // Changed content with the same logical producer key is a refusal, including --json.
    refused(await cli(["post", "changed title", "--json"], keyed));
    const stdin = JSON.parse(ok(await cli(["post", "stdin title", "--body-file", "-", "--json"], credential, "stdin body\n"))) as { id: number };
    assert.notEqual(created.id, stdin.id);
    const rows = JSON.parse(ok(await cli(["recent", "--json"], credential)));
    assert.equal(rows.length, 2);
    assert.ok(rows.every((row: { source: string; host: string }) => row.source === r.r.source && row.host === r.r.host));
    assert.equal(JSON.parse(ok(await cli(["list", "--since", "12h", "--host", r.r.host, "--source", r.r.source,
      "--severity", "warn", "--tag", "hello", "--grep", "fixture", "--limit", "1", "--json"], credential))).length, 1);
    assert.ok(ok(await cli(["recent", "--full"], credential)).includes("second line"));
    assert.ok(ok(await cli(["list"], credential)).includes("fixture title"));
    assert.equal(JSON.parse(ok(await cli(["show", String(created.id)], credential))).id, created.id);
    assert.equal(JSON.parse(ok(await cli(["health", "--raw"], credential))).response.ok, true);
    for (const command of ["open", "url"]) {
      const result = await cli([command], credential); refused(result);
      assert.ok(!result.err.includes(token)); assert.match(result.err, /refuses scoped credentials/);
    }
    refused(await cli(["post", "wrong identity", "--source", "foreign", "--json"], credential));
    refused(await cli(["recent", "--json"], { FEED_TOKEN: "malformed.scoped.token" }));
    assert.equal(JSON.parse(ok(await cli(["recent", "--json"], credential))).length, 2);

    const helper = join(home, "token-helper");
    writeFileSync(helper, '#!/bin/sh\nprintf "%s" "$FIXTURE_TOKEN"\n', { mode: 0o700 });
    const fromHelper = { FEED_TOKEN_HELPER: helper, FIXTURE_TOKEN: token };
    assert.equal(JSON.parse(ok(await cli(["recent", "--json"], fromHelper))).length, 2);
    const helperRow = JSON.parse(ok(await cli(["post", "helper title", "--json"], fromHelper)));
    assert.equal(helperRow.source, r.r.source); assert.equal(helperRow.host, r.r.host);
    refused(await cli(["open"], fromHelper));
    // A scoped token file is supported too. A failed helper must never fall back
    // to that otherwise valid file.
    writeFileSync(join(home, "key"), token + "\n", { mode: 0o600 });
    assert.equal(JSON.parse(ok(await cli(["recent", "--json"], {}))).length, 3);
    writeFileSync(helper, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    refused(await cli(["recent", "--json"], { FEED_TOKEN_HELPER: helper }));
    assert.equal(JSON.parse(ok(await cli(["recent", "--json"], credential))).length, 3);
  } finally { await close(server); r.close(); }
});
