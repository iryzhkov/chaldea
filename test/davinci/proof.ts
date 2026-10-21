// M3 spike only. No CLI, service entrypoint, enrollment or production defaults.
// Frozen single-worker assignment, reusing protected session admission for every launch.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync } from "node:fs";
import { openDb, tx, meta } from "../../src/store/sqlite.ts";
import { ownDatabase } from "../../src/wake/owner.ts";
import type { SessionStatus } from "../../src/session/lifecycle.ts";
import type { WaitEngine } from "../../src/waits/engine.ts";

export const digest = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
export const SOURCE = "1c806a18fbff6717981df40f108ef1c73927acff";
export const BODY = '{"job":"source-status"}';
export interface Assignment {
  version: 1; id: string; worker: string; environment: string; preset: string;
  requestId: string; source: string; inputHash: string;
}
export interface Result {
  assignment: string; hash: string; session: string; thread: string; run: string | null;
  state: SessionStatus["state"]; launch: SessionStatus["launch"]; outcome: unknown; text: string | null;
}
export function signature(secret: Uint8Array, delivery: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(delivery + "\n" + timestamp + "\n" + body).digest("hex");
}
export function authenticate(secret: Uint8Array, delivery: string, timestamp: string, body: string, signed: string, now: number): void {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(delivery) || !/^[0-9]{13}$/.test(timestamp) ||
    Math.abs(now - Number(timestamp)) > 300_000 || Buffer.byteLength(body) > 4096 || !/^[a-f0-9]{64}$/.test(signed))
    throw new Error("webhook_refused");
  const expected = signature(secret, delivery, timestamp, body);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signed, "hex"))) throw new Error("webhook_refused");
}
/** One local writer and finite physical/row bounds, no restored-state takeover. */
class Journal {
  readonly db!: ReturnType<typeof openDb>;
  private readonly release: () => void;
  constructor(path: string, binding: string) {
    this.release = ownDatabase(path);
    try {
      this.db = openDb(path, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA max_page_count=1024; PRAGMA journal_size_limit=0");
      chmodSync(path, 0o600);
      this.db.exec("CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
      const m = meta(this.db, "meta", "key");
      const old = m.get("binding");
      if (old !== undefined && old !== binding) throw new Error("journal_binding_changed");
      m.put("binding", binding);
      this.db.exec("CREATE TABLE IF NOT EXISTS work(id TEXT PRIMARY KEY, hash TEXT NOT NULL, assignment TEXT NOT NULL, session TEXT, result TEXT)");
    } catch (error) { try { this.db!.close(); } catch {} this.release(); throw error; }
  }
  close(): void { try { this.db.close(); } finally { this.release(); } }
  row(id: string): { id: string; hash: string; assignment: string; session: string | null; result: string | null } | undefined {
    return this.db.prepare("SELECT * FROM work WHERE id=?").get(id) as ReturnType<Journal["row"]>;
  }
  insert(id: string, hash: string, assignment: string): void {
    if (Number(this.db.prepare("SELECT count(*) AS n FROM work").get()!.n) >= 16) throw new Error("proof_capacity");
    this.db.prepare("INSERT INTO work(id,hash,assignment) VALUES(?,?,?)").run(id, hash, assignment);
  }
}
export class Coordinator extends Journal {
  readonly binding: { worker: string; environment: string; preset: string };
  constructor(path: string, binding: Coordinator["binding"]) { super(path, JSON.stringify(binding)); this.binding = binding; }
  accept(delivery: string, body: string, now: number): Assignment {
    return tx(this.db, () => {
      const old = this.row(delivery), hash = digest(body);
      if (old) {
        if (old.hash !== hash) throw new Error("delivery_conflict");
        return JSON.parse(old.assignment) as Assignment;
      }
      if (body !== BODY) throw new Error("fixed_job_only");
      const assignment: Assignment = { version: 1, id: digest(delivery), ...this.binding,
        requestId: now + ":davinci-" + digest(delivery), source: SOURCE, inputHash: hash };
      this.insert(delivery, hash, JSON.stringify(assignment));
      return assignment;
    });
  }
  commitResult(delivery: string, result: Result): void {
    tx(this.db, () => {
      const row = this.row(delivery);
      if (!row) throw new Error("unknown_delivery");
      const a: Assignment = JSON.parse(row.assignment);
      if (result.assignment !== a.id || result.hash !== digest(row.assignment) || result.state === "parked")
        throw new Error("result_binding");
      const value = JSON.stringify(result);
      if (Buffer.byteLength(value) > 8192) throw new Error("result_oversize");
      if (row.result !== null && row.result !== value) throw new Error("result_conflict");
      this.db.prepare("UPDATE work SET result=? WHERE id=?").run(value, delivery);
    });
  }
}
export class Worker extends Journal {
  readonly binding: { worker: string; environment: string; preset: string; caller: string };
  constructor(path: string, binding: Worker["binding"]) { super(path, JSON.stringify(binding)); this.binding = binding; }
  /** The authenticated exact broker subject is checked by the fixture transport. */
  async accept(bytes: string, engine: Pick<WaitEngine, "startSession">): Promise<SessionStatus> {
    if (Buffer.byteLength(bytes) > 8192) throw new Error("assignment_oversize");
    const a = JSON.parse(bytes) as Assignment;
    if (JSON.stringify(Object.keys(a).sort()) !== JSON.stringify(["version","id","worker","environment","preset","requestId","source","inputHash"].sort()) ||
      a.version !== 1 || !/^[a-f0-9]{64}$/.test(a.id) || a.worker !== this.binding.worker ||
      a.environment !== this.binding.environment || a.preset !== this.binding.preset || a.source !== SOURCE ||
      a.inputHash !== digest(BODY) || !new RegExp("^[0-9]{13}:davinci-" + a.id + "$").test(a.requestId)) throw new Error("assignment_binding");
    tx(this.db, () => {
      const old = this.row(a.id), hash = digest(bytes);
      if (old && old.hash !== hash) throw new Error("assignment_conflict");
      if (!old) this.insert(a.id, hash, bytes); // before any admission IPC effect
    });
    // A lost answer reuses this requestId. The existing admission journal owns
    // native IDs and refuses redispatch after ambiguous T3 acceptance.
    const status = await engine.startSession({ threadId: this.binding.caller, requestId: a.requestId, preset: a.preset });
    const old = this.row(a.id)!;
    if (old.session !== null && old.session !== status.sessionId) throw new Error("session_identity_changed");
    this.db.prepare("UPDATE work SET session=? WHERE id=?").run(status.sessionId, a.id);
    return status;
  }
}
export function result(a: Assignment, status: SessionStatus): Result {
  return { assignment: a.id, hash: digest(JSON.stringify(a)), session: status.sessionId, thread: status.threadId,
    run: status.runId, state: status.state, launch: status.launch, outcome: status.outcome, text: status.result };
}
