import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { openDb, tx } from "../store/sqlite.ts";
import { publish } from "../events/publisher.ts";
import type { Publication, PublisherOptions } from "../events/publisher.ts";
import { recommendReviewPair, reviewPairInput, pairRequest, type ReviewPairInput, type ReviewPairResult } from "./pair.ts";
import { RouteError } from "./errors.ts";
import { recommend } from "./policy.ts";
import type { PolicyData } from "./policy.ts";
import { emptyHistory, inProbation, roleKey, historyModelKey, driverPickKey } from "./targets.ts";
import type { RoutingHistory } from "./targets.ts";
import { DEFAULT_POLICY } from "./types.ts";
import type { Role, RouteInput, RouteResult, Target } from "./types.ts";


const antigravityKey = (key: string) => key.startsWith("antigravity:");
function initializeHistory(history: RoutingHistory, data: PolicyData): void {
  for (const p of data.catalog) for (const m of p.models) {
    const key = historyModelKey(p.driverKind, m.id);
    history.seen[key] ??= data.now;
    history.allocations[key] ??= { calls: 0, trials: 0 };
  }
}
/** Failed/unused probes can remember only Antigravity's observations, never primary state. */
function antigravitySeen(original: RoutingHistory, observed: RoutingHistory): boolean {
  let changed = false;
  for (const [key, at] of Object.entries(observed.seen)) if (antigravityKey(key) && original.seen[key] === undefined) {
    original.seen[key] = at;
    original.allocations[key] ??= { calls: 0, trials: 0 };
    changed = true;
  }
  return changed;
}
function reserveAntigravity(history: RoutingHistory, role: Role, data: PolicyData, targets: Target[], opportunities: number): void {
  const config = { ...DEFAULT_POLICY, ...data.config };
  const picks = targets.filter(t => data.catalog.find(p => p.providerInstanceId === t.providerInstanceId)?.driverKind === "antigravity");
  for (const [key, allocation] of Object.entries(history.allocations)) if (antigravityKey(key)) {
    const model = key.slice("antigravity:".length);
    if (inProbation(model, role, history, config, data.now, "antigravity")) {
      allocation.calls += opportunities;
      allocation.trials += picks.filter(t => t.model === model).length;
    }
  }
}

