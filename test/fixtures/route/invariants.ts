import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { PolicyData } from "../../../src/route/policy.ts";
import type { RouteInput, RouteResult, Role } from "../../../src/route/types.ts";
import type { ReviewPairInput, ReviewPairResult } from "../../../src/route/pair.ts";
import { fixture, stats, now, iso } from "./targets.ts";

interface Router {
  recommend(input: RouteInput, data: PolicyData, host: string, announce: boolean): RouteResult;
  reviewPair(input: ReviewPairInput, data: PolicyData): ReviewPairResult;
  close(): void;
}
type Constructor = new (path: string) => Router;
const plain = (o: Record<string, unknown>, picks = false) => Object.fromEntries(Object.entries(o).filter(([k]) =>
  !k.startsWith("antigravity:") && (!picks || !k.endsWith(":driver:antigravity"))));
/** Independent persisted-state oracle, shared with reviewer runs against frozen main. */
export function primarySnapshot(path: string) {
  const db = new DatabaseSync(path);
  try {
    const histories = db.prepare("SELECT role,value FROM history ORDER BY role").all().flatMap(row => {
      const value = JSON.parse(String(row.value));
      const projected = { seen: plain(value.seen), allocations: plain(value.allocations), picks: plain(value.picks, true) };
      return Object.values(projected).some(o => Object.keys(o).length) ? [[row.role, projected]] : [];
    });
    const picks = db.prepare("SELECT role,value,sequence FROM picks ORDER BY role").all()
      .filter(row => !String(row.role).startsWith("antigravity:"));
    const pending = db.prepare("SELECT role,event FROM pending ORDER BY role").all()
      .filter(row => !String(row.role).startsWith("antigravity:"))
      .map(row => ({ role: row.role, data: JSON.parse(String(row.event)).payload.data }));
    return { histories, picks, pending };
  } finally { db.close(); }
}
const opts = (id: string) => [{ id, type: "select", options: ["low", "medium", "high"].map(id => ({ id })) }];
export function invariantFixture(at = now): PolicyData {
  const f = fixture(), models = ["gpt-6.1-sol", "gpt-6.1-terra", "claude-opus-5-5", "claude-haiku-5-5", "gemini-4-neon"];
  return { ...f, now: at, catalog: [
    { providerInstanceId: "codex", driverKind: "codex", canRunChildTask: true,
      models: models.slice(0, 2).map(id => ({ id, options: opts("reasoningEffort") })) },
    { providerInstanceId: "claudeAgent", driverKind: "claudeAgent", canRunChildTask: true,
      models: models.slice(2, 4).map(id => ({ id, options: opts("effort") })) },
    { providerInstanceId: "ag", driverKind: "antigravity", canRunChildTask: true,
      models: [models[1]!, models[4]!].map(id => ({ id, options: opts("thought_level") })) },
  ], scores: { version: 2, metric: "aa-intelligence-cost-per-task", indexVersion: "5", fetchedAt: iso(at), unmapped: [],
    models: models.flatMap((model, i) => ["low", "medium", "high"].map(effort => ({
      model, effort: effort as "low" | "medium" | "high", aaSlug: model + "-" + effort,
      intelligence: 60, coding: 60, inputPrice: i === 1 ? .1 : 2, outputPrice: i === 1 ? .1 : 2,
      benchmarkCostUSDPerTask: i === 1 ? .1 : 2,
    }))) },
    analytics: { ...f.analytics!, fetchedAt: iso(at), sourceFetchedAt: iso(at), endExclusive: iso(at),
      models: Object.fromEntries(models.map(m => [m, stats()])) },
    config: { benchmark: { indexVersion: "5" }, driverModels: { antigravity: ["gpt-6.1-terra", "gemini-4-neon"] } },
  };
}
const capture = <T>(f: () => T) => { try { return f(); } catch (e) { return { error: (e as { code?: string }).code }; } };
/** Vary presence, priority, quota, refusal, role, effort and aging; compare after every call. */
export function exercisePrimaryEquivalence(Head: Constructor, Main: Constructor, scratch: string): number {
  let calls = 0, sequence = 0;
  for (const role of ["general", "builder", "bulk-read", "executor"] as Role[])
  for (const mode of ["benchmark", "noScores", "incomplete", "pin"] as const) {
    const hp = join(scratch, "p-head-" + sequence + ".sqlite"), mp = join(scratch, "p-main-" + sequence++ + ".sqlite");
    const head = new Head(hp), main = new Main(mp);
    try {
      for (let step = 0; step < 8; step++) {
        const at = now + (step < 2 ? step * 1000 : 8 * 86400000 + step * 1000);
        const data = invariantFixture(at);
        data.config = { ...data.config, providerPreference: step % 3 === 1 ? ["antigravity"] : [] };
        if (step % 3 === 2) data.catalog = data.catalog.filter(p => p.driverKind !== "antigravity");
        if (step === 3) data.quota = { codex: { observedAt: iso(at), windows: [], activeStop: true } };
        if (step === 4) data.quota = Object.fromEntries(["codex", "claudeAgent"].map(p => [p,
          { observedAt: iso(at), windows: [], activeStop: true }]));
        if (step === 7) data.analytics = null;
        if (mode === "noScores") { data.scores = null; data.config = { ...data.config, benchmark: null }; }
        if (mode === "incomplete") data.scores = { ...data.scores!, models: data.scores!.models.filter(m => m.model !== "claude-opus-5-5") };
        if (mode === "pin") data.config = { ...data.config, pins: { [role]: { model: "gpt-6.1-terra" } } };
        const native = { ...data, catalog: data.catalog.filter(p => p.driverKind !== "antigravity") };
        const input: RouteInput = { role, ...(step === 6 ? { effortOverride: "medium" as const } : {}) };
        const expected = capture(() => main.recommend(input, native, "fixture", step % 2 === 0));
        const actual = capture(() => head.recommend(input, data, "fixture", step % 2 === 0));
        if (!data.catalog.some(p => p.driverKind === "antigravity")) {
          if ("error" in expected) assert.deepEqual(actual, expected);
          else { assert.ok(!("error" in actual)); assert.equal(actual.model, expected.model); assert.equal(actual.providerInstanceId, expected.providerInstanceId); }
        }
        assert.deepEqual(primarySnapshot(hp), primarySnapshot(mp), role + "/" + mode + "/route/" + step);
        calls++;
        const pair: ReviewPairInput = { authorProvider: step % 2 ? "codex" : "claudeAgent",
          mainRole: role, peerRole: step % 2 ? "general" : role, allowQuotaException: true };
        capture(() => main.reviewPair(pair, native));
        capture(() => head.reviewPair(pair, data));
        assert.deepEqual(primarySnapshot(hp), primarySnapshot(mp), role + "/" + mode + "/pair/" + step);
        calls++;
      }
    } finally { head.close(); main.close(); }
  }
  return calls;
}
