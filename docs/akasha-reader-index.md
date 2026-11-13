# Akasha host and kind reader index

Schema version 2 adds only:

```sql
CREATE INDEX IF NOT EXISTS events_host_kind_seq_time
ON events(host,kind,seq,occurred_at);
```

EventStore runs this through the existing transactional migrate helper on both
initialization and reopen. Failed DDL rolls back with user_version; a prebuilt
index is accepted. Version 1 runtimes reject version 2, so rolling back the binary
after migration requires a compatible runtime or an approved database recovery.
The envelope format and reader API do not change.

## Reader SQL

The structured endpoint, GET /api/v1/events, uses eventPage in
src/akasha/compat.ts. For a global reader with host and kind filters it builds:

```sql
SELECT seq FROM events
WHERE 1 AND occurred_at>=? AND occurred_at<=? AND host=? AND kind=?
AND seq>? ORDER BY seq LIMIT ?;

SELECT envelope FROM events
WHERE seq=? AND 1 AND occurred_at>=? AND occurred_at<=? AND host=? AND kind=?;
```

The first page binds seq=0; continuation pages bind the cursor's seq. LIMIT is
the requested count plus one. from/to supply the time bounds, defaulting to the
last seven days through now. The structured endpoint does not read a since
parameter; since is the time parser's name and the compatibility feed's parameter.
Non-global scopes add issuer/profile/project/source/host equalities. Optional
filters add source/session/tool/client/project equalities.

The index uses host/kind equality followed by the seq range and provides the
requested order. occurred_at is a residual filter, read directly from the covering
index for ID selection. It does not seek to the timestamp. This avoids payload
table reads for rejected timestamps, including narrow recent windows with many old
events. Putting occurred_at before seq would require sorting the time range.
Envelope retrieval remains an INTEGER PRIMARY KEY lookup. The compatibility
feedRows path uses feed_entries and is unchanged.

test/akasha/event-index.test.ts captures the actual first and continuation ID SQL,
checks EXPLAIN QUERY PLAN for the covering index with no TEMP B-TREE, and checks
the payload primary-key lookup. It also covers host/kind reads without time bounds
and with only occurred_at>=?, plus populated v1 upgrade and prebuilt-index reopen.

## First deployment

Do the first build in a planned stopped-service deployment window. No live index
build or deployment was performed for this change. SQLite CREATE INDEX scans and
sorts existing rows and holds the single writer lock until commit. WAL readers
can continue, but writers cannot; this is not an online concurrent index build.
The synchronous constructor cannot serve requests while it migrates. Existing
busy_timeout=1000 may reject lock acquisition if another writer is active.

Budget roughly 1-5 minutes for a 2.5 GB database on SSD, with slower storage or
contention potentially taking longer. This is an unmeasured planning estimate,
not a live-store benchmark. Database size and the reported 22.6 s filtered count
do not establish a reliable build duration. The index includes all event rows,
not just the reported 300,756 rows of one host and kind.

Provide free disk for the index, temporary sorting and WAL. The 4 GiB main-file
max_page_count still applies. journal_size_limit and wal_autocheckpoint do not
bound the WAL within a single schema transaction; the ordinary application write
reservation does not bound this migration either. Check headroom against the
actual retained row count and key lengths before deployment, especially the
64 MiB steady-state WAL budget. For a large build, prebuild the exact IF NOT
EXISTS DDL with the service stopped under an explicitly reviewed maintenance
space allowance, checkpoint/truncate WAL, then start the new binary. Startup
records version 2 without rebuilding the prebuilt index. Do not treat this note
as authorization to alter the live database.
