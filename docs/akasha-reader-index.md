# Akasha host and kind reader index

The version-1 open path adds only:

```sql
CREATE INDEX IF NOT EXISTS events_host_kind_seq_time
ON events(host,kind,seq,occurred_at);
```

EventStore keeps the existing one-step migrate list and user_version=1, then
creates the index idempotently on initialization and every reopen before the
receipt index bootstrap. A prebuilt index is accepted. host-v0.2.20's version-1
open path does not enumerate events indexes, and SQLite maintains unknown indexes
on writes, preserving the binary rollback path. Tests verify that the indexed
database still passes migrate(db, [() => {}]) and reopens at version 1.
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
and with only occurred_at>=?, plus populated v1 bootstrap and prebuilt-index reopen.

## First deployment

A normal restart is enough. The reviewer measured the index build on a copy of
the live snapshot containing 893k rows in a 2.59 GB database. The build took
1.8 s while holding the write lock, produced about 58 MB of WAL that was truncated
at the next checkpoint, and added an index of about 59 MB. The measured reader
query took 728 ms with events_host_seq before the change and 36 ms with the
covering index afterward. These are snapshot-copy measurements supplied in the
review, not a build or deployment against the live database by this change.

SQLite CREATE INDEX scans and sorts existing rows and holds the single writer
lock until commit. WAL readers can continue, but writers cannot. The synchronous
constructor cannot serve requests while it builds the index. Existing
busy_timeout=1000 may reject lock acquisition if another writer is active.

Provide free disk for the index, temporary sorting and WAL. The 4 GiB main-file
max_page_count still applies. journal_size_limit and wal_autocheckpoint do not
bound the WAL within a single schema transaction; the ordinary application write
reservation does not bound this bootstrap either. The measured roughly 58 MB WAL
fits the 64 MiB steady-state budget, but allow headroom for database growth.
No merge, release or deployment is included in this change.
