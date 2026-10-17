import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/** Resend only with a stable remote idempotency key. Dedupe claims before an
 * ambiguous side effect when the sink has no receipt protocol. Storage owns
 * durability, capacity and any transaction that must include the acknowledgement. */
export type Ambiguity = "resend" | "dedupe";
export interface OutboxStorage<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): unknown;
  delete(key: string): unknown;
  entries(): Iterable<[string, T]>;
}
export class Outbox<T> {
  readonly storage: OutboxStorage<T>;
  readonly ambiguity: Ambiguity;
  constructor(storage: OutboxStorage<T>, ambiguity: Ambiguity) { this.storage = storage; this.ambiguity = ambiguity; }
  entries(): Array<[string, T]> { return [...this.storage.entries()]; }
  values(): T[] { return this.entries().map(([, value]) => value); }
  get size(): number { return this.entries().length; }
  has(key: string): boolean { return this.storage.get(key) !== undefined; }
  /** A duplicate never replaces the first payload or its acknowledgement. */
  enqueue(key: string, value: T): boolean {
    if (this.has(key)) return false;
    this.storage.set(key, value); return true;
  }
  discard(key: string): void { this.storage.delete(key); }
  async deliver(key: string, send: (value: T) => Promise<boolean>, acknowledge: (value: T) => boolean | void): Promise<boolean> {
    const value = this.storage.get(key); if (value === undefined) return false;
    if (this.ambiguity === "dedupe") {
      if (acknowledge(value) === false) return false;
      this.discard(key); await send(value); return true;
    }
    if (!await send(value)) return false;
    acknowledge(value); this.discard(key); return true;
  }
}
/** An adapter for existing tables: no schema or serialized payload changes. */
export function sqliteOutbox<T>(db: DatabaseSync, options: {
  table: string; key: string; columns: readonly string[];
  encode(value: T): SQLInputValue[]; decode(row: Record<string, unknown>): T;
}): OutboxStorage<T> {
  const quote = (s: string) => {
    if (!/^[a-z_][a-z_0-9]*$/i.test(s)) throw new Error("invalid_outbox_identifier");
    return '"' + s + '"';
  };
  const table = quote(options.table), key = quote(options.key);
  return {
    get(id) { const row = db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id); return row ? options.decode(row) : undefined; },
    set(_id, value) {
      db.prepare(`INSERT INTO ${table}(${options.columns.map(quote).join(",")}) VALUES(${options.columns.map(() => "?").join(",")})`).run(...options.encode(value));
    },
    delete(id) { db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(id); },
    *entries() { for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()) yield [String(row[options.key]), options.decode(row)] as [string, T]; },
  };
}

/** Recovery changes only the delivery phase, never identity, attempts or bytes. */
export function recoverOutbox(db: DatabaseSync, ambiguity: Ambiguity): void {
  db.prepare("UPDATE outbox SET state=? WHERE state='sending'").run(ambiguity === "resend" ? "pending" : "uncertain");
}
