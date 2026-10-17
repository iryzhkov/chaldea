import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { connect, nkeys } from "@nats-io/transport-node";
import { jetstreamManager, AckPolicy, StorageType, RetentionPolicy, DiscardPolicy } from "@nats-io/jetstream";
import { NatsBus, DeliveryWorker } from "../../src/akasha/bus.ts";
import { EventStore } from "../../src/akasha/store.ts";
import { N, scratch, registration, event } from "./helpers.ts";
import { hash } from "../../src/akasha/schema.ts";
import { Ingress } from "../../src/akasha/ingress.ts";
import type { Principal, Authorization } from "../../src/akasha/auth.ts";

const start = performance.now(), dir = scratch();
async function until(check: () => boolean, timeout: number): Promise<void> {
  const end = performance.now() + timeout;
  while (!check()) { assert.ok(performance.now() < end, "worker deadline"); await new Promise(r => setTimeout(r, 100)); }
}
const executable = process.env.NATS_SERVER; assert.ok(executable, "NATS_SERVER pinned binary required");
const listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
const gateway = nkeys.createUser(), host = nkeys.createUser();
const config = join(dir.path, "nats.conf");
writeFileSync(config, `host: "127.0.0.1"
port: ${port}
jetstream { store_dir: "${join(dir.path, "nats")}", max_file_store: 1073741824 }
accounts {
 CHALDEA {
  jetstream: enabled
  users: [
   { user: "fixture-admin", password: "fixture-only" }
   { nkey: "${gateway.getPublicKey()}", permissions: {
     publish: ["akasha.>", "$JS.API.INFO", "$JS.API.STREAM.INFO.AKASHA_EVENTS", "$JS.API.STREAM.MSG.GET.AKASHA_EVENTS", "$JS.API.CONSUMER.INFO.AKASHA_EVENTS.akasha-ingest", "$JS.API.CONSUMER.MSG.NEXT.AKASHA_EVENTS.akasha-ingest", "$JS.ACK.AKASHA_EVENTS.>"]
     subscribe: ["_INBOX_akasha.>"]
   }}
   { nkey: "${host.getPublicKey()}", permissions: { publish: ["chaldea.host.>"], subscribe: ["_INBOX_host.>"] }}
  ]
 }
}
`, { mode: 0o600 });
let server: ReturnType<typeof spawn> | undefined;
let serverLog = "";
async function startServer() {
  server = spawn(executable!, ["-c", config], { stdio: ["ignore", "ignore", "pipe"] });
  server.stderr!.on("data", b => { serverLog = (serverLog + b).slice(-8000); });
  for (let i = 0; i < 100; i++) {
    try { return await connect({ servers: "nats://127.0.0.1:" + port, user: "fixture-admin", pass: "fixture-only", timeout: 100, reconnect: false }); }
    catch { if (server.exitCode !== null) throw new Error(serverLog); await new Promise(r => setTimeout(r, 50)); }
  }
  throw new Error("server startup failed: " + serverLog);
}
async function stopServer() { if (server && server.exitCode === null) { server.kill("SIGTERM"); await once(server, "close"); } }
let admin = await startServer();
const manager = await jetstreamManager(admin, { timeout: 1000 });
await manager.streams.add({ name: "AKASHA_EVENTS", subjects: ["akasha.>"], storage: StorageType.File, retention: RetentionPolicy.Limits,
  discard: DiscardPolicy.Old, max_age: 14 * 86400e9, max_bytes: 1024 ** 3, max_msg_size: 327680, num_replicas: 1,
  max_consumers: 8, duplicate_window: 600e9 });
await manager.consumers.add("AKASHA_EVENTS", { durable_name: "akasha-ingest", ack_policy: AckPolicy.Explicit,
  ack_wait: 60e9, max_deliver: 10, max_ack_pending: 1000, max_batch: 500, filter_subject: "akasha.>" });
