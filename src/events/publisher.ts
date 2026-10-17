// Source-bound service publication. No static feed credential is consulted.
import { eventsConfig } from "../config/events.ts";
import { spawn } from "node:child_process";
export interface Publication { key: string; source: string; host: string; payload: Record<string, unknown> }
export interface PublisherOptions {
  url?: string; helper?: string; timeoutMs?: number;
  token?: (event: Publication) => Promise<string>;
  fetch?: typeof globalThis.fetch;
}
export async function helperToken(helper: string, event: Publication): Promise<string> {
  if (!helper.startsWith("/")) throw new Error("token_helper_unavailable");
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const k of ["FEED_TOKEN", "FEED_KEY_FILE", "FEED_CONFIG"]) delete env[k];
    const child = spawn(helper, ["--audience", "akasha", "--action", "append",
      "--source", event.source, "--host", event.host, "--kind", String(event.payload.kind)],
      { env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let output = "", done = false;
    const kill = () => { try { process.kill(-child.pid!, "SIGKILL"); } catch {} };
    const timer = setTimeout(() => { kill(); finish(false); }, 2000);
    const finish = (ok: boolean) => {
      if (done) return; done = true; clearTimeout(timer);
      const token = output.trim();
      if (ok && token.length <= 16384 && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) resolve(token);
      else reject(new Error("token_helper_failed"));
    };
    child.stdout.on("data", (b: Buffer) => {
      if (Buffer.byteLength(output) + b.length > 16385) { kill(); finish(false); }
      else output += b.toString();
    });
    child.once("error", () => finish(false));
    child.once("close", code => finish(code === 0));
  });
}
/** True only after a visible durable receipt. Every other outcome retains the intent. */
export async function publish(event: Publication, options: PublisherOptions = {}): Promise<boolean> {
  try {
    if (!/^[\x20-\x7e]{1,256}$/.test(event.key)) return false;
    const config = eventsConfig();
    const url = new URL(options.url ?? config.url ?? "");
    if (url.protocol !== "https:" || url.username || url.password) return false;
    url.pathname = "/api/v1/events"; url.search = ""; url.hash = "";
    const token = await (options.token ? options.token(event) :
      helperToken(options.helper ?? config.tokenHelper ?? "", event));
    const bytes = JSON.stringify(event.payload);
    if (Buffer.byteLength(bytes) > 64 * 1024) return false;
    const response = await (options.fetch ?? fetch)(url, { method: "POST", redirect: "error",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", "Idempotency-Key": event.key },
      body: bytes, signal: AbortSignal.timeout(options.timeoutMs ?? 5000) });
    // Bound even an unexpected proxy response.
    const reader = response.body?.getReader();
    if (!reader) return false;
    let body = ""; let size = 0;
    try {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 8192) return false;
        body += new TextDecoder().decode(chunk.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    const receipt = JSON.parse(body);
    return ((response.status === 201 && receipt.state === "visible") ||
      (response.status === 410 && receipt.state === "tombstone")) &&
      typeof receipt.event_id === "string" && /^[a-f0-9]{64}$/.test(receipt.event_id);
  } catch { return false; }
}
