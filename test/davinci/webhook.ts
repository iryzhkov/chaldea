import { createServer } from "node:http";
import { once } from "node:events";
import { authenticate, signature, BODY, type Coordinator } from "./proof.ts";

/** Loopback synthetic webhook for the spike, never a deployed ingress. */
export async function webhook(coordinator: () => Coordinator, key: Uint8Array) {
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/source-status") { res.writeHead(404).end(); return; }
    try {
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        const b = Buffer.from(chunk); bytes += b.length;
        if (bytes > 4096) throw new Error("webhook_refused");
        chunks.push(b);
      }
      const body = new TextDecoder("utf-8", {fatal:true}).decode(Buffer.concat(chunks));
      const header = (name: string) => {
        const value = req.headers[name]; if (typeof value !== "string") throw new Error("webhook_refused"); return value;
      };
      const delivery = header("x-delivery");
      authenticate(key, delivery, header("x-time"), body, header("x-signature"), Date.now());
      const assignment = coordinator().accept(delivery, body, Date.now());
      res.writeHead(202, {"content-type":"application/json"}).end(JSON.stringify({id:assignment.id}));
    } catch (error) { res.writeHead(error instanceof Error && error.message === "delivery_conflict" ? 409 : 403).end(); }
  });
  server.listen(0,"127.0.0.1");await once(server,"listening");
  const url = "http://127.0.0.1:" + (server.address() as {port:number}).port + "/source-status";
  return {
    async post(delivery: string, body = BODY, corrupt = false) {
      const timestamp = String(Date.now());
      return fetch(url, {method:"POST",body,headers:{"x-delivery":delivery,"x-time":timestamp,
        "x-signature":corrupt ? "0".repeat(64) : signature(key,delivery,timestamp,body)}});
    },
    async close() { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); },
  };
}