let store = new EventStore(join(dir.path, "events.db"), { initialize: true });
let bus: NatsBus | undefined;
let clockNow = N;
const now = () => clockNow;
let worker = new DeliveryWorker(store, now, async () => { throw new Error("manual pumping"); });
let logical = 0, conflicts = 0, lostResponses = 0, lostAcks = 0, redeliveries = 0;
const url = "nats://127.0.0.1:" + port;
const open = () => NatsBus.open(url, gateway.getSeed(), true);
try {
  // Account ACLs: a raw host cannot publish a forged Akasha source, gateway cannot administer streams.
  const attacker = await connect({ servers: url, authenticator: (await import("@nats-io/transport-node")).nkeyAuthenticator(host.getSeed()),
    inboxPrefix: "_INBOX_host", reconnect: false });
  let denied = false;
  const watch = (async () => { for await (const status of attacker.status()) if (status.type === "error") denied = true; })();
  attacker.publish("akasha.agent-a-daily-health.report", Buffer.from("{}")); await attacker.flush(); await new Promise(r => setTimeout(r, 100));
  assert.equal((await manager.streams.info("AKASHA_EVENTS")).state.messages, 0); assert.equal(denied, true);
  await attacker.close(); await watch;
  bus = await open();
  await assert.rejects(bus.manager.streams.delete("AKASHA_EVENTS"));
  assert.equal((await manager.streams.info("AKASHA_EVENTS")).config.name, "AKASHA_EVENTS");

  if (process.env.AKASHA_CONNECTION_ONLY === "1") {
    worker = new DeliveryWorker(store, now, open); worker.start();
    await until(() => worker.bus !== undefined, 10000);
    for (let i = 0; i < 20; i++) store.admit(event(i), hash(i), N);
    worker.wake(); await until(() => store.scalar("SELECT count(*) FROM events") === 20, 60000);
    await admin.close(); await stopServer();
    for (let i = 20; i < 40; i++) store.admit(event(i), hash(i), N);
    worker.wake(); await new Promise(r => setTimeout(r, 2500));
    assert.equal(store.scalar("SELECT count(*) FROM outbox"), 20); clockNow = N + 65;
    const reconnectStart = performance.now(); admin = await startServer();
    await until(() => store.scalar("SELECT count(*) FROM events") === 40, 60000);
    assert.equal(store.scalar("SELECT count(DISTINCT event_id) FROM events"), 40);
    const result = { establishedConnectionRestart: "pass", visible: 40, pending: store.scalar("SELECT count(*) FROM outbox"), drainMs: performance.now() - reconnectStart, node: process.version };
    if (process.env.AKASHA_RESULTS) writeFileSync(process.env.AKASHA_RESULTS, JSON.stringify(result, null, 2));
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
  // Production ingress idempotency, with rate limiting disabled only for accelerated storage fault load.
  const identity = { issuer: registration.issuer, profile: registration.profile, project: registration.project, source: registration.source,
    host: registration.host, source_id: registration.source_id, run_id: "service-lease-1" };
  const p: Principal = { identity, scope: { issuer: identity.issuer, profile: identity.profile, project: identity.project,
    source: identity.source, host: identity.host, global: false }, registration: { ...registration, mode: "service" },
    access: { claims: {} as never, validUntil: N + 300, async recheck() {} }, async recheck() {}, checkCommit() {} };
  const auth = { clock: { check: now } } as unknown as Authorization;
  let ingress = new Ingress(auth, store, () => {}, { waitMs: 0 }); ingress.rate = () => {};
  const publish = async (i: number) => {
    const payload = { v: 1, kind: "report", title: "logical " + i, data: { status: "healthy" } }, key = "fault/" + i;
    const receipt = await ingress.append(p, payload, key, false);
    if (i % 5 === 0) {
      // The HTTP result is lost after admission; caller repeats the same logical operation.
      lostResponses++; assert.equal((await ingress.append(p, payload, key, false)).event_id, receipt.event_id);
    }
    await assert.rejects(ingress.append(p, { ...payload, title: "conflicting" }, key, false),
      (e: unknown) => (e as { status: number }).status === 409); conflicts++;
    return receipt;
  };
  // 1-hour outage is modeled with stopped broker and persisted accepted events; wall-clock canary remains a rollout gate.
  await bus.close(); bus = undefined; await admin.close(); await stopServer();
  for (let i = 0; i < 1000; i++) { await publish(i); logical++; }
  const outageBytes = Number(store.health().pending_bytes); assert.ok(outageBytes < store.budget.outbox);
  store.close(); store = new EventStore(join(dir.path, "events.db"));
  worker = new DeliveryWorker(store, now, async () => { throw new Error("manual pumping"); });
  ingress = new Ingress(auth, store, () => {}, { waitMs: 0 }); ingress.rate = () => {};
  p.identity.run_id = "service-lease-2";
  // Exercise the SHIPPED start/pump/consume path while the broker is down, then reconnect/drain.
  let actualRedeliveries = 0, skippedAcks = 0;
  worker = new DeliveryWorker(store, now, async () => {
    const real = await open();
    return { publish: real.publish.bind(real), firstSequence: real.firstSequence.bind(real), close: real.close.bind(real),
      async fetch() { return (await real.fetch()).map(m => ({ ...m, ack() {
        if (m.deliveryCount === 1 && m.seq % 5 === 0) { skippedAcks++; return; }
        if (m.deliveryCount > 1) actualRedeliveries++;
        m.ack();
      } })); } };
  });
  worker.start(); await new Promise(r => setTimeout(r, 1500));
  assert.equal(store.scalar("SELECT count(*) FROM outbox"), 1000);
  admin = await startServer();
  const drainStart = performance.now();
  await until(() => store.scalar("SELECT count(*) FROM events") === 1000, 600000);
  const outageDrainMs = performance.now() - drainStart;
  await until(() => actualRedeliveries >= 200, 90000);
  assert.equal(skippedAcks, 200);
  await worker.stop(); bus = await open();
  worker = new DeliveryWorker(store, now, async () => { throw new Error("manual phase"); });
  async function drain() {
    assert.ok(bus);
    for (const item of store.pending(N, 100)) {
      const e = JSON.parse(item.envelope);
      // PubAck can be lost; retry uses the identical Nats-Msg-Id.
      await bus.publish("akasha." + e.source_id + "." + e.kind, Buffer.from(item.envelope), e.event_id);
      if (Number(e.title.split(" ")[1]) % 5 === 0) {
        await bus.publish("akasha." + e.source_id + "." + e.kind, Buffer.from(item.envelope), e.event_id);
      }
    }
    for (const m of await bus.fetch()) {
      const index = Number(JSON.parse(Buffer.from(m.data).toString()).title.split(" ")[1]);
      if (index % 5 === 0) {
        worker.handle({ ...m, ack() { lostAcks++; } });
        // Repeat delivery after a lost ACK, then acknowledge. SQL uniqueness is independent of broker dedup.
        worker.handle(m); redeliveries++;
      } else worker.handle(m);
    }
  }
  while (store.pending(N, 1).length) await drain();
  for (let begin = 1000; begin < 10000; begin += 100) {
    for (let i = begin; i < begin + 100; i++) { await publish(i); logical++; }
    while (store.pending(N, 1).length) await drain();
  }
  assert.equal(store.scalar("SELECT count(*) FROM events"), 10000);
  assert.equal(store.scalar("SELECT count(DISTINCT event_id) FROM events"), 10000);
  assert.equal(store.scalar("SELECT count(*) FROM outbox"), 0);
  process.stdout.write("10000 visible; waiting 601s for the real broker duplicate window to expire\n");
  await new Promise(resolve => setTimeout(resolve, 601000));
  // Retry after service restart and beyond the 10-minute broker window: SQLite receipt is authoritative.
  store.close(); store = new EventStore(join(dir.path, "events.db"));
  ingress = new Ingress({ clock: { check: () => N + 601 } } as unknown as Authorization, store, () => {}, { waitMs: 0 }); ingress.rate = () => {};
  for (let i = 0; i < 10000; i++) {
    const receipt = await publish(i); assert.equal(receipt.state, "visible");
  }
  assert.equal(store.scalar("SELECT count(*) FROM events"), 10000);
  const first = store.db.prepare("SELECT envelope FROM events ORDER BY seq LIMIT 1").get() as { envelope: string };
  const replay = JSON.parse(first.envelope);
  const before = (await bus.manager.streams.info("AKASHA_EVENTS")).state.last_seq;
  // Same Nats-Msg-Id after actual expiry must reach SQL again without creating another row.
  await bus.publish("akasha." + replay.source_id + "." + replay.kind, Buffer.from(first.envelope), replay.event_id);
  for (const m of await bus.fetch()) worker = new DeliveryWorker(store, () => N + 601, async () => bus!), worker.handle(m);
  assert.equal(store.scalar("SELECT count(*) FROM events"), 10000);
  assert.ok((await bus.manager.streams.info("AKASHA_EVENTS")).state.last_seq > before);
  // Remove an unconsumed stream sequence, then let the production loop expose the durable gap.
  const adminManager = await jetstreamManager(admin);
  await bus.publish("akasha." + replay.source_id + "." + replay.kind, Buffer.from(first.envelope), "gap/lost");
  await adminManager.streams.purge("AKASHA_EVENTS");
  await bus.publish("akasha." + replay.source_id + "." + replay.kind, Buffer.from(first.envelope), "gap/after");
  worker = new DeliveryWorker(store, () => N + 601, open); worker.start();
  await until(() => store.get("first_gap") !== undefined, 10000); await worker.stop();
  assert.equal(store.scalar("SELECT count(*) FROM events"), 10000);
  const health = store.health();
  assert.ok(Number(health.main_bytes) <= store.budget.main && Number(health.wal_bytes) <= store.budget.wal);
  const result = { logical, visible: store.scalar("SELECT count(*) FROM events"), duplicates: 0, conflicts,
    lostResponses, lostAcks, redeliveries, actualRedeliveries, skippedAcks, productionWorker: true, outageBytes, outageDrainMs, bounds: health,
    elapsedMs: performance.now() - start, realNats: "2.15.1", acl: "host forgery and gateway admin denied",
    note: "Accelerated fault/outage model; 7d parity, 1h wall-clock outage and 10 events/s latency canary require rollout." };
  const output = process.env.AKASHA_RESULTS; if (output) writeFileSync(output, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write(JSON.stringify(result) + "\n");
  }
} finally {
  await worker.stop(); await bus?.close(); await admin.close(); await stopServer(); store.close(); gateway.clear(); host.clear(); dir.remove();
}
