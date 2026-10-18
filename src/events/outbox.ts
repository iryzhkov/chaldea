// One host-private durable queue and collector checkpoints. DELETE journal keeps
// database + rollback journal near 32 MiB (with journal headers reserved in
// the host budget); no unbounded WAL or sidecar cache.
import type { DatabaseSync } from "node:sqlite";
import { openDb, tx, migrate } from "../store/sqlite.ts";
import { Outbox as SharedOutbox, sqliteOutbox } from "../store/outbox.ts";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Publication } from "./publisher.ts";
export const STATE_BYTES = 16 * 1024 * 1024;
export interface Cursor { generation: string; dev: string; ino: string; offset: number; prefix: string; prefixLength: number; tail: string; size?: number; modified?: string }
export class Outbox {
  readonly db: DatabaseSync;
  private readonly queue: SharedOutbox<{ event: Publication; file: string; cursor: Cursor }>;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDb(path);
    try {
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA page_size=4096; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=100; PRAGMA max_page_count=4096");
    if (Number(this.db.prepare("PRAGMA page_size").get()!.page_size) !== 4096 ||
      Number(this.db.prepare("PRAGMA max_page_count").get()!.max_page_count) !== 4096) throw new Error("unsupported_page_size");
    migrate(this.db, [() => {
    this.db.exec(`CREATE TABLE IF NOT EXISTS pending(key TEXT PRIMARY KEY, event TEXT NOT NULL, file TEXT NOT NULL, cursor TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cursors(file TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL);\n      INSERT OR IGNORE INTO counters VALUES (\'capacity\',0),(\'oversize\',0),(\'delivered\',0),(\'deferred\',0),(\'rejected\',0),(\'expired_unshipped\',0),(\'foreign_host\',0),(\'scan_errors\',0);`);
    }]);
    this.queue = new SharedOutbox(sqliteOutbox(this.db, {
      table: "pending", key: "key", columns: ["key", "event", "file", "cursor"],
      encode: (p: { event: Publication; file: string; cursor: Cursor }) => [p.event.key, JSON.stringify(p.event), p.file, JSON.stringify(p.cursor)],
      decode: r => ({ event: JSON.parse(String(r.event)), file: String(r.file), cursor: JSON.parse(String(r.cursor)) }),
    }), "resend");
    } catch (error) { this.db.close(); throw error; }
  }
  transaction<T>(fn: () => T): T {
    return tx(this.db, fn);
  }
  count(name: string, n = 1): void {
    this.db.prepare("INSERT INTO counters VALUES(?,?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value").run(name, n);
  }
  counters(): Record<string, number> {
    return Object.fromEntries(this.db.prepare("SELECT * FROM counters").all().map(r => [r.name, Number(r.value)]));
  }
  cursor(file: string): Cursor | null {
    const row = this.db.prepare("SELECT value FROM cursors WHERE file=?").get(file);
    return row ? JSON.parse(String(row.value)) : null;
  }
  checkpoint(file: string, cursor: Cursor): void {
    this.db.prepare("INSERT INTO cursors VALUES(?,?) ON CONFLICT(file) DO UPDATE SET value=excluded.value").run(file, JSON.stringify(cursor));
  }
  admit(event: Publication, file: string, cursor: Cursor): boolean {
    const old = this.db.prepare("SELECT event FROM pending WHERE key=?").get(event.key);
    if (old) {
      if (String(old.event) !== JSON.stringify(event)) throw new Error("local_payload_conflict");
      return true;
    }
    if (Buffer.byteLength(JSON.stringify(event)) > 65536) { this.count("oversize"); return false; }
    try {
      this.queue.enqueue(event.key, { event, file, cursor });
      return true;
    } catch { this.count("capacity"); return false; }
  }
  pendingOffset(file: string): number | null {
    const r = this.db.prepare("SELECT cursor FROM pending WHERE file=?").get(file);
    return r ? Number(JSON.parse(String(r.cursor)).offset) : null;
  }
  next(): { event: Publication; file: string; cursor: Cursor } | null {
    const r = this.db.prepare("SELECT * FROM pending ORDER BY rowid LIMIT 1").get();
    return r ? { event: JSON.parse(String(r.event)), file: String(r.file), cursor: JSON.parse(String(r.cursor)) } : null;
  }
  acknowledge(key: string): void {
    this.transaction(() => {
      const r = this.db.prepare("SELECT file,cursor FROM pending WHERE key=?").get(key);
      if (!r) return;
      this.checkpoint(String(r.file), JSON.parse(String(r.cursor)));
      this.queue.discard(key);
      this.count("delivered");
    });
  }
  forget(file: string): void { this.db.prepare("DELETE FROM cursors WHERE file=?").run(file); }
  /** Optional fixed-size latest/pending status slot in the existing 16MiB DB. */
  statusState(): {latest:Publication|null;pending:Publication|null;until:number;admitted:number;seen:{epoch:string;sequence:number;observedAt:number}|null} {
    this.db.exec("CREATE TABLE IF NOT EXISTS mission_control_status(slot INTEGER PRIMARY KEY CHECK(slot=1), value TEXT NOT NULL)");
    const r=this.db.prepare("SELECT value FROM mission_control_status WHERE slot=1").get();
    return r?JSON.parse(String(r.value)):{latest:null,pending:null,until:0,admitted:-30000,seen:null};
  }
  saveStatus(state:ReturnType<Outbox["statusState"]>):void {
    const bytes=JSON.stringify(state);if(Buffer.byteLength(bytes)>32*1024)throw new Error("status_capacity");
    this.db.prepare("INSERT INTO mission_control_status VALUES(1,?) ON CONFLICT(slot) DO UPDATE SET value=excluded.value").run(bytes);
  }
  close(): void { this.db.close(); }
}
