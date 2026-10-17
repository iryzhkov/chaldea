import { clockHealth, HEALTH_FIELDS } from "../access/clock.ts";
import { configFailure, readTrustedFile, ConfigurationError } from "../config/files.ts";
import { akashaConfig } from "../config/akasha.ts";
import { createLogger } from "../config/log.ts";
import { EXIT } from "../config/exit.ts";
import { parseArgs } from "node:util";
import { AccessState, TrustStore, TRUST_POLL_SECONDS } from "../access/trust.ts";
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
  try { return readTrustedFile(path, { maxBytes: max, secret: privateFile, owners: [0, process.geteuid!()] }); }
  catch (error) {
    // Keep the existing request-time adapter error contract.
    if (error instanceof ConfigurationError && error.reason === "read_size") ensure(false, "input_too_large");
    if (error instanceof ConfigurationError && ["type", "links", "owner", "mode", "size"].includes(error.reason)) ensure(false, "unsafe_input");
    throw error;
  }
}
const USAGE = `Usage: akasha <serve|init|import|parity|export|backup|replay> [--config FILE]
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
    if (positionals.length !== 1) { process.stderr.write(USAGE); return EXIT.usage; }
    const c = akashaConfig(v.config);
    const string = (key: string): string => {
      const value = c[key];
      if (typeof value !== "string" || value.length === 0) throw new ConfigurationError("missing_config_" + key);
      return value;
    };
    const command = positionals[0]!;
    store = new EventStore(string("database"), { initialize: command === "init" });
    if (command === "init") { process.stdout.write("Akasha data initialized; provision independent access state/trust before serving.\n"); return 0; }
    if (command === "export" || command === "backup") {
      ensure(v.output, "output_required");
      const result = command === "export" ? reverseExport(store, v.output) : await snapshot(store, v.output);
      process.stdout.write(JSON.stringify({ ok: true, rows: result }) + "\n"); return 0;
    }
    state = new AccessState(string("accessState"));
    const clock = clockHealth(state, () => trustedFile(string("clockHealthFile"), 1024), {
      decode: parse, fields: h => fields(h, HEALTH_FIELDS), check: ensure,
    });
    if (!Array.isArray(c.anchors)) throw new ConfigurationError("anchors_required");
    const trust = new TrustStore(state, clock, c.anchors as TrustAnchor[]);
    const refresh = async () => { await trust.install(trustedFile(string("bundleFile"), 262145).toString("utf8").trim()); };
    await refresh();
    if (command === "import" || command === "parity") {
      ensure(v.snapshot, "snapshot_required");
      const result = command === "import" ? bridge(store, v.snapshot, clock.check()) : parity(store, v.snapshot, clock.check());
      process.stdout.write(JSON.stringify(result) + "\n");
      return "missing" in result && (result.missing || result.extra || result.changed) ? 1 : 0;
    }
    const seed = c.natsSeedFile ? trustedFile(string("natsSeedFile"), 256, true) : undefined;
    const open = () => NatsBus.open(string("natsUrl"), seed ? Buffer.from(seed.toString("utf8").trim()) : undefined);
    if (!Array.isArray(c.registry)) throw new ConfigurationError("registry_required");
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
    if (c.bind !== "127.0.0.1" && c.bind !== "::1") throw new ConfigurationError("loopback_ingress_required");
    if (!Number.isInteger(c.port) || (c.port as number) <= 0 || (c.port as number) >= 65536) throw new ConfigurationError("invalid_port");
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
  } catch (error) {
    createLogger().error("akasha operation failed; inspect configured adapters, authorization and capacity", configFailure(error));
    return error instanceof ConfigurationError ? EXIT.config : EXIT.failure;
  } finally { await worker?.stop(); store?.close(); state?.close(); }
}
