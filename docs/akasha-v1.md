# Akasha v1 service (lane C)

Akasha is a separate Node 26.10.0 TypeScript process in Chaldea. It accepts authenticated
events, durably records pending receipts/outbox in local SQLite, publishes to JetStream,
and projects committed deliveries into a query store and the existing feed API.
No deployment, real credentials, fleet distribution, producer buffers, UI wall,
transcript ingestion, issuer, trust publisher or broker administration is included.

Binding design: Jocasta `tooling/research/chaldea-step7-akasha-brief-2026-10-17.md`,
document `2d21001bcb0769a46f3331f858935cdb@1`. Trust freshness comes exclusively from
package C's TrustStore; this service does not freeze the old 600-second freshness.
The parallel trust-bundle-24h change can be consumed without an Akasha API change.

## Start and prerequisites

Use `bin/akasha init --config /absolute/operator/config.json` exactly once for a new
event store, then `bin/akasha serve --config ...`. Initialization never overwrites
a database. The service user owns private 0700 local directories and 0600 database,
WAL, SHM, seed and backup files. Ancestors and config/adapters must be outside run
sandbox write access. Use local disk, never NFS/NAS. One service process/writer per
event store. Set the service umask to 0077 (the CLI also sets it).

The access paths below are rendered from `chaldea_access_paths` in
[chaldea-fleet-config inventory](https://github.com/iryzhkov/chaldea-fleet-config/blob/main/inventory/group_vars/all.yml).
Use `verifier_state`, `bundle`, and `clock_health` for `accessState`, `bundleFile`,
and `clockHealthFile`; the example illustrates that mapping. Other keys are placeholders.
Do not independently configure another trust-bundle extension or clock location.
The old snake_case config keys remain accepted with deprecation warnings; see
[configuration conventions](configuration.md) for the canonical keys and default XDG path.

```json
{
  "database": "/var/lib/akasha/events.db",
  "accessState": "/var/lib/akasha/access-state.db",
  "anchors": [{"kid":"deployment-1","public_key":{"kty":"OKP","crv":"Ed25519","x":"DEPLOYMENT_PUBLIC_KEY_BASE64URL"}}],
  "bundleFile": "/var/lib/chaldea-access-trust-public/bundle.jws",
  "clockHealthFile": "/run/chaldea-access-trust/clock-health.json",
  "registry": [{
    "issuer":"chaldea:agent-a","source":"chaldea.daily-health.agent-a","host":"agent-a",
    "source_id":"agent-a-daily-health","profile":"daily-health","project":"homelab",
    "mode":"report","kinds":["report"]
  }],
  "natsUrl":"wss://broker.example.invalid/nats",
  "natsSeedFile":"/var/lib/akasha-secrets/nats.seed",
  "bind":"127.0.0.1","port":1935
}
```

Provision package C's durable AccessState separately; serving never initializes or
repairs lost authorization state. The independent authenticated trust updater owns
the signed bundle file. Akasha installs that local signed file at startup and every
`TRUST_POLL_SECONDS` (package C's 120s); failed refresh preserves signed expiry.
No online issuer/policy request occurs per event. Missing adapters prevent enablement.
Clock health is `{healthy,offsetSeconds,checked_at}`, refreshed externally within 30s.
Clock checks use the Linux boot ID, monotonic time and durable package C high water.
No assumed healthy clock, freshness override, audience alias or shared-key fallback.

Only loopback HTTP is accepted; infrastructure supplies authenticated HTTPS ingress.
NATS requires WSS or TLS with the service's private NKey file. Test-only direct
loopback transport is explicitly enabled only in disposable tests. Connect uses
`_INBOX_akasha`; the service validates the pre-existing stream and consumer and cannot
create them. Infra must provision AKASHA_EVENTS with 320 KiB maximum messages,
14d/1 GiB, file/Limits/discard-old, one replica, 10m dedup, max consumers 8;
akasha-ingest must be durable pull, explicit ACK, 60s ack wait, max deliver 10,
max ack pending 1000, max batch 500. Application fetches at most 100 messages.
Grant the gateway only approved `akasha.<source_id>.<kind>` publication plus its
stream-info, consumer-info/pull, sequence-read, ACK APIs and inbox. Raw host users
must not publish Akasha subjects. No create/delete/admin grant is required.

## Authorization and producer contract

Bearer compact JWT <=16 KiB, audience exactly `akasha`, resource exactly the token's
source, action `append` or `read`. Package C verifies issuer ceiling, type/algorithm,
signature, lifetime, clock, durable trust/rotation/history. The service registry
matches issuer/source/host plus owning profile/project. Duplicate subject IDs or
identities fail startup. Registry kinds restrict append. Every grant resource in
an Akasha token must equal its source.

Registry modes: `report` is append-only and cannot read even if an issuer mistakenly
grants read; `service` may read its own source/profile/project/host if granted;
`operator` with explicit `global_read:true` may read globally. All source scope
conditions are in SQL before rows, cursor or show results leave the process.
Receipts always require their exact owning principal and logical key, even for operators.
A quota service registration may opt into quota_fleet_read:true. This permits
only quota_headroom_snapshot reads across hosts in its same source quota,
profile and project, with no global read or foreign-receipt access. Snapshot
data uses the closed [fleet capacity schema](quota-fleet.md).

Structured POST `/api/v1/events` requires `Idempotency-Key` (1–256 printable ASCII)
and `{v:1,kind,title,...}`. Optional host/source/run_id/project assertions must match
verified claims. Caller issuer/profile/source_id/received_at/provenance are rejected.
Identity and receive time are derived; producer occurrence time is retained separately.
Only import can preserve feed created_at. A legacy scoped POST cannot supply created_at.

The envelope has v/event_id/source_id/source/host/issuer/profile/project/run_id/kind/
received_at/occurred_at/severity/title/body/tags/link/data/provenance. Verified provenance
contains request_hash and the reserved feed_id (null for tool calls), enabling trusted
NATS tail replay after restoring an event-store backup. Consumer registry checks bind subject IDs to registered identity/kind; restored feed IDs may advance the allocator by at most ten million, preventing a single-message exhaustion jump. It contains no bearer/key.
Service retries retain the first run attribution across refreshed leases. Report keys
are additionally bound to the verified run. IDs are SHA-256 of a versioned
length-delimited issuer/profile/project/source/host/kind/key tuple (plus report run).
Normalization happens before receive time and authorization-run attribution.
Same tuple/hash returns the original receipt, changed payload returns 409, including
pending retries. Every retry reauthorizes; expired requests create no new receipt.

The closed kinds are feed_post/report, quota_parked/quota_reset_unknown/quota_resumed/restart_resumed/
provider_switched/provider_switch_failed, tool_call, deployment_finished/job_finished,
task_started/task_finished, review_verdict/review_note and agent_status. Registry
enablement is required for actual producers; emitting a kind conveys no command authority.
`schema.ts` defines the exact allowlist and types for every kind's data. Tool records
require ts/session/proc/seq/client/tool/args/outcome/ok/tool_source/raw_line_hash;
optional err is a bounded class, exit/ms are integers, root requires registry approval.
Argument values, raw error prose, tool output and transcripts are rejected. The legacy
unknown-option name `?` is preserved. Tool prose fields must be empty.

Structured request and canonical envelope <=64 KiB, data <=48 KiB, title <=500 Unicode
characters, <=32 tags/2 KiB, link <=2 KiB. Legacy request <=256 KiB, canonical feed
envelope <=320 KiB; the full body is preserved. Legacy title trimming/truncation and
tag normalization match feedd. Initial source rate 10/s with burst 100, HTTP concurrency
8, bounded headers, 5s body deadline, 10s response limit. Rate/bounds return 429/413;
capacity and pending visibility return 503. Single-event ingress only; no batch or blob
upload. Keep logical keys when retrying 429/503.

## HTTP and legacy CLI compatibility

| Surface | Result |
| --- | --- |
| GET /healthz | 200, exactly `{"ok":true}`; no secret/global state |
| GET /api/entries | legacy array; API default 100, max 1000 |
| GET /api/entries/NUMERIC | unchanged row or 404; unauthorized rows hidden |
| POST /api/entries | 201 unchanged row only after visible SQL projection |
| GET / or /index.html | authenticated, escaped feed HTML; safe http(s) links only |
| GET /api/v1/events | `{events,next_cursor}`; default 100/max 1000 |
| GET /api/v1/receipts?kind=K&key=KEY | exact own append principal/key, no listing |
| GET /api/v1/health | operator-only pending/byte/cursor/alarm diagnostics |

Legacy row keys remain id/created_at/host/source/severity/title/body/tags/link;
tags remain comma-separated and new metadata stays in the v1 API. Sort is created_at
DESC then id DESC. Preserve duration/ISO since, host/source/severity/tag and SQLite
LIKE title/body grep (including LIKE wildcards, max 256 characters); time/scope/equality/tag filters run in candidate SQL. Remaining LIKE grep scans return 503 before headers if they exceed 10,000 candidates, 32 MiB of nonmatching bodies or 250ms SQLite work; only <=1000 matching IDs are preflighted. Invalid/negative limits return 400,
zero returns an empty array. Rows are read individually without a SQLite reader
spanning a network wait. Serialized feed JSON, HTML and native events coalesce into
at most 64 KiB UTF-8 network chunks, retaining only one pending chunk and one bounded
row rather than the response body. A single oversized legacy row retains its
existing bound (including HTML escaping). Full authorization rechecks before every
network chunk and after backpressure waits; clocks, revocation, expiry and the 10s
response deadline remain unchanged. No bearer/payload/request URL logging.

Every JWT in a query string is rejected, including operator-profile JWTs. This slice chooses scoped operator-profile tokens and bearer-header HTML authentication; it implements no static operator credential fallback. Lane L must refuse scoped feed open/url before printing a URL. Responses disable caching and referrers; proxy logging
must redact query strings/Authorization. No link is fetched by Akasha.

The homelab-cli fixtures under test/akasha are pinned unchanged to
`d0b64f63f429bc52022b79d9d36344187ddcfd0a` (PR #13); their README records provenance.
The compatibility tests exercise recent/list (7d/50 defaults), filters,
--json/--full, post body files/stdin, tags/links, show and health against Akasha.
Scoped tokens come from the environment, a helper or a private token file; tests
cover omitted identities, idempotent replay/conflict, rejected HTTP/JSON delivery
and refusal of scoped open/url. A loopback legacy HTTP fixture separately checks
dotless key-file credentials, legacy identity defaults and open/url. Akasha itself
continues to require scoped credentials.

## Durable delivery, capacity and recovery

Admission commits immutable receipt/envelope/outbox with FULL synchronous SQLite
before publishing. No transaction spans NATS waits. Publisher sets Nats-Msg-Id to
event_id, expects AKASHA_EVENTS and awaits PubAck. Consumer commits event, projection,
receipt state and stream cursor atomically before ACK. Lost PubAck/ACK and redelivery
are covered by SQL uniqueness, independently of broker dedup. A late consumer may
complete an accepted event after the original bearer expires; caller access still
requires a fresh valid bearer. Ingress waits up to 1800 ms for an in-process
notification after the store commits projection or quarantine, then rechecks
authorization and reads the scoped receipt again. It does not poll or hold a read
transaction while waiting. A pending POST returns 503 with pending:true/event_id/
state/feed_id, never a fabricated legacy success. Tombstones return 410.

When homelab restarts, the durable outbox drains. NATS outage does not remove already
accepted events. Admission stops at protected-state limits. Producer-side buffering
during Akasha/host unavailability belongs to lane P. A single homelab process/disk is
not HA; no zero-loss disaster recovery is claimed.

Main DB max 4 GiB with SQLite page limits, WAL max 64 MiB, outbox 128 MiB and bounded
quarantine 16 MiB within main. Writes reserve WAL space, checkpoint before crossing
the limit and refuse if a reader blocks reclamation. Read statements end before
HTTP waits. Byte estimates reserve pages for bounded writes; SQLITE_FULL preserves
pending work and pauses intake. Logical outbox/quarantine limits are checked before
commit. Index-ordered expiry and receive-time selection avoids table scans/sorts during cleanup. Pruning at startup/hourly catches up through yielding byte-bounded transactions, including expired receipts, with admission-triggered pressure cleanup: expiry first, oldest terminal
payloads under pressure, protecting pending intents and unexpired receipts. Incremental
vacuum/free-page reuse/checkpoints reclaim space without a full vacuum copy. Receipt
tombstones remain 180d; no retry recreates a retained tombstone.

Feed/lifecycle/deployment/job/review/agent summaries expire after 180d from receive
time. Tool calls expire after 90d from original occurrence, clamped to server admission for future producer timestamps. Legacy import expiry uses
original created_at, with the same future-time clamp. Loki raw logs remain separately 30d. Cursor stores epoch/local
seq plus query/scope binding. Pruned/foreign-epoch cursors return 410/reset; authorization
always filters replay. Stream first-sequence gaps, quarantine, delivery exhaustion,
capacity and >60s backlog are health alarms, never asserted complete history.
At max delivery/transient SQL failure, keep the intent and alarm; operator replay uses
`akasha replay --config ... --from SEQ --to SEQ` (<=100 sequences per operation)
before the 14d broker retention expires. Invalid messages store only bounded reason/
sequence metadata in quarantine and get a terminal ACK. An exact corrupted pending intent becomes quarantined/422 and leaves the outbox; a conflicting forged copy never cancels the legitimate intent. Contiguous stream progress, gaps and exhaustion evidence survive restart.

`backup --output /private/path/snapshot.db` makes one consistent SQLite snapshot,
including receipts/cursors/allocator. A single backup step covers the maximum configured pages, avoiding restart starvation from concurrent writers. It replaces one rolling backup (no second
full-size staging copy); on interruption a backup may need replacement. Keep backup
packaging outside this process and choose/verify RPO (proposed <=24h) before deployment.
Main+WAL+one <=4 GiB backup stay below 10 GiB; NATS's 1 GiB is separate. Restore the
event-store snapshot, preserve the CURRENT separate AccessState/trust high water,
then replay available NATS sequences. Never restore old authorization history or
restart a missing access database. Actual host allocation/free-space checks and
backup schedule/restore probes belong to approved rollout.

## Migration and rollout gates

`import --snapshot FILE` reads an operator-produced consistent read-only feedd
snapshot, at most 100 rows per invocation; repeat for catch-up. Same command is the
incremental committed-row bridge, with durable legacy:feedd ID checkpoint. A crash
after admission and before checkpoint repeats the same immutable key safely.
Do not point it at an inconsistent copied DB lacking its WAL. Old feedd stays unchanged
and authoritative for that cohort. Retained imports keep exact columns/IDs/timestamps;
IDs >=10^12 in legacy input or any collision fail. New feed IDs start at 10^12 and
a durable allocator never renumbers history. Attribution is legacy-feed, while old
host/source are explicitly unverified display provenance and visible only to operators.

`parity --snapshot FILE` compares retained row payload hashes/IDs and reports
missing/extra/changed plus at most 100 differing IDs plus a durable explicit reject count/list; nonzero differences fail. Parseable non-ISO historical dates are preserved verbatim. Invalid/oversize imports record ID/reason and advance the checkpoint, so later rows can progress; rejects remain a failed parity gate.
`export --output FILE` creates a new private feedd-shaped SQLite file containing
Akasha-only feed rows with original numeric IDs. Reconcile this file into the rollback
snapshot before directing readers back. It never overwrites an existing destination
or re-enables the exposed shared credential.

Before reader cutover: seven consecutive days, >=100 legacy feed records and >=1000
tool calls, all active source/hosts, exact normalized multisets and representative
filters/show; zero unexplained differences. Then retain the 7d rollback window and
14d private snapshot. Fault test 10,000 publishes/20% losses/restart/actual >10m dedup
expiry is source validation. Live canary must separately establish p95 <=2s, p99 <=5s
at 10 events/s, no healthy backlog >60s and 1h outage drain <=10m. No observation
window is shortened here. Retirement requires Igor's separate approval.

## Validation

Local: `TMPDIR=/disk/scratch CHALDEA_TEST_SCRATCH=/disk/scratch npm run akasha:test`.
Frozen access vectors remain package C's tests and are untouched. Unit tests isolate
all runtime state, CLI HOME/config/spool and SQLite fixtures under explicit scratch;
no test uses the operator's keys/home state.

Heavy, on agent-a only:
`chaldea exec --host agent-a --artifact .akasha-job/results.json -- sh test/akasha/run-heavy.sh`.
The runner downloads pinned NATS 2.15.1 and verifies the fixed SHA-256, provisions
disposable accounts and ephemeral test keys, then tests the production worker start/pump/consume and reconnect path, actual 60s broker redelivery, durable gaps, broker ACLs, 10,000 logical
publishes, 20% lost responses/ACKs, repeated delivery, crash/restart receipts, a stopped
broker/outbox drain, actual 601s dedup expiry and exact visible counts/conflicts.
The outage test is accelerated; it does not claim the separate one-hour canary.
An additional agent-a run with AKASHA_PERFORMANCE_ONLY=1 runs the 100,000-row index/pruning and >10,000-old-row HTTP/scoped-reader regressions, then a distinct established-connection NATS restart probe. It does not replace or shorten the full 601s deduplication test.
`fixtures/homelab-cli` is an unchanged compatibility fixture, not a second installed CLI.
