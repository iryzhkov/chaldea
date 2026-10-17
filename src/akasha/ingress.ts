import { randomUUID } from "node:crypto";
import type { Authorization, Principal } from "./auth.ts";
import { ownedKind } from "./auth.ts";
import { canonical, ensure, eventId, hash, idempotencyKey, normalize, MAX_EVENT, MAX_ENVELOPE, HttpError } from "./schema.ts";
import type { Envelope, Kind } from "./schema.ts";
import type { EventStore, Receipt } from "./store.ts";

export function operationId(p: Principal, kind: Kind, key: string): string {
  return eventId([p.identity.issuer, p.identity.profile, p.identity.project, p.identity.source, p.identity.host, kind,
    ...(p.registration.mode === "report" ? [p.identity.run_id] : []), key]);
}
export class Ingress {
  readonly auth: Authorization; readonly store: EventStore; readonly now: () => number;
  readonly wake: () => void; readonly waitMs: number;
  private readonly rates = new Map<string, { tokens: number; at: number }>();
  constructor(auth: Authorization, store: EventStore, wake: () => void, options: { waitMs?: number } = {}) {
    this.auth = auth; this.store = store; this.wake = wake; this.now = () => auth.clock.check(); this.waitMs = options.waitMs ?? 1800;
  }
  rate(p: Principal): void {
    const now = performance.now() / 1000, id = p.identity.source_id;
    const r = this.rates.get(id) ?? { tokens: 100, at: now };
    r.tokens = Math.min(100, r.tokens + Math.max(0, now - r.at) * 10); r.at = now;
    ensure(r.tokens >= 1, "rate_limit", 429); r.tokens--; this.rates.set(id, r);
  }
  async append(p: Principal, payload: Record<string, unknown>, key: string | undefined, legacy: boolean): Promise<Receipt> {
    this.rate(p);
    const input = normalize(payload, p.identity, legacy);
    ownedKind(p, input.kind, input.data);
    const logicalKey = idempotencyKey(key ?? (legacy ? randomUUID() : undefined));
    const id = operationId(p, input.kind, logicalKey), requestHash = hash(input);
    // Caller assertions and authorization-run metadata do not change service retry identity.
    const old = this.store.ownedReceipt(id, p.scope);
    await p.recheck();
    if (old) { ensure(old.request_hash === requestHash, "idempotency_conflict", 409); return this.visible(p, old); }
    const now = this.now(), time = new Date(now * 1000).toISOString();
    const event: Envelope = { ...input, ...p.identity, v: 1, event_id: id, received_at: time,
      occurred_at: input.occurred_at ?? time, provenance: { type: "verified", request_hash: requestHash, feed_id: null } };
    ensure(Buffer.byteLength(canonical(event)) <= (legacy ? MAX_ENVELOPE : MAX_EVENT) - 32, "event_too_large", 413);
    // recheck completed immediately before synchronous, durable admission.
    const receipt = this.store.admit(event, requestHash, now, undefined, () => p.checkCommit());
    this.wake();
    return this.visible(p, receipt);
  }
  async visible(p: Principal, receipt: Receipt): Promise<Receipt> {
    if (receipt.state === "pending") await this.store.waitReceipt(receipt.event_id, this.waitMs);
    await p.recheck();
    const current = this.store.ownedReceipt(receipt.event_id, p.scope);
    ensure(current, "payload_expired", 410);
    return current;
  }
  async lookup(p: Principal, kind: string, key: string): Promise<Receipt> {
    ownedKind(p, kind as Kind, {});
    const id = operationId(p, kind as Kind, idempotencyKey(key));
    await p.recheck();
    const r = this.store.ownedReceipt(id, p.scope);
    if (!r) throw new HttpError(404, "no_such_receipt");
    return r;
  }
}
