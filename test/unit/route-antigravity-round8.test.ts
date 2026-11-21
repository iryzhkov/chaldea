import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RouteState } from "../../src/route/state.ts";
import { recommend } from "../../src/route/policy.ts";
import { modelWindowPolicy, windowPolicy, modelScopedWindow, type IncludedWindow } from "../../src/quota/window-policy.ts";
import { modelWindowPolicy as mainModelPolicy, windowPolicy as mainWindowPolicy,
  modelScopedWindow as mainScopedWindow } from "../fixtures/route/native-window-policy.ts";
import { fixture, now, iso } from "../fixtures/route/targets.ts";
import { routeScratch } from "../fixtures/route/scratch.ts";

const window = (id: string | undefined, kind: string, remainingPercent: number, windowDurationMins: number | null,
  resetsAt: string | null): IncludedWindow => ({
  ...(id === undefined ? {} : { id }), kind, remainingPercent, windowDurationMins, resetsAt,
});

test("R8: exhausted Codex 3p-weekly refuses without history, pick or pending announcement writes", () => {
  const d = routeScratch(), path = join(d.path, "state.sqlite"), routing = new RouteState(path);
  try {
    const data = { ...fixture(), catalog: fixture().catalog.filter(p => p.providerInstanceId === "codex"),
      quota: { codex: { observedAt: iso(now), activeStop: false,
        windows: [window("3p-weekly", "weekly", 0, 10080, iso(now + 86400000))] } } };
    assert.throws(() => recommend({ role: "general" }, data), { code: "no_candidate" });
    assert.throws(() => routing.recommend({ role: "general" }, data, "fixture", true), { code: "no_candidate" });
    const db = new DatabaseSync(path);
    try {
      for (const table of ["history", "picks", "pending"])
        assert.equal(Number(db.prepare("SELECT count(*) AS n FROM " + table).get()!.n), 0, table);
    } finally { db.close(); }
  } finally { routing.close(); d.remove(); }
});

test("R8: primary policies equal frozen main for arbitrary window IDs, models and quota shapes", () => {
  const prefixes = ["gemini-", "3p-", "seven_day_", "other-", "Gemini-", "3P-", "", "custom:"];
  const ids: Array<string | undefined> = [undefined, "", "weekly", "five_hour", "seven_day_fable",
    "seven_day_unknown", "gemini-weekly", "gemini-argon-wtu-weekly", "3p-weekly", "gemini-next", "3p-next",
    ...Array.from({ length: 64 }, (_, i) => prefixes[i % prefixes.length]! + "generated-" + i.toString(36))];
  const profiles = [
    { kind: "weekly", left: 0, duration: 10080, reset: iso(now + 3600000) },
    { kind: "session", left: 0, duration: 300, reset: iso(now + 3600000) },
    { kind: "weekly", left: 9, duration: 10080, reset: iso(now + 3600000) },
    { kind: "monthly", left: 40, duration: 43200, reset: null },
    { kind: "other", left: 0, duration: null, reset: iso(now + 3600000) },
    { kind: "weekly", left: 80, duration: 10080, reset: iso(now - 1) },
  ];
  let cases = 0;
  for (const driver of [undefined, "codex", "claudeAgent"])
  for (const id of ids) for (const model of ["", "gpt-6.1-sol", "claude-opus-5-5", "claude-fable-5-1", "gemini-4-neon"])
  for (const p of profiles) {
    const w = window(id, p.kind, p.left, p.duration, p.reset);
    const healthy = window("weekly", "weekly", 80, 10080, iso(now + 86400000));
    for (const input of [[w], [healthy, w]]) {
      assert.equal(modelScopedWindow(w), mainScopedWindow(w));
      assert.deepEqual(windowPolicy(input, now, .1, .1, driver), mainWindowPolicy(input, now, .1, .1));
      assert.deepEqual(modelWindowPolicy(input, model, now, .1, .1, driver), mainModelPolicy(input, model, now, .1, .1));
      cases++;
    }
  }
  assert.equal(cases, 13500);
});
