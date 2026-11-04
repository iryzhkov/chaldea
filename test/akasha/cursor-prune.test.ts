import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { EventStore } from "../../src/akasha/store.ts";
import { eventPage } from "../../src/akasha/compat.ts";
import type { Scope } from "../../src/akasha/auth.ts";
import { event, project, scratch, N } from "./helpers.ts";
import { hash } from "../../src/akasha/schema.ts";
const scope: Scope = { issuer: "operator", profile: "operator", source: "operator", project: "homelab", host: "homelab", global: true };
function fixture() {
  const dir = scratch(), store = new EventStore(join(dir.path, "events.db"), { initialize: true });
  // feed_post uses the same native cursor path as tool_call without extra payload fixtures.
  for (let i = 1; i <= 4; i++) store.admit(event(i), hash("fixture-" + i), N);
  project(store);
  return { dir, store, close() { store.close(); dir.remove(); } };
}
function query(kind = "feed_post") {
  return new URLSearchParams({ ...(kind ? { kind } : {}), limit: "1",
    from: new Date((N - 86400) * 1000).toISOString(), to: new Date(N * 1000).toISOString() });
}
function page(store: EventStore, q = query()) {
  const p = eventPage(store, q, scope, N), rows = [...p.rows];
  return { rows, cursor: p.next()! };
}
function next(q: URLSearchParams, cursor: string) { const p = new URLSearchParams(q); p.set("cursor", cursor); return p; }
test("fresh cursors traverse retained rows despite a pre-upgrade high global floor", () => {
  const f = fixture();
  try {
    f.store.put("floor", "999999");
    for (const q of [query(), query("")]) {
      const first = page(f.store, q);
      assert.equal(page(f.store, next(q, first.cursor)).rows[0]!.event_id, event(2).event_id);
    }
  } finally { f.close(); }
});
test("prune of another kind does not poison retained history, including new cursors after prune", () => {
  const f = fixture();
  try {
    f.store.db.prepare("UPDATE events SET kind='tool_call',expiry=? WHERE seq=4").run(N - 1);
    const first = page(f.store);
    f.store.prune(N);
    assert.equal(Number(f.store.get("floor")), 4);
    assert.equal(page(f.store, next(query(), first.cursor)).rows[0]!.event_id, event(2).event_id);
    const fresh = page(f.store);
    assert.equal(page(f.store, next(query(), fresh.cursor)).rows[0]!.event_id, event(2).event_id);
  } finally { f.close(); }
});
test("matching deletions above the position reset old cursors but permit fresh traversal", () => {
  const f = fixture();
  try {
    const first = page(f.store);
    f.store.db.prepare("UPDATE events SET expiry=? WHERE seq=3").run(N - 1);
    f.store.prune(N);
    assert.throws(() => page(f.store, next(query(), first.cursor)), /cursor_expired_reset/);
    const fresh = page(f.store);
    assert.equal(page(f.store, next(query(), fresh.cursor)).rows.length, 1);
  } finally { f.close(); }
});
test("deletions below the position permit progress; unfiltered cursors detect every kind", () => {
  const f = fixture();
  try {
    const first = page(f.store), second = page(f.store, next(query(), first.cursor));
    const all = page(f.store, query(""));
    f.store.db.prepare("UPDATE events SET expiry=? WHERE seq=1").run(N - 1);
    f.store.prune(N);
    assert.equal(page(f.store, next(query(), second.cursor)).rows[0]!.event_id, event(3).event_id);
    f.store.db.prepare("UPDATE events SET kind='tool_call',expiry=? WHERE seq=4").run(N - 1);
    f.store.prune(N);
    assert.throws(() => page(f.store, next(query(""), all.cursor)), /cursor_expired_reset/);
  } finally { f.close(); }
});
test("a prune during page streaming cannot produce a complete response with a silent hole", () => {
  const f = fixture();
  try {
    const q = query(); q.set("limit", "4");
    const p = eventPage(f.store, q, scope, N), rows = p.rows;
    rows.next();
    f.store.db.prepare("UPDATE events SET expiry=? WHERE seq=3").run(N - 1);
    f.store.prune(N);
    assert.throws(() => [...rows], /cursor_expired_reset/);
    assert.throws(() => p.next(), /cursor_expired_reset/);
  } finally { f.close(); }
});
test("legacy cursors reset, malformed generations and query changes refuse, reopen resets", () => {
  const f = fixture();
  let reopened: EventStore | undefined;
  try {
    const first = page(f.store);
    const c = JSON.parse(Buffer.from(first.cursor, "base64url").toString());
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    assert.throws(() => page(f.store, next(query(), encode({ ...c, g: "bad" }))), /invalid_cursor/);
    const legacy = { ...c }; delete legacy.g; delete legacy.r;
    assert.throws(() => page(f.store, next(query(), encode(legacy))), /cursor_expired_reset/);
    const other = next(query(), first.cursor); other.set("host", "other");
    assert.throws(() => page(f.store, other), /invalid_cursor/);
    reopened = new EventStore(f.store.path);
    assert.throws(() => page(reopened!, next(query(), first.cursor)), /cursor_expired_reset/);
  } finally { reopened?.close(); f.close(); }
});
