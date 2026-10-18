import assert from "node:assert/strict";
import { test } from "node:test";
import { recommend } from "../../src/route/policy.ts";
import { catalog, now } from "../fixtures/route/catalog.ts";
import type { CatalogProvider, Role } from "../../src/route/types.ts";

const providers = catalog.filter(p => ["codex", "claudeAgent"].includes(p.providerInstanceId));
const base = { catalog: providers, now, quota: {}, analytics: null };
const models = {
  builder: { codex: "gpt-6.1-sol", claudeAgent: "claude-opus-5-5" },
  "critical-review": { codex: "gpt-6-astra", claudeAgent: "claude-fable-5-1" },
};
const driver = (entries: readonly CatalogProvider[], id: string) =>
  entries.find(p => p.providerInstanceId === id)!.driverKind;

test("review author constraints precede model and instance pins for main and critical reviews", () => {
  for (const role of ["builder", "critical-review"] as const) {
    for (const authorProvider of ["codex", "claudeAgent"] as const) {
      for (const instancePin of [false, true]) {
        const pin = { model: models[role][authorProvider],
          ...(instancePin ? { providerInstanceId: authorProvider } : {}) };
        assert.throws(() => recommend({ role, authorProvider }, {
          ...base, config: { pins: { [role]: pin } },
        }), /review requires the other provider/);
      }
    }
  }
});

test("review targets, alternatives and provider summaries exclude every instance of the author driver", () => {
  const entries = providers.flatMap(p => [p, { ...p, providerInstanceId: p.providerInstanceId + "-second" }]);
  for (const role of ["builder", "critical-review"] as const) {
    for (const authorProvider of ["codex", "claudeAgent"] as const) {
      const peer = authorProvider === "codex" ? "claudeAgent" : "codex";
      for (const pin of [undefined, { providerInstanceId: peer + "-second", model: models[role][peer] }]) {
        const result = recommend({ role, authorProvider }, { ...base, catalog: entries,
          ...(pin ? { config: { pins: { [role]: pin } } } : {}) });
        for (const target of [result, result.topPick!, ...result.alternatives]) {
          assert.notEqual(driver(entries, target.providerInstanceId), authorProvider);
        }
        assert.equal(result.byProvider[authorProvider]!.eligible, false);
        assert.equal(result.byProvider[peer]!.eligible, true);
        assert.match(result.reasons.join("; "), /Review must use the other provider/);
        if (pin) assert.equal(result.providerInstanceId, pin.providerInstanceId);
      }
      assert.throws(() => recommend({ role, authorProvider }, { ...base, catalog: entries,
        config: { pins: { [role]: { providerInstanceId: authorProvider + "-second", model: models[role][authorProvider] } } },
      }), /No eligible/);
    }
  }
});

test("unknown quota or an unavailable other provider never waives review separation", () => {
  for (const role of ["builder", "critical-review"] as const) {
    for (const authorProvider of ["codex", "claudeAgent"] as const) {
      const peer = authorProvider === "codex" ? "claudeAgent" : "codex";
      assert.throws(() => recommend({ role, authorProvider }, {
        ...base, catalog: providers.filter(p => p.driverKind === authorProvider),
      }), /No eligible/);
      assert.throws(() => recommend({ role, authorProvider }, {
        ...base, quota: { [peer]: { observedAt: null, windows: [], activeStop: true } },
      }), /No eligible/);
    }
  }
});

test("authorProvider is an explicit constraint, not an implicit filter on builder calls", () => {
  for (const role of ["builder", "critical-review", "bulk-read", "general"] as Role[]) {
    const result = recommend({ role }, { ...base,
      config: { pins: { [role]: { providerInstanceId: "codex", model: "gpt-6.1-sol" } } } });
    assert.equal(result.providerInstanceId, "codex");
    assert.throws(() => recommend({ role, authorProvider: "codex" }, {
      ...base, config: { pins: { [role]: { providerInstanceId: "codex", model: "gpt-6.1-sol" } } },
    }), /No eligible/);
  }
});
