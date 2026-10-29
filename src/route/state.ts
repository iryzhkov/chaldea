import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openDb, tx } from "../store/sqlite.ts";
import { publish } from "../events/publisher.ts";
import type { Publication, PublisherOptions } from "../events/publisher.ts";
import { recommendReviewPair, reviewPairInput, type ReviewPairInput, type ReviewPairResult } from "./pair.ts";
import { recommend } from "./policy.ts";
import type { PolicyData } from "./policy.ts";
import { emptyHistory, inProbation, roleKey } from "./targets.ts";
import type { RoutingHistory } from "./targets.ts";
import { DEFAULT_POLICY } from "./types.ts";
import type { RouteInput, RouteResult } from "./types.ts";

export const MAX_ROUTE_EVENTS = 128;
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
/** Reserve recommendation shares independently of best-effort announcements.
 * Model changes coalesce until first delivery attempt. Attempted payloads are
 * immutable, and their keys survive retries. Account/instance changes are silent.
 */
export class RouteState {
  private readonly db;
  private readonly epoch: string;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDb(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA max_page_count=4096");
    this.db.exec(`CREATE TABLE IF NOT EXISTS route_meta(name TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(role TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS picks(role TEXT PRIMARY KEY, value TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(key TEXT PRIMARY KEY, event TEXT NOT NULL, role TEXT NOT NULL, attempted INTEGER NOT NULL DEFAULT 0)`);
    // Preserve old queued payloads conservatively as already attempted.
    const columns = this.db.prepare("PRAGMA table_info(pending)").all().map(r => String(r.name));
    if (!columns.includes("role")) this.db.exec("ALTER TABLE pending ADD COLUMN role TEXT NOT NULL DEFAULT ''");
    if (!columns.includes("attempted")) this.db.exec("ALTER TABLE pending ADD COLUMN attempted INTEGER NOT NULL DEFAULT 1");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS one_unattempted_role ON pending(role) WHERE attempted=0");
    this.db.prepare("INSERT OR IGNORE INTO route_meta VALUES(?,?)").run("epoch", randomUUID());
    this.epoch = String(this.db.prepare("SELECT value FROM route_meta WHERE name=?").get("epoch")!.value);
  }
  recommend(input: RouteInput, data: PolicyData, host: string, announce: boolean): RouteResult {
    const key = roleKey(input.role, input.authorProvider, input.effortOverride, data.config?.benchmark?.indexVersion);
    const result = tx(this.db, () => {
      const row = this.db.prepare("SELECT value FROM history WHERE role=?").get(key);
      const history: RoutingHistory = row ? JSON.parse(String(row.value)) : emptyHistory();
      const config = { ...DEFAULT_POLICY, ...data.config };
      for (const p of data.catalog) for (const m of p.models) {
        history.seen[m.id] ??= data.now;
        history.allocations[m.id] ??= { calls: 0, trials: 0 };
      }
      const result = recommend(input, { ...data, history });
      for (const [model, allocation] of Object.entries(history.allocations)) {
        if (inProbation(model, input.role, history, config, data.now)) {
          allocation.calls++;
          if (model === result.model || Object.values(result.byProvider).some(p => p.eligible && p.model === model)) allocation.trials++;
        }
      }
      if (!inProbation(result.model, input.role, history, config, data.now)) history.picks[key] = {
        providerInstanceId: result.providerInstanceId, model: result.model, options: result.options,
      };
      this.db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(history));
      return result;
    });
    if (input.effortOverride) return result;
    try {
      tx(this.db, () => {
        const top = result.topPick ?? { providerInstanceId: result.providerInstanceId, model: result.model, options: result.options };
        const prior = this.db.prepare("SELECT value,sequence FROM picks WHERE role=?").get(key);
        if (prior && JSON.parse(String(prior.value)).model === top.model) return;
        const sequence = Number(prior?.sequence ?? 0) + 1;
        if (announce) {
          const unattempted = this.db.prepare("SELECT key,event FROM pending WHERE role=? AND attempted=0").get(key);
          const previous = unattempted ? JSON.parse(String(unattempted.event)).payload.data.previous_model
            : prior ? JSON.parse(String(prior.value)).model : "initial defaults";
          if (unattempted) this.db.prepare("DELETE FROM pending WHERE key=?").run(String(unattempted.key));
          // A transient change that returned to the last announced model needs no event.
          if (top.model !== previous) {
            const event: Publication = {
              key: "route-pick:" + createHash("sha256").update(this.epoch + ":" + host + ":" + key + ":" + sequence).digest("hex"),
              source: "route", host, payload: { v: 1, kind: "route_pick_changed",
                title: "routing changed: " + top.model + " replaces " + previous + " for " + key,
                body: [...result.reasons.slice(-1), ...result.reasons.slice(0, -1)].join("; ").slice(0, 16000),
                data: { role: key, model: top.model, previous_model: previous, transition_id: String(sequence) } },
            };
            const bytes = JSON.stringify(event);
            const size = this.db.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(event AS BLOB))),0) AS bytes FROM pending").get()!;
            if (Number(size.n) >= MAX_ROUTE_EVENTS || Number(size.bytes) + Buffer.byteLength(bytes) > MAX_EVENT_BYTES)
              throw new Error("route_outbox_full");
            this.db.prepare("INSERT INTO pending(key,event,role,attempted) VALUES(?,?,?,0)").run(event.key, bytes, key);
          }
        }
        this.db.prepare("INSERT INTO picks VALUES(?,?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value,sequence=excluded.sequence")
          .run(key, JSON.stringify(top), sequence);
      });
    } catch {
      // Event storage cannot undo a reserved recommendation or stop routing.
      result.reasons.push("Route-change announcement deferred: event storage unavailable or at capacity");
    }
    return result;
  }
  reviewPair(value: ReviewPairInput, data: PolicyData): ReviewPairResult {
    const input = reviewPairInput(value);
    return tx(this.db, () => {
      const histories = new Map<string, RoutingHistory>();
      const historyFor = (request: RouteInput) => {
        const key = roleKey(request.role, request.authorProvider, request.effortOverride, data.config?.benchmark?.indexVersion);
        if (!histories.has(key)) {
          const row = this.db.prepare("SELECT value FROM history WHERE role=?").get(key);
          const history: RoutingHistory = row ? JSON.parse(String(row.value)) : emptyHistory();
          for (const p of data.catalog) for (const m of p.models) {
            history.seen[m.id] ??= data.now;
            history.allocations[m.id] ??= { calls: 0, trials: 0 };
          }
          histories.set(key, history);
        }
        return histories.get(key)!;
      };
      const result = recommendReviewPair(input, data, historyFor);
      const config = { ...DEFAULT_POLICY, ...data.config };
      const slots = new Map<string, { request: RouteInput; models: string[] }>();
      for (const [target, role, main] of [[result.main, input.mainRole ?? "builder", true],
        [result.peer, input.peerRole ?? "builder", false]] as const) {
        if (!target) continue;
        const driver = data.catalog.find(p => p.providerInstanceId === target.providerInstanceId)!.driverKind;
        const request: RouteInput = { role, effortOverride: Object.values(target.options)[0]!,
          ...(main && driver !== input.authorProvider ? { authorProvider: input.authorProvider } : {}) };
        const key = roleKey(role, request.authorProvider, request.effortOverride, data.config?.benchmark?.indexVersion);
        const slot = slots.get(key) ?? { request, models: [] };
        slot.models.push(target.model); slots.set(key, slot);
      }
      for (const [key, slot] of slots) {
        const history = historyFor(slot.request);
        for (const [model, allocation] of Object.entries(history.allocations)) {
          if (inProbation(model, slot.request.role, history, config, data.now)) {
            allocation.calls += slot.models.length;
            allocation.trials += slot.models.filter(m => m === model).length;
          }
        }
        this.db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value")
          .run(key, JSON.stringify(history));
      }
      return result;
    });
  }
  async flush(options: PublisherOptions = {}): Promise<void> {
    for (let n = 0; n < 100; n++) {
      const row = tx(this.db, () => {
        const row = this.db.prepare("SELECT key,event FROM pending ORDER BY rowid LIMIT 1").get();
        if (row) this.db.prepare("UPDATE pending SET attempted=1 WHERE key=?").run(String(row.key));
        return row;
      });
      if (!row) return;
      if (!await publish(JSON.parse(String(row.event)), options)) return;
      this.db.prepare("DELETE FROM pending WHERE key=?").run(String(row.key));
    }
  }
  pending(): number { return Number(this.db.prepare("SELECT count(*) AS n FROM pending").get()!.n); }
  close(): void { this.db.close(); }
}
