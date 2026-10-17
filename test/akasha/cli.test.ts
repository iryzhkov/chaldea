import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rig, project } from "./helpers.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import { httpServer } from "../../src/akasha/http.ts";

/** Frozen ac23a6f CLI exercises the server contract. Lane L owns corrected JWT helper/error exits. */
test("frozen feed CLI fixture matrix: aliases, defaults, filters, body files/stdin, json, full, show, URL and health", async () => {
  const r = await rig("operator");
  const ingress = new Ingress(r.auth, r.store, () => { queueMicrotask(() => project(r.store)); });
  const server = httpServer(ingress); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = "http://127.0.0.1:" + (server.address() as { port: number }).port;
  const home = join(r.dir.path, "home"); mkdirSync(home, { mode: 0o700 });
  const token = await r.token({ grants: [{ resource: r.r.source, actions: ["append", "read"] }] });
  const cli = async (args: string[], stdin = ""): Promise<string> => {
    const child = spawn("bash", ["test/akasha/fixtures/homelab-cli/bin/feed", ...args], { env: {
      PATH: process.env.PATH!, HOME: home, TMPDIR: r.dir.path, FEED_URL: base, FEED_TOKEN: token, TOOLFEEDBACK: "0",
      FEED_CONFIG: join(home, "absent"), FEED_KEY_FILE: join(home, "absent-key"), XDG_CONFIG_HOME: join(home, ".config"),
    }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = ""; child.stdout.on("data", b => { out += b; }); child.stderr.on("data", b => { err += b; });
    child.stdin.end(stdin); const [status] = await once(child, "close");
    assert.equal(status, 0, err); return out;
  };
  try {
    const body = join(r.dir.path, "body.txt"); writeFileSync(body, "fixture body\nsecond line\n");
    const created = JSON.parse(await cli(["post", "fixture title", "--source", r.r.source, "--host", r.r.host,
      "--severity", "warn", "--tag", "hello cli", "--link", "https://example.com/thread", "--body-file", body, "--json"])) as { id: number };
    const stdin = JSON.parse(await cli(["post", "stdin title", "--source", r.r.source, "--host", r.r.host, "--body-file", "-", "--json"], "stdin body\n")) as { id: number };
    assert.ok(created.id !== stdin.id);
    assert.equal(JSON.parse(await cli(["recent", "--json"])).length, 2);
    assert.equal(JSON.parse(await cli(["list", "--since", "12h", "--host", r.r.host, "--source", r.r.source,
      "--severity", "warn", "--tag", "hello", "--grep", "fixture", "--limit", "1", "--json"])).length, 1);
    assert.ok((await cli(["recent", "--full"])).includes("second line"));
    assert.ok((await cli(["list"])).includes("fixture title"));
    assert.equal(JSON.parse(await cli(["show", String(created.id)])).id, created.id);
    assert.ok((await cli(["open"])).startsWith(base + "/?token="));
    assert.equal(await cli(["url"]), await cli(["open"]));
    assert.ok((await cli(["health"])).includes('"ok":true'));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); r.close(); }
});
