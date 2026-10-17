import { test } from "node:test";
import assert from "node:assert/strict";
import { rig, N } from "./helpers.ts";
import { feedRows } from "../../src/akasha/compat.ts";
import { NEW_FEED_ID } from "../../src/akasha/schema.ts";
import type { FeedRow } from "../../src/akasha/schema.ts";

type Rig = Awaited<ReturnType<typeof rig>>;
function seed(r: Rig, count: number, foreign = 0): FeedRow[] {
  const insertEvent = r.store.db.prepare("INSERT INTO events(event_id,envelope,issuer,profile,project,source,host,kind,received_at,occurred_at,expiry) VALUES(?,?,?,?,?,?,?,?,?,?,?)");
  const insertFeed = r.store.db.prepare("INSERT INTO feed_entries VALUES(?,?,?,?,?,?,?,?,?,?)");
  const expected: FeedRow[] = [];
  for (let start = 0; start < count + foreign; start += 1000) r.store.transaction(() => {
    for (let i = start; i < Math.min(start + 1000, count + foreign); i++) {
      // Nonmonotonic timestamps and ties across page boundaries catch ID-only
      // ordering, reversed ties and skipped/duplicated candidate pages.
      const time = new Date((N - (i * 17 % 101)) * 1000).toISOString(), eventId = "dense-" + i;
      insertEvent.run(eventId, "{}", i < count ? r.r.issuer : "foreign", r.r.profile, r.r.project,
        r.r.source, r.r.host, "feed_post", time, time, N + 86400);
      const row: FeedRow = { id: NEW_FEED_ID + i, created_at: time, host: r.r.host, source: r.r.source,
        severity: "warn", title: "Hello " + i, body: "full body " + i, tags: i % 3 ? "abc-more" : "abc,def", link: "" };
      insertFeed.run(row.id, eventId, time, row.host, row.source, row.severity, row.title, row.body, row.tags, row.link);
      if (i < count) expected.push(row);
    }
  }, 4 * 1024 ** 2);
  return expected.sort((a, b) => a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id - a.id);
}
function scope(r: Rig, global: boolean) {
  return { issuer: r.r.issuer, profile: r.r.profile, project: r.r.project, source: r.r.source, host: r.r.host, global };
}

for (const count of [20_000, 60_000]) for (const global of [true, false]) {
  test("dense legacy feed: " + count + " matching rows, " + (global ? "global" : "scoped"), async t => {
    const r = await rig(global ? "operator" : "service");
    try {
      const expected = seed(r, count, global ? 0 : 100), s = scope(r, global);
      for (const limit of [50, 1000]) {
        const query = new URLSearchParams({ limit: String(limit) });
        const rows = [...feedRows(r.store, query, s, N)];
        assert.deepEqual(rows.map(row => ({ ...row })), expected.slice(0, limit));

        // Legacy list has no cursor: drain only this disposable fixture between
        // calls, then roll back. Check the full ordered ID sequence, including
        // an empty final page, for both page sizes.
        r.store.db.exec("SAVEPOINT drain");
        const remove = r.store.db.prepare("DELETE FROM events WHERE event_id=(SELECT event_id FROM feed_entries WHERE id=?)");
        const seen: number[] = [];
        try {
          for (;;) {
            const page = [...feedRows(r.store, query, s, N)];
            assert.deepEqual(page.map(row => row.id), expected.slice(seen.length, seen.length + limit).map(row => row.id));
            if (!page.length) break;
            seen.push(...page.map(row => row.id));
            for (const row of page) remove.run(row.id);
          }
          assert.deepEqual(seen, expected.map(row => row.id));
          assert.equal(new Set(seen).size, count);
        } finally { r.store.db.exec("ROLLBACK TO drain; RELEASE drain"); }
        t.diagnostic(JSON.stringify({ count, scope: global ? "global" : "scoped", limit, coverage: seen.length }));
      }
      assert.throws(() => [...feedRows(r.store, new URLSearchParams("limit=1000&grep=absent"), s, N)], /query_scan_budget/);
    } finally { r.close(); }
  });
}

test("legacy candidate pages preserve filters/LIKE and recheck SQL scope after yields", async () => {
  const r = await rig("service");
  try {
    const expected = seed(r, 310, 20), s = scope(r, false);
    const query = new URLSearchParams({ limit: "50", since: "7d", host: " " + r.r.host + " ", source: " " + r.r.source + " ",
      severity: " WARN ", tag: " ABC ", grep: " H_llo% " });
    assert.deepEqual([...feedRows(r.store, query, s, N)].map(row => ({ ...row })), expected.filter(row => row.tags === "abc,def").slice(0, 50));
    // Enough LIKE misses to cross several candidate batches, including tied dates.
    for (const limit of [7, 50]) {
      const grep = new URLSearchParams("limit=" + limit + "&grep=body%25_0");
      assert.deepEqual([...feedRows(r.store, grep, s, N)].map(row => ({ ...row })), expected.filter(row => /body.*.0/.test(row.body)).slice(0, limit));
    }
    assert.deepEqual([...feedRows(r.store, new URLSearchParams("limit=1000"), s, N)].map(row => ({ ...row })), expected);
    assert.deepEqual([...feedRows(r.store, new URLSearchParams("limit=0"), s, N)], []);
    assert.deepEqual([...feedRows(r.store, new URLSearchParams("since=2999-01-01"), s, N)], []);
    const rows = feedRows(r.store, new URLSearchParams("limit=50"), s, N);
    assert.equal(rows.next().value?.id, expected[0]!.id);
    r.store.checkpoint(); // No live SQLite reader is held at the yield.
    r.store.db.exec("UPDATE events SET issuer='foreign'");
    assert.deepEqual([...rows], []);
  } finally { r.close(); }
});

test("performance: dense feed query scaling (operation only, generous CI guard)", async t => {
  // Keep timing out of the exhaustive pagination assertions above. Seed and warm
  // outside the measurement; synchronous query execution has no polling delay.
  // Medians and fixed slack tolerate hosted-runner noise while guarding scaling.
  for (const global of [true, false]) {
    const medians: number[] = [];
    for (const count of [20_000, 60_000]) {
      const r = await rig(global ? "operator" : "service");
      try {
        seed(r, count, global ? 0 : 100);
        const s = scope(r, global), query = new URLSearchParams("limit=1000");
        assert.equal([...feedRows(r.store, query, s, N)].length, 1000);
        const samples: number[] = [];
        for (let i = 0; i < 5; i++) {
          const started = performance.now();
          const rows = [...feedRows(r.store, query, s, N)];
          samples.push(performance.now() - started);
          assert.equal(rows.length, 1000);
        }
        medians.push(samples.sort((a, b) => a - b)[2]!);
      } finally { r.close(); }
    }
    const [small, large] = medians as [number, number];
    t.diagnostic(JSON.stringify({ scope: global ? "global" : "scoped", rows: [20_000, 60_000], medianMs: medians }));
    assert.ok(Math.max(small, large) < 5000, "query operation CI guard: " + medians);
    assert.ok(large < small * 6 + 250, "3x rows must not cause runaway query scaling: " + medians);
  }
});
