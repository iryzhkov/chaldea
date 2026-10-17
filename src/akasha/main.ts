import { clockHealth } from "../access/clock.ts";
import { constants, openSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { AccessState, Clock, TrustStore, TRUST_POLL_SECONDS } from "../access/trust.ts";
import type { TrustAnchor } from "../access/trust.ts";
import { Authorization } from "./auth.ts";
import type { Registration } from "./auth.ts";
import { DeliveryWorker, NatsBus } from "./bus.ts";
import { EventStore } from "./store.ts";
import { Ingress } from "./ingress.ts";
import { httpServer } from "./http.ts";
import { maintain, snapshot } from "./maintenance.ts";
import { bridge, parity, reverseExport } from "./migration/feed.ts";
import { ensure, parse, fields } from "./schema.ts";

export function trustedFile(path: string, max: number, privateFile = false): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    ensure(stat.isFile() && stat.nlink === 1 && stat.size <= max && (stat.uid === 0 || stat.uid === process.geteuid!()) &&
      (stat.mode & (privateFile ? 0o077 : 0o022)) === 0, "unsafe_input");
    const bytes = readFileSync(fd); ensure(bytes.length <= max, "input_too_large"); return bytes;
  } finally { closeSync(fd); }
}
const USAGE = `Usage: akasha <serve|init|import|parity|export|backup|replay> --config FILE
  import/parity --snapshot FILE       consistent read-only feedd snapshot; import is bounded to 100 rows/run
  export/backup --output FILE         private local output, never the live feedd database
  replay --from SEQ --to SEQ          bounded operator replay (at most 100 broker sequences)
Config and clock-health/trust updater files are operator-owned. No minting, keys or deployment.
`;
export async function main(args: string[]): Promise<number> {
  process.umask(0o077);
  let store: EventStore | undefined, state: AccessState | undefined, worker: DeliveryWorker | undefined;
  try {
    const { values: v, positionals } = parseArgs({ args, allowPositionals: true, options: {
      config: { type: "string" }, snapshot: { type: "string" }, output: { type: "string" },
      from: { type: "string" }, to: { type: "string" }, help: { type: "boolean" },
    } });
    if (v.help) { process.stdout.write(USAGE); return 0; }
    ensure(v.config && positionals.length === 1, "usage");
    const c = parse(trustedFile(v.config, 256 * 1024));
    fields(c, ["database", "access_state", "anchors", "bundle_file", "clock_health_file", "registry", "nats_url", "nats_seed_file", "bind", "port"]);
    const string = (key: string): string => { ensure(typeof c[key] === "string" && c[key].length > 0, "missing_config_" + key); return c[key]; };
    const command = positionals[0]!;
    store = new EventStore(string("database"), { initialize: command === "init" });
    if (command === "init") { process.stdout.write("Akasha data initialized; provision independent access state/trust before serving.\n"); return 0; }
    if (command === "export" || command === "backup") {
      ensure(v.output, "output_required");
      const result = command === "export" ? reverseExport(store, v.output) : await snapshot(store, v.output);
      process.stdout.write(JSON.stringify({ ok: true, rows: result }) + "\n"); return 0;
    }
    state = new AccessState(string("access_state"));
    const clock = clockHealth(state, () => trustedFile(string("clock_health_file"), 1024));
    ensure(Array.isArray(c.anchors), "anchors_required");
    const trust = new TrustStore(state, clock, c.anchors as TrustAnchor[]);
    const refresh = async () => { await trust.install(trustedFile(string("bundle_file"), 262145).toString("utf8").trim()); };
    await refresh();
    if (command === "import" || command === "parity") {
      ensure(v.snapshot, "snapshot_required");
      const result = command === "import" ? bridge(store, v.snapshot, clock.check()) : parity(store, v.snapshot, clock.check());
      process.stdout.write(JSON.stringify(result) + "\n");
      return "missing" in result && (result.missing || result.extra || result.changed) ? 1 : 0;
    }
    const seed = c.nats_seed_file ? trustedFile(string("nats_seed_file"), 256, true) : undefined;
    const open = () => NatsBus.open(string("nats_url"), seed ? Buffer.from(seed.toString("utf8").trim()) : undefined);
    ensure(Array.isArray(c.registry), "registry_required");
    const auth = new Authorization(c.registry as Registration[], trust, clock);
    worker = new DeliveryWorker(store, () => clock.check(), open, e => auth.validateDelivery(e));
    if (command === "replay") {
      const from = Number(v.from), to = Number(v.to);
      ensure(Number.isSafeInteger(from) && Number.isSafeInteger(to) && from > 0 && to >= from && to - from < 100, "invalid_replay_range");
      const bus = await open();
      try { for (let seq = from; seq <= to; seq++) worker.handle(await bus.replay(seq)); }
      finally { await bus.close(); }
      process.stdout.write(JSON.stringify(store.health()) + "\n"); return store.alarm ? 1 : 0;
    }
    ensure(command === "serve", "unknown_command");
    const ingress = new Ingress(auth, store, () => worker!.wake()), server = httpServer(ingress);
    ensure(c.bind === "127.0.0.1" || c.bind === "::1", "loopback_ingress_required");
    ensure(Number.isInteger(c.port) && (c.port as number) > 0 && (c.port as number) < 65536, "invalid_port");
    let stopped = false, sweeping: Promise<void> | undefined, sweepRetry: ReturnType<typeof setTimeout> | undefined;
    const sweep = () => { if (!sweeping) sweeping = maintain(store!, clock.check(), () => stopped).finally(() => {
      sweeping = undefined;
      if (!stopped && store!.alarm === "maintenance_or_capacity_failure") sweepRetry = setTimeout(sweep, 1000);
    }); };
    sweep(); worker.start();
    const update = setInterval(() => { void refresh().catch(() => { store!.alarm = "trust_update_unavailable"; }); }, TRUST_POLL_SECONDS * 1000);
    const maintenance = setInterval(() => { try { sweep(); } catch { store!.alarm = "clock_unhealthy"; } }, 3600_000);
    server.listen(c.port as number, c.bind);
    const stop = () => { server.close(); server.closeAllConnections(); };
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject); server.once("close", resolve);
        process.once("SIGTERM", stop); process.once("SIGINT", stop);
      });
    } finally { stopped = true; clearInterval(update); clearInterval(maintenance); if (sweepRetry) clearTimeout(sweepRetry); await sweeping;
      process.off("SIGTERM", stop); process.off("SIGINT", stop); }
    return 0;
  } catch {
    process.stderr.write("akasha: operation failed; inspect configured adapters, authorization and capacity\n");
    return 1;
  } finally { await worker?.stop(); store?.close(); state?.close(); }
}
