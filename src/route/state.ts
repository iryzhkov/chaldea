import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { openDb, tx } from "../store/sqlite.ts";
import { publish } from "../events/publisher.ts";
import type { Publication, PublisherOptions } from "../events/publisher.ts";
import { recommend } from "./policy.ts";
import type { PolicyData } from "./policy.ts";
import { emptyHistory, inProbation, roleKey } from "./targets.ts";
import type { RoutingHistory } from "./targets.ts";
import { DEFAULT_POLICY } from "./types.ts";
import type { RouteInput, RouteResult } from "./types.ts";

/** One transaction reserves recommendations and records a transition with its outbox.
 * Publish outside the transaction; retries carry identical payload and key.
 * Only the configured announcement host writes the fleet's route-change stream.
 */
export class RouteState {
  private readonly db;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = openDb(path);
    chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA max_page_count=4096");
    this.db.exec(`CREATE TABLE IF NOT EXISTS history(role TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS picks(role TEXT PRIMARY KEY, value TEXT NOT NULL, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(key TEXT PRIMARY KEY, event TEXT NOT NULL)`);
  }
  recommend(input: RouteInput, data: PolicyData, host: string, announce: boolean): RouteResult {
    return tx(this.db, () => {
      const key = roleKey(input.role, input.authorProvider) + (input.effortOverride ? ":" + input.effortOverride : "");
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
          if (model === result.model) allocation.trials++;
        }
      }
      if (!inProbation(result.model, input.role, history, config, data.now)) history.picks[key] = {
        providerInstanceId: result.providerInstanceId, model: result.model, options: result.options,
      };
      this.db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(history));
      if (input.effortOverride) return result;
      const top = result.topPick ?? { providerInstanceId: result.providerInstanceId, model: result.model, options: result.options };
      const value = JSON.stringify(top);
      const prior = this.db.prepare("SELECT value,sequence FROM picks WHERE role=?").get(key);
      if (!prior || prior.value !== value) {
        const sequence = Number(prior?.sequence ?? 0) + 1;
        if (announce) {
          const previous = prior ? JSON.parse(String(prior.value)).model : "initial defaults";
          const event: Publication = {
            key: "route-pick:" + createHash("sha256").update(host + ":" + key + ":" + sequence).digest("hex"),
            source: "route", host, payload: { v: 1, kind: "route_pick_changed",
              title: "routing changed: " + top.model + " replaces " + previous + " for " + key,
              body: result.reasons.join("; ").slice(0, 16000),
              data: { role: key, model: top.model, previous_model: previous, transition_id: String(sequence) } },
          };
          this.db.prepare("INSERT INTO pending VALUES(?,?)").run(event.key, JSON.stringify(event));
        }
        this.db.prepare("INSERT INTO picks VALUES(?,?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value,sequence=excluded.sequence").run(key, value, sequence);
      }
      return result;
    });
  }
  async flush(options: PublisherOptions = {}): Promise<void> {
    for (const row of this.db.prepare("SELECT key,event FROM pending ORDER BY rowid LIMIT 100").all()) {
      if (!await publish(JSON.parse(String(row.event)), options)) return;
      this.db.prepare("DELETE FROM pending WHERE key=?").run(String(row.key));
    }
  }
  pending(): number { return Number(this.db.prepare("SELECT count(*) AS n FROM pending").get()!.n); }
  close(): void { this.db.close(); }
}
