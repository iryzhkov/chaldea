import assert from "node:assert/strict";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  DAY_MS,
  KEY_TTL_MS,
  MAX_PARKED_THREADS,
  MAX_POSTED_KEYS,
  emptyState,
  loadState,
  prune,
  recordKey,
  saveState,
} from "../../src/quota/state.ts";
import { scratchDir } from "../helpers/scratch.ts";
import { T0 } from "../helpers/threads.ts";

test("keys and parked threads expire after 42 days", () => {
  const state = emptyState();
  state.posted.set(recordKey("quota_parked", "old", "r"), T0 - KEY_TTL_MS - 1);
  state.posted.set(recordKey("quota_parked", "new", "r"), T0 - 41 * DAY_MS);
  state.parked.set("old", { runId: "r", resetAt: null, provider: "codex", stopAt: T0 - KEY_TTL_MS - 1, seenAt: T0 - KEY_TTL_MS - 1 });
  state.parked.set("new", { runId: "r", resetAt: null, provider: "codex", stopAt: T0, seenAt: T0 });
  prune(state, T0);
  assert.deepEqual([...state.posted.keys()], [recordKey("quota_parked", "new", "r")]);
  assert.deepEqual([...state.parked.keys()], ["new"]);
  assert.equal(state.evictedThrough, T0 - KEY_TTL_MS - 1);
});

test("caps evict the oldest entries first", () => {
  const state = emptyState();
  for (let i = 0; i < MAX_POSTED_KEYS + 5; i += 1) state.posted.set(`k${i}`, T0 + i);
  for (let i = 0; i < MAX_PARKED_THREADS + 3; i += 1) {
    state.parked.set(`t${i}`, { runId: "r", resetAt: null, provider: "codex", stopAt: T0 + i, seenAt: T0 + i });
  }
  prune(state, T0 + 1_000_000);
  assert.equal(state.posted.size, MAX_POSTED_KEYS);
  assert.equal(state.posted.has("k0"), false);
  // The newest evicted key sets the watermark.
  assert.equal(state.evictedThrough, T0 + 4);
  assert.equal(state.posted.has(`k${MAX_POSTED_KEYS + 4}`), true);
  assert.equal(state.parked.size, MAX_PARKED_THREADS);
  assert.equal(state.parked.has("t0"), false);
});

test("the state file round-trips, is private and stays small at the caps", () => {
  const dir = scratchDir("state");
  try {
    const path = join(dir.path, "nested", "quota-observer.json");
    const state = emptyState();
    state.cursor = 42;
    for (let i = 0; i < MAX_POSTED_KEYS; i += 1) {
      state.posted.set(recordKey("quota_resumed", `thread:project:${crypto.randomUUID()}`, `run:${i}`), T0);
    }
    state.parked.set("t", { runId: "r", resetAt: "2026-10-16T12:00:10.000Z", provider: "claudeAgent", stopAt: T0 + 10_000, seenAt: T0 });
    state.evictedThrough = T0 - 5;
    saveState(path, state, T0);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(statSync(path).size < 2 * 1024 * 1024, `state file is ${statSync(path).size} bytes`);
    const loaded = loadState(path, T0);
    assert.equal(loaded.cursor, 42);
    assert.equal(loaded.evictedThrough, T0 - 5);
    assert.equal(loaded.posted.size, MAX_POSTED_KEYS);
    assert.deepEqual(loaded.parked.get("t"), state.parked.get("t"));
    // Loading prunes too, so a long outage cannot carry expired keys forward.
    assert.equal(loadState(path, T0 + KEY_TTL_MS + 1).posted.size, 0);
  } finally {
    dir.remove();
  }
});

test("an unknown state file version is refused rather than guessed", () => {
  const dir = scratchDir("state");
  try {
    const path = join(dir.path, "state.json");
    writeFileSync(path, JSON.stringify({ version: 99 }));
    assert.throws(() => loadState(path, T0), /Unsupported state file version/);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 99);
  } finally {
    dir.remove();
  }
});

test("state v2 migrates to v4, preserving claims and releasing unsafe old switch intents", () => {
  const dir = scratchDir("state-migration");
  try {
    const path = join(dir.path, "state.json");
    const resetAt = new Date(T0 + 60_000).toISOString();
    writeFileSync(path, JSON.stringify({ version: 2, cursor: 31, posted: { prior: T0 }, parked: {},
      switches: { old: { threadId: "t", runId: "r", resetAt, from: { instanceId: "claudeAgent", model: "c" },
        target: { instanceId: "codex", model: "g" }, phase: "dispatching", stopAt: T0, createdAt: T0,
        expiresAt: T0 + 35 * DAY_MS, restoreAutoResume: false, subagent: false } } }));
    const state = loadState(path, T0);
    assert.equal(state.cursor, 31); assert.equal(state.posted.get("prior"), T0);
    assert.equal(state.switches.get("old")!.phase, "releasing");
    assert.equal(state.switches.get("old")!.restoreAutoResume, null);
    assert.ok(state.switches.get("old")!.expiresAt <= T0 + 180_000);
    saveState(path, state, T0);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 4);
    assert.equal(loadState(path, T0).switches.get("old")!.phase, "releasing");
  } finally { dir.remove(); }
});