/** Primary state is derived only from an independent Antigravity-free evaluation. */
const privatePick = (key: string) => key.startsWith("antigravity:") || key.endsWith(":driver:antigravity");
function primaryHistory(history: RoutingHistory): RoutingHistory {
  return { seen: Object.fromEntries(Object.entries(history.seen).filter(([k]) => !antigravityKey(k))),
    allocations: Object.fromEntries(Object.entries(history.allocations).filter(([k]) => !antigravityKey(k))),
    picks: Object.fromEntries(Object.entries(history.picks).filter(([k]) => !privatePick(k))) };
}
function mergePrimary(history: RoutingHistory, primary: RoutingHistory): void {
  for (const field of ["seen", "allocations", "picks"] as const) {
    const privateKey = field === "picks" ? privatePick : antigravityKey;
    for (const key of Object.keys(history[field])) if (!privateKey(key)) delete history[field][key];
    Object.assign(history[field], primary[field]);
  }
}
const primaryData = (data: PolicyData): PolicyData => ({ ...data,
  catalog: data.catalog.filter(p => p.driverKind !== "antigravity") });

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
    const attempt = tx(this.db, () => {
      const row = this.db.prepare("SELECT value FROM history WHERE role=?").get(key);
      const original: RoutingHistory = row ? JSON.parse(String(row.value)) : emptyHistory();
      const config = { ...DEFAULT_POLICY, ...data.config };
      const primary = structuredClone(primaryHistory(original)), native = primaryData(data);
      let primaryResult: RouteResult | undefined;
      try {
        initializeHistory(primary, native);
        primaryResult = recommend(input, { ...native, history: primary });
        // Main's reservation and incumbent rules, applied to its independent result.
        for (const [model, allocation] of Object.entries(primary.allocations)) {
          if (inProbation(model, input.role, primary, config, data.now)) {
            allocation.calls++;
            if (model === primaryResult.model || Object.values(primaryResult.byProvider).some(p => p.eligible && p.model === model)) allocation.trials++;
          }
        }
        if (!inProbation(primaryResult.model, input.role, primary, config, data.now))
          primary.picks[key] = { providerInstanceId: primaryResult.providerInstanceId,
            model: primaryResult.model, options: primaryResult.options };
      } catch (error) { if (!(error instanceof RouteError)) throw error; }
      const history = structuredClone(original);
      initializeHistory(history, data);
      let result: RouteResult | undefined, failure: RouteError | undefined;
      try { result = recommend(input, { ...data, history }); }
      catch (error) { if (!(error instanceof RouteError)) throw error; failure = error; }
      const committed = structuredClone(original);
      if (primaryResult) mergePrimary(committed, primary);
      let antigravityChanged = false;
      if (result) {
        reserveAntigravity(history, input.role, data, Object.values(result.byProvider).filter(p => p.eligible), 1);
        const driver = data.catalog.find(p => p.providerInstanceId === result!.providerInstanceId)!.driverKind;
        if (driver === "antigravity" && !inProbation(result.model, input.role, history, config, data.now, driver))
          history.picks[driverPickKey(key, driver)] = { providerInstanceId: result.providerInstanceId,
            model: result.model, options: result.options };
        mergePrimary(history, primaryHistory(committed));
        Object.assign(committed, history);
        antigravityChanged = data.catalog.some(p => p.driverKind === "antigravity");
      } else if (failure?.code === "no_candidate") antigravityChanged = antigravitySeen(committed, history);
      if (primaryResult || antigravityChanged)
        this.db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value")
          .run(key, JSON.stringify(committed));
      return { result, failure, primaryResult };
    });
    // The shared pick ledger follows the primary-only call too; Antigravity has its own key.
    if (!input.effortOverride && attempt.primaryResult) {
      const before = attempt.primaryResult.reasons.length;
      this.recordPick(attempt.primaryResult, key, host, announce);
      attempt.result?.reasons.push(...attempt.primaryResult.reasons.slice(before));
    }
    if (attempt.failure) throw attempt.failure;
    const result = attempt.result!;
    const driver = data.catalog.find(p => p.providerInstanceId === result.providerInstanceId)!.driverKind;
    if (!input.effortOverride && driver === "antigravity") this.recordPick(result, "antigravity:" + key, host, announce);
    return result;
  }
  private recordPick(result: RouteResult, key: string, host: string, announce: boolean): void {
    const antigravity = key.startsWith("antigravity:");
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
              key: (antigravity ? "antigravity:" : "") + "route-pick:" + createHash("sha256").update(this.epoch + ":" + host + ":" + key + ":" + sequence).digest("hex"),
              source: "route", host, payload: { v: 1, kind: "route_pick_changed",
                title: "routing changed: " + top.model + " replaces " + previous + " for " + key,
                body: [...result.reasons.slice(-1), ...result.reasons.slice(0, -1)].join("; ").slice(0, 16000),
                data: { role: key, model: top.model, previous_model: previous, transition_id: String(sequence) } },
            };
            const bytes = JSON.stringify(event);
            const size = this.db.prepare("SELECT count(*) AS n,coalesce(sum(length(CAST(event AS BLOB))),0) AS bytes FROM pending WHERE " +
              (antigravity ? "role LIKE 'antigravity:%'" : "role NOT LIKE 'antigravity:%'")).get()!;
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
  }
  reviewPair(value: ReviewPairInput, data: PolicyData): ReviewPairResult {
    const input = reviewPairInput(value);
    return tx(this.db, () => {
      const config = { ...DEFAULT_POLICY, ...data.config };
      const originals = new Map<string, RoutingHistory>();
      const read = (key: string) => {
        if (!originals.has(key)) {
          const row = this.db.prepare("SELECT value FROM history WHERE role=?").get(key);
          originals.set(key, row ? JSON.parse(String(row.value)) : emptyHistory());
        }
        return originals.get(key)!;
      };
      const evaluate = (snapshot: PolicyData, native: boolean) => {
        const histories = new Map<string, RoutingHistory>();
        const historyFor = (request: RouteInput) => {
          const key = roleKey(request.role, request.authorProvider, request.effortOverride, data.config?.benchmark?.indexVersion);
          if (!histories.has(key)) {
            const history = structuredClone(native ? primaryHistory(read(key)) : read(key));
            initializeHistory(history, snapshot); histories.set(key, history);
          }
          return histories.get(key)!;
        };
        const result = recommendReviewPair(input, snapshot, historyFor);
        const slots = new Map<string, { request: RouteInput; targets: Target[] }>();
        for (const [target, role, main] of [[result.main, input.mainRole ?? "builder", true],
          [result.peer, input.peerRole ?? "builder", false]] as const) {
          if (!target) continue;
          const driver = snapshot.catalog.find(p => p.providerInstanceId === target.providerInstanceId)!.driverKind;
          const request = pairRequest(role, driver, main ? input.mainEffort : input.peerEffort,
            input.authorProvider, main, !!config.benchmark && !config.pins[role]);
          const key = roleKey(role, request.authorProvider, request.effortOverride, data.config?.benchmark?.indexVersion);
          const slot = slots.get(key) ?? { request, targets: [] };
          slot.targets.push(target); slots.set(key, slot);
        }
        return { result, slots, histories, historyFor };
      };
      const primary = evaluate(primaryData(data), true);
      const final = evaluate(data, false);
      const writes = new Map<string, RoutingHistory>();
      for (const [key, slot] of primary.slots) {
        const history = primary.historyFor(slot.request);
        // Main persists only returned slots, with one opportunity per slot.
        for (const [model, allocation] of Object.entries(history.allocations)) {
          if (inProbation(model, slot.request.role, history, config, data.now)) {
            allocation.calls += slot.targets.length;
            allocation.trials += slot.targets.filter(t => t.model === model).length;
          }
        }
        const combined = structuredClone(read(key));
        mergePrimary(combined, history); writes.set(key, combined);
      }
      for (const [key, observed] of final.histories) {
        const combined = writes.get(key) ?? structuredClone(read(key));
        const slot = final.slots.get(key);
        if (slot) {
          reserveAntigravity(observed, slot.request.role, data, slot.targets, slot.targets.length);
          mergePrimary(observed, primaryHistory(combined));
          writes.set(key, observed);
        } else if (antigravitySeen(combined, observed)) writes.set(key, combined);
      }
      for (const [key, history] of writes)
        this.db.prepare("INSERT INTO history VALUES(?,?) ON CONFLICT(role) DO UPDATE SET value=excluded.value")
          .run(key, JSON.stringify(history));
      return final.result;
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
