import { connect, wsconnect, nkeyAuthenticator } from "@nats-io/transport-node";
import type { NatsConnection, ConnectionOptions } from "@nats-io/transport-node";
import { jetstream, jetstreamManager } from "@nats-io/jetstream";
import type { Consumer, JsMsg, JetStreamClient, JetStreamManager } from "@nats-io/jetstream";
import { ensure, HttpError, parse, MAX_ENVELOPE, validateEnvelope, hash } from "./schema.ts";
import type { Envelope } from "./schema.ts";
import type { EventStore } from "./store.ts";

export interface Delivery {
  data: Uint8Array; subject: string; seq: number; deliveryCount: number;
  ack(): void; nak(delay: number): void; term(): void;
}
export interface Bus {
  publish(subject: string, bytes: Uint8Array, id: string): Promise<void>;
  fetch(): Promise<Delivery[]>;
  firstSequence(): Promise<number>;
  close(): Promise<void>;
  isClosed?(): boolean;
}
export class NatsBus implements Bus {
  readonly nc: NatsConnection; readonly js: JetStreamClient; readonly manager: JetStreamManager; readonly consumer: Consumer;
  constructor(nc: NatsConnection, js: JetStreamClient, manager: JetStreamManager, consumer: Consumer) {
    this.nc = nc; this.js = js; this.manager = manager; this.consumer = consumer;
  }
  static async open(servers: string, seed?: Uint8Array, allowLoopback = false): Promise<NatsBus> {
    const url = new URL(servers);
    ensure(url.protocol === "wss:" || url.protocol === "tls:" ||
      (allowLoopback && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)), "secure_nats_required");
    ensure(seed || allowLoopback, "nats_identity_required");
    const options: ConnectionOptions = { servers, inboxPrefix: "_INBOX_akasha", timeout: 2000,
      maxReconnectAttempts: -1, reconnectTimeWait: 1000, ...(seed ? { authenticator: nkeyAuthenticator(seed) } : {}) };
    const nc = await (url.protocol.startsWith("ws") ? wsconnect(options) : connect(options));
    try {
      const js = jetstream(nc, { timeout: 2000 }), manager = await jetstreamManager(nc);
      const info = await manager.streams.info("AKASHA_EVENTS");
      ensure(info.config.max_msg_size === MAX_ENVELOPE && info.config.max_bytes > 0 && info.config.max_bytes <= 1024 ** 3 &&
        info.config.max_age > 0 && info.config.max_age <= 14 * 86400 * 1e9 && info.config.num_replicas === 1 &&
        info.config.subjects?.length === 1 && info.config.subjects[0] === "akasha.>" &&
        info.config.storage === "file" && info.config.retention === "limits" && info.config.discard === "old" &&
        info.config.max_consumers > 0 && info.config.max_consumers <= 8 &&
        info.config.duplicate_window === 600 * 1e9, "invalid_stream_configuration");
      const consumer = await js.consumers.get("AKASHA_EVENTS", "akasha-ingest");
      const ci = await consumer.info();
      ensure(ci.config.ack_policy === "explicit" && ci.config.ack_wait === 60 * 1e9 &&
        ci.config.max_deliver === 10 && ci.config.max_ack_pending === 1000 &&
        ci.config.max_batch === 500 && !ci.config.deliver_subject &&
        ci.config.deliver_policy === "all" && ci.config.replay_policy === "instant" &&
        (!ci.config.filter_subject || ci.config.filter_subject === "akasha.>") &&
        (!ci.config.filter_subjects || (ci.config.filter_subjects.length === 1 && ci.config.filter_subjects[0] === "akasha.>")), "invalid_consumer_configuration");
      return new NatsBus(nc, js, manager, consumer);
    } catch (e) { await nc.close(); throw e; }
  }
  async publish(subject: string, data: Uint8Array, id: string): Promise<void> {
    const ack = await this.js.publish(subject, data, { msgID: id, expect: { streamName: "AKASHA_EVENTS" } });
    ensure(ack.stream === "AKASHA_EVENTS", "wrong_puback");
  }
  async fetch(): Promise<Delivery[]> {
    const batch = await this.consumer.fetch({ max_messages: 100, expires: 1000 });
    const result: Delivery[] = [];
    for await (const m of batch) result.push(this.delivery(m));
    return result;
  }
  delivery(m: JsMsg): Delivery {
    return { data: m.data, subject: m.subject, seq: m.seq, deliveryCount: m.info.deliveryCount,
      ack: () => m.ack(), nak: ms => m.nak(ms), term: () => m.term() };
  }
  async firstSequence(): Promise<number> { return (await this.manager.streams.info("AKASHA_EVENTS")).state.first_seq; }
  async replay(seq: number): Promise<Delivery> {
    const m = await this.manager.streams.getMessage("AKASHA_EVENTS", { seq });
    ensure(m, "replay_sequence_missing", 410);
    return { data: m.data, subject: m.subject, seq: m.seq, deliveryCount: 1, ack() {}, nak() {}, term() {} };
  }
  isClosed(): boolean { return this.nc.isClosed(); }
  async close(): Promise<void> { await this.nc.close(); }
}
export class DeliveryWorker {
  readonly store: EventStore; readonly now: () => number; readonly open: () => Promise<Bus>;
  readonly validate: (event: Envelope) => void;
  bus: Bus | undefined; stopped = false; private pumping = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private consuming: Promise<void> | undefined;
  constructor(store: EventStore, now: () => number, open: () => Promise<Bus>, validate: (event: Envelope) => void = () => {}) {
    this.store = store; this.now = now; this.open = open; this.validate = validate;
  }
  start(): void { this.stopped = false; this.wake(); }
  wake(): void {
    if (this.stopped || this.pumping) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.pump(); }, 0);
  }
  async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      if (this.bus?.isClosed?.()) this.bus = undefined;
      this.bus ??= await this.open();
      if (!this.consuming) this.consuming = this.consume().finally(() => { this.consuming = undefined; });
      const oldest = this.store.scalar("SELECT coalesce(min(expires),0) FROM receipts WHERE state=\'pending\'");
      if (oldest && this.now() - (oldest - 180 * 86400) > 60) this.store.alarm = "backlog_over_60s";
      for (const p of this.store.pending(this.now())) {
        if (this.stopped) break;
        const e = parse(Buffer.from(p.envelope));
        try {
          await this.bus.publish("akasha." + e.source_id + "." + e.kind, Buffer.from(p.envelope), p.event_id);
          this.store.attempted(p.event_id, this.now(), 60);
        } catch {
          this.store.attempted(p.event_id, this.now(), Math.min(60, 2 ** Math.min(p.attempts, 6)));
          this.store.alarm = "publish_unavailable"; break;
        }
      }
    } catch { this.store.alarm = "broker_or_storage_unavailable"; }
    finally { this.pumping = false; if (!this.stopped) this.timer = setTimeout(() => { void this.pump(); }, 1000); }
  }
  async consume(): Promise<void> {
    while (!this.stopped && this.bus) {
      try {
        const first = await this.bus.firstSequence(), cursor = this.store.cursor("nats");
        if (first > cursor + 1) this.store.recordGap(cursor + 1, first - 1);
        for (const m of await this.bus.fetch()) {
          if (this.stopped) break;
          this.handle(m);
        }
      } catch { this.store.alarm = "consumer_unavailable"; await new Promise(r => setTimeout(r, 1000)); }
    }
  }
  handle(m: Delivery): void {
    let raw: Record<string, unknown> | undefined;
    try {
      ensure(m.data.length <= MAX_ENVELOPE, "broker_message_too_large");
      raw = parse(m.data); const e = validateEnvelope(raw);
      ensure(m.subject === "akasha." + e.source_id + "." + e.kind, "subject_mismatch");
      // A durable immutable admission remains accepted through later registry/lease changes.
      if (this.store.receipt(e.event_id)?.envelope_hash !== hash(e)) this.validate(e);
      this.store.project(e, m.seq, this.now()); m.ack();
    } catch (e) {
      if (e instanceof HttpError && e.status < 500) {
        try { this.store.quarantine(m.seq, e.message, this.now(), raw); m.term(); }
        catch { m.nak(5000); this.store.alarm = "quarantine_unavailable"; }
      } else {
        this.store.alarm = m.deliveryCount >= 10 ? "delivery_exhausted_replay_required" : "projection_unavailable";
        if (m.deliveryCount >= 10) { try {
          this.store.transaction(() => { if (!this.store.get("exhausted_first")) this.store.put("exhausted_first", String(m.seq)); }, 8192);
        } catch {} }
        m.nak(5000);
      }
    }
  }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer);
    await this.bus?.close(); await this.consuming;
    while (this.pumping) await new Promise(r => setTimeout(r, 10));
    await this.bus?.close(); await this.consuming;
  }
}
