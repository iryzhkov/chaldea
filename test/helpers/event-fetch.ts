// E2E transport fixture: real publisher/helper path, fake Akasha receipt boundary.
import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
const original = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (!url.startsWith("https://akasha.test/")) return original(input, init);
  const payload = JSON.parse(String(init!.body)), key = new Headers(init!.headers).get("Idempotency-Key")!;
  const file = process.env.FEED_RECORDER_LOG!;
  const prior = existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(s => JSON.parse(s)) : [];
  if (!prior.some(e => e.key === key)) appendFileSync(file, JSON.stringify({ key,
    args: ["post", payload.title, "--source", payload.source, "--host", payload.host,
      "--tag", payload.tags.join(" "), "--severity", payload.severity, "--body-file", "-"], body: payload.body }) + "\n");
  return new Response(JSON.stringify({ state: "visible", event_id: createHash("sha256").update(key).digest("hex") }), { status: 201 });
};
