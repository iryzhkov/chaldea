import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { constants, openSync, closeSync, lstatSync } from "node:fs";
import { NEW_FEED_ID, canonical, ensure, eventId, hash, MAX_ENVELOPE, validateEnvelope, HttpError } from "../schema.ts";
import type { Envelope, FeedRow } from "../schema.ts";
import type { EventStore } from "../store.ts";
import { DAY } from "../store.ts";

export function legacyEnvelope(row: FeedRow, now: number): Envelope {
  ensure(Number.isSafeInteger(row.id) && row.id > 0 && row.id < NEW_FEED_ID, "legacy_id_range", 409);
  ensure(Number.isFinite(Date.parse(row.created_at)), "invalid_import_time");
  for (const key of ["created_at", "host", "source", "severity", "title", "body", "tags", "link"] as const)
    ensure(typeof row[key] === "string", "invalid_import_column");
  const event: Envelope = {
    v: 1, event_id: eventId(["legacy-feed", "legacy:feedd:" + row.id]), source_id: "legacy-feed",
    issuer: "legacy-feed", profile: "legacy-feed", project: "legacy-feed", source: "legacy-feed", host: "legacy-feed",
    run_id: "import", kind: "feed_post", received_at: new Date(now * 1000).toISOString(), occurred_at: row.created_at,
    severity: row.severity, title: row.title, body: row.body, tags: row.tags ? row.tags.split(",") : [],
    link: row.link, data: {}, provenance: { type: "legacy-feed", legacy_id: row.id, display_host: row.host, display_source: row.source, request_hash: hash(row) },
  };
  ensure(Buffer.byteLength(canonical(event)) <= MAX_ENVELOPE, "import_too_large", 413);
  return validateEnvelope(event);
}
/** Source must be an operator-created consistent snapshot. Never opens it writable. */
export function bridge(store: EventStore, snapshot: string, now: number, max = 100): { scanned: number; admitted: number; rejected: number; cursor: number } {
  ensure(Number.isInteger(max) && max >= 1 && max <= 1000, "invalid_import_batch");
  const source = new DatabaseSync(snapshot, { readOnly: true });
  let scanned = 0, admitted = 0, rejected = 0, cursor = store.cursor("legacy:feedd");
  try {
    source.exec("BEGIN");
    const largest = source.prepare("SELECT max(id) AS id FROM entries").get() as { id: number | null };
    ensure(largest.id === null || (Number.isSafeInteger(largest.id) && largest.id < NEW_FEED_ID), "legacy_id_range", 409);
    const rows = source.prepare("SELECT id,created_at,host,source,severity,title,body,tags,link FROM entries WHERE id>? ORDER BY id LIMIT ?").iterate(cursor, max);
    for (const raw of rows) {
      const row = raw as unknown as FeedRow;
      let event: Envelope;
      try { event = legacyEnvelope(row, now); }
      catch (e) {
        if (!(e instanceof HttpError) || e.status >= 500) throw e;
        store.rejectImport(row.id, e.message); rejected++; scanned++; cursor = row.id; continue;
      }
      if (Date.parse(row.created_at) / 1000 + 180 * DAY > now) {
        try { store.admit(event, hash(row), now, row.id); admitted++; }
        catch (e) {
          if (!(e instanceof HttpError) || e.status >= 500) throw e;
          store.rejectImport(row.id, e.message); rejected++; scanned++; cursor = row.id; continue;
        }
      }
      // Admission commits first; a crash before checkpoint repeats the same immutable ID/hash.
      store.transaction(() => store.setCursor("legacy:feedd", row.id), 8192);
      cursor = row.id; scanned++;
    }
    source.exec("COMMIT"); return { scanned, admitted, rejected, cursor };
  } finally { source.close(); }
}
export function reverseExport(store: EventStore, destination: string): number {
  // New file only: cannot accidentally overwrite feedd or an old rollback snapshot.
  const fd = openSync(destination, constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR, 0o600); closeSync(fd);
  const dir = lstatSync(dirname(destination));
  ensure(dir.isDirectory() && (dir.mode & 0o077) === 0, "unsafe_export_directory");
  const out = new DatabaseSync(destination); let count = 0;
  try {
    out.exec("PRAGMA synchronous=FULL; CREATE TABLE entries(id INTEGER PRIMARY KEY AUTOINCREMENT,created_at TEXT NOT NULL,host TEXT NOT NULL,source TEXT NOT NULL,severity TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,tags TEXT NOT NULL,link TEXT NOT NULL); BEGIN IMMEDIATE");
    for (const row of store.db.prepare("SELECT id,created_at,host,source,severity,title,body,tags,link FROM feed_entries WHERE id>=? ORDER BY id").iterate(NEW_FEED_ID)) {
      out.prepare("INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?)").run(row.id!, row.created_at!, row.host!, row.source!, row.severity!, row.title!, row.body!, row.tags!, row.link!); count++;
    }
    out.exec("COMMIT");
  } finally { out.close(); }
  return count;
}
export function parity(store: EventStore, snapshot: string, now: number): { compared: number; missing: number; extra: number; changed: number; differences: number[]; rejected: number; rejects: Array<{ id: number; reason: string }> } {
  const old = new DatabaseSync(snapshot, { readOnly: true });
  let compared = 0, missing = 0, extra = 0, changed = 0;
  const differences: number[] = [];
  const note = (id: number) => { if (differences.length < 100) differences.push(id); };
  try {
    old.exec("BEGIN");
    for (const raw of old.prepare("SELECT id,created_at,host,source,severity,title,body,tags,link FROM entries ORDER BY id").iterate()) {
      const r = raw as unknown as FeedRow;
      if (Date.parse(r.created_at) / 1000 + 180 * DAY <= now) continue;
      compared++;
      const actual = store.db.prepare("SELECT id,created_at,host,source,severity,title,body,tags,link FROM feed_entries WHERE id=?").get(r.id);
      if (!actual) { missing++; note(r.id); }
      else if (hash(actual) !== hash(r)) { changed++; note(r.id); }
    }
    for (const raw of store.db.prepare("SELECT id FROM feed_entries WHERE id<?").iterate(NEW_FEED_ID)) {
      if (!old.prepare("SELECT 1 FROM entries WHERE id=?").get(raw.id!)) { extra++; note(raw.id as number); }
    }
    old.exec("COMMIT");
    return { compared, missing, extra, changed, differences,
      rejected: store.scalar("SELECT count(*) FROM import_rejects"),
      rejects: store.db.prepare("SELECT id,reason FROM import_rejects ORDER BY id LIMIT 100").all() as unknown as Array<{ id: number; reason: string }> };
  } finally { old.close(); }
}
