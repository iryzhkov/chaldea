# Hosted Mission Control, one-source canary

This source path serves Mission Control on Normandy while agent-a captures its
own official T3 subscriptions. It does not need a running T3 server on the web
host or the PC. Existing local `mission-control serve` behavior remains available.

This is an opt-in source capability. Installation, grants and live activation
are separate gates. No configuration below grants itself access.

## Activity and views

Agent summary shows bounded per-host state/model counts, including observed zero
and not-observed hosts. Counts describe shown rows when a source is truncated.
Live threads keeps the existing density tiers and portrait paging within the
48-row bound. Its source age and activity age are independent; a quiet connected
thread remains live while its source is fresh.

The optional strict `rich.v2` field set carries official whole-host CPU/RAM and
bounded agent details through the same capture → ordinary collector → Akasha →
restricted reader/cache → API/SSE path. Legacy v1 snapshots remain valid. Old
validators reject the extension and new state enums: upgrade H's host validator
and N's reader/web first, then compatible ordinary collectors, and capture
producers last. Source-only acceptance is not live qualification. Preserve all
older immutable releases and rollback state; roll producers back before older
validators. No new grants, identity, publisher or data store are needed.

Base rows fit the unchanged 8 KiB budget first. Resources and sanitized actual
titles/app thread IDs follow, then full details when they fit. IDs in base rows
remain epoch-local opaque keys; displayed app IDs are labelled, bounded to 256
UTF-8 bytes, and copyable only when complete. Titles are bounded to 160 bytes,
assistant paragraphs to 384, and up to three active command summaries to 128
bytes each. Missing/identity-only detail, omitted commands, withheld sensitive
content and truncation remain explicit. HTML uses escaped text. Provider
conversation IDs, prompts, reasoning text and arbitrary tool outputs stay private.

Effort is either provider-reported, explicitly configured, or not reported.
Thinking requires a running reasoning item, never elapsed silence. Terminal
command/run updates and bounded reconnect snapshots clear active commands.
Existing density tiers and portrait paging are retained; state sits beside Task
or Agent and the sanitized title is the main heading.

Usage uses normalized main-agent turn totals, replaced by stable internal turn
identity across reconnects. Snapshot replacement clears the retained usage window,
including removed turns. Missing normalized turns make coverage partial.
A separate usage-only proof requires an exact app/provider-thread association,
a unique same-thread self-rooted root_turn node and its matching provider thread.
Optional resolved run/attempt rows must agree with present non-null ownership
fields. Missing historical rows and null reverse pointers are neutral. Reverse
turn pointers name the latest turn, so multiple turns per root/run are legal.
Duplicate identities, conflicting root ownership and contradictory non-null
provider owners are rejected using the full snapshot before selection. The existing
provider metadata, activity ownership and child-roster admission guard is intact.
Proof storage is bounded to 16 relevant providers, 64 nodes, 128 runs, 128 attempts,
128 turn identities and eight pending/observed turns per thread. Stream proof
overflow fails closed until a new snapshot; ambiguity poison is never evicted.
Only relationship fields and normalized
usage are retained. Event ordering can defer qualification; later contradictory
updates withdraw contributions, and reconnect snapshots replace the proof window.
No history database or additional RPC is used. At most eight observed turns per shown thread are
retained; snapshot truncation and stream eviction mark coverage partial across reconnect. Input + output is the observed total.
Cache reads/writes are input subsets and reasoning is an output subset. Context
occupancy is separate. Live context counters do not qualify a generation rate:
rate stays null/not reported, as do daily totals and cost. Host/model aggregates
cover observed main-agent turns only and disclose missing rows. The Tokens page
uses unique transported agent details, at most 48 shown threads, and does not add
overlapping host summaries. Each field names its contributing thread count;
zero is known and absence is unknown. Source freshness and retained coverage are
shown separately. Generation rate, p95, daily totals and model history remain
unavailable. Child provider
turns are excluded from parent usage. Delegate/native child rosters deduplicate
actual child IDs, distinguish active/queued/completed observations, and remain
bounded; parent work rosters are not additive. Empty unsupported native
background rosters and unavailable Chaldea durable waits stay unknown.

Host resources use only `server.getHostResources` on the existing shell
connection, one request at a time, a three-second timeout and five-second delay.
Denial or lack of support leaves threads working and resources unavailable.
CPU utilization is a 0–1 fraction, displayed as percent. Used RAM is
max(0, total − available); resource sample age is independent of thread age.
Other hosts remain not reported until their existing read permissions and
natural publication are qualified.

Storage caps are unchanged. Payload TTL is one hour, receipts one day; ordinary
maintenance runs at startup and hourly, so expired payloads may remain on disk
until the next sweep. The main database cap remains 4 GiB, with separate 64 MiB
per-source and 128 MiB aggregate status budgets. Five seconds is a conservative
cadence choice, not a claim that all shorter intervals exceed capacity.

## Processes and configuration

Run `chaldea mission-control capture --config /etc/mission-control/capture.json`
on the producer. The config contains only these keys:

```json
{
  "host": "agent-a",
  "t3BaseDir": "/home/igor/.t3",
  "tokenFile": "/home/igor/.config/chaldea/t3-token",
  "snapshotFile": "/home/igor/.local/state/chaldea/mission-control/latest.json",
  "tokenSemanticsQualified": false
}
```

The token remains local and must already have read-only orchestration access.
Capture uses only the existing official adapter. Its private output parent must
exist, be a real directory and have no group/world access. Atomic output is
0600. A synchronized live subscription samples current connectivity/state every
five seconds. Row, detail and token observation timestamps retain their original
values. Disconnects stop observation-time advancement. No T3 or quota restart is
part of this capability. Capture and web retain NoNewPrivileges.

Configure the existing collector with optional `missionControlSnapshotFile`
in events.json, or `AKASHA_MISSION_CONTROL_SNAPSHOT_FILE` for the bundled host
collector. The value must be absolute. Absence leaves the optional slot and
network attempt disabled. `scripts/build-host.mjs` bundles the same
`src/events/collector.ts`; it does not introduce another collector.

The native collector keeps one coalesced latest sample and one frozen pending
publication in its existing 16 MiB database. It attempts status before ordinary
backlog, using the existing publisher's five-second network timeout. The helper
has its existing separate two-second bound. Pending identity and bytes survive
restart unchanged. New admissions are at least five seconds apart. A pending
attempt expires after 120 seconds as an explicit `status_expired_gap`, not a
delivery. A terminal server tombstone is also a status gap; ordinary collectors
retain their existing tombstone acknowledgement behavior. New input must itself
be at most 120 seconds old. Optional status persistence or counter exhaustion
cannot prevent ordinary backlog delivery. A new status is sent only after its
frozen slot is saved; a failed acknowledgement save retains that same slot for
retry. Optional counters and a fixed deferred diagnostic are best effort.

The source timer uses OnUnitInactiveSec=5s, RandomizedDelaySec=1s and
AccuracySec=1s. Ordinary delivery yields after a two-second elapsed slice at a
durable ACK/cursor boundary, retaining pending backlog and the existing 100-event
limit. Each invocation attempts status first and makes ordinary progress.
An in-flight helper/request can exceed the slice; its existing timeouts remain.
Retention pruning still runs independently of delivery health.

The reader keeps its five-second refresh and the web reloads cache every second.
Healthy quiet-path latency is expected in seconds, but five seconds is not a
delivery guarantee. Deployment measurements must establish actual latency and
laptop overhead. This remains latest sampled state, not every intermediate step,
with hosted source stale after 90 seconds and lost after ten minutes.

Run `chaldea mission-control reader --config /etc/mission-control/reader.json`
under a dedicated non-login reader account:

```json
{
  "url": "https://akasha.ryzhkov.dev",
  "tokenHelper": "/usr/local/libexec/chaldea-akasha-token",
  "source": "mission-control-reader",
  "host": "omarchy-normandy",
  "profile": "mission-control-reader",
  "project": "chaldea",
  "allowedSourceIds": ["agent-a--mission-control"],
  "cacheFile": "/var/cache/mission-control/latest.json",
  "refreshMs": 5000
}
```

The helper executable path is deployment configuration, not a claim that the
illustrated path is installed. Its fixed argv is `--audience akasha --action read
--source mission-control-reader --host omarchy-normandy --kind agent_status`.
Profile/project come from the exact helper enrollment. No token file, browser
token or arbitrary endpoint option is accepted.

Each refresh binds all pages to one fixed latest-120-second query. It reads at most four
128-event pages with a five-second deadline and a 2 MiB response cap. Redirects
are errors. A 410 cursor reset marks a gap and starts the same bounded query
without that cursor. Partial, oversized or malformed traversals retain the
previous good cache and mark a gap. A later complete authorized traversal clears
that transient transport gap when the current traversal has no reset, epoch
change or clipped coverage. Intrinsic row truncation and same-epoch unknown or
partial token evidence remain independent and do not become complete on recovery.
Fetch time never replaces producer time.

Run `chaldea mission-control serve --config /etc/mission-control/server.json`
under the separate web account:

```json
{
  "mode": "cache",
  "siteOrigin": "https://chaldeas.ryzhkov.dev",
  "listen": "127.0.0.1",
  "port": 7392,
  "cacheFile": "/var/cache/mission-control/latest.json"
}
```

Cache mode never discovers T3, reads an orchestration token or invokes a helper.
Unknown cache/source state does not prevent HTTP startup. On restart, retained
fresh cache is labeled cached until a strictly newer validated source tuple and
observation arrives. The first successfully loaded sample for each source is the
baseline, including after an initially missing or unreadable cache. Re-reading the same file or an older epoch cannot warm it. The reader owns the
2750 SGID cache directory with group mission-control-cache; the web account has
read-only supplementary group access. Atomic cache files and their same-directory
temporary files are explicitly 0640 before rename. The reader's private state
and helper are not accessible to the web account.

The cache is at most 512 KiB, four sources and 48 global rows, expiring retained
observations after 24 hours. Clipped rows keep exact total-or-null and incomplete
coverage. Each source's latest epoch/sequence replaces its previous sample.
Repeated or older samples cannot renew age. Unknown or partial token coverage
cannot become complete within the same epoch; changed epochs mark a gap.
Tokens remain unknown by default until real semantics are qualified.

## Wire and authorization

`agent_status` carries exactly `data: {snapshot: ...}` for this form. Its schema
is `mission-control.host.v1`, with an 8 KiB snapshot cap. The fixed envelope
title is `Mission control status`; body, tags and link are empty. Occurrence
time equals the original snapshot observation time.

Snapshot fields are `schema, host, epoch, sequence, observedAt, connected, total,
truncated, agents, tokens`. Epoch is 32 lower-case hex characters and sequence
is a positive safe integer. Agent rows contain only `id, model, state, startedAt,
observedAt, detailObservedAt, connected, steps`. IDs are 16-character epoch-local
hashes of source IDs. Models and states have explicit allowlists. At most six
tool labels are retained, drawn from read, search, navigate, edit_apply,
change_plan and verify_run. Browser titles are always Task. No arbitrary title,
prompt, args, command, output, path, account, alias or credential is exported.

Tokens contain `qualified, output, rate, observedAt, coverage`. Unqualified
values are null with unknown coverage. Qualified values mean current
process-epoch observed output and 60-second average output rate. They are not
daily totals, wallet quota or provider cost. Same-epoch samples replace totals,
and multiple delivery attempts never add them again.

Publisher identity must be exactly issuer chaldea:agent-a, host agent-a, source
agent-a.mission-control, source_id agent-a--mission-control, service profile
mission-control-publisher, project chaldea, kind agent_status, append only.
Identity binding is checked at ingress and envelope decode.

The reader registration uses source mission-control-reader, host
omarchy-normandy, service profile mission-control-reader, project chaldea,
kind agent_status and `mission_control_read_sources: ["agent-a--mission-control"]`.
Authorization validates the selector against explicitly registered publishers,
with at most four distinct sources. The server SQL independently limits source
IDs, kind, version, publisher profile and project. The reader can call only
GET /api/v1/events; no append, generic feed, health appendix, foreign receipt,
global_read or quota_fleet_read is granted. Existing quota sharing remains off.

Status payload retention is one hour from the earlier producer/server
observation time. Status creates no generic feed entry. Compact receipts last
24 hours. Broker replay after receipt expiry advances the cursor without
recreating old status payloads or receipts. Queries enforce expiry even before
the ordinary pruner runs. A source has a 64 MiB status bound, with 128 MiB across
at most four publishers, inside existing store capacity. Admission refuses
pressure without evicting unrelated protected data; pending outbox/receipt
relationships retain existing protections.

## Optional hosted quota and operations

The next compatible host/client batch adds optional per-host quota on the
existing signed agent_status snapshot. Capture reads only quota-observer.json
under the effective UID's configured state directory, with a private 0700 parent,
0600 single-link regular file and no symlink traversal. It parses the existing
observer version and validated headroom, never account credentials. The compact
closed account tuples retain included, credit and manual-reset observation times.
At most four internally deduplicated accounts leave each host, with generic
provider account labels. Accounts are never merged across hosts.

Base rows, resources and identities fit before quota; compact useful activity
is offered to every admitted thread before verbose upgrades. Omission is
byte-budget data, not a cap increase. The reader can retain last-good per-host
quota independently. Its metric age always comes from the original observation,
including after another host poll or an omitted sample. Zero remains distinct
from unknown. Actual capture-UID readability on production hosts still needs
the later operator preflight.

Operations requires optional reader.json `operationsEnabled: true`, absent by
default for legacy configurations. Install the compatible reader before rendering
that new key. The existing N service identity keeps its four status source IDs.
The registry opts in with `mission_control_operations_read: true` and exactly
the kinds agent_status, job_finished and report. The local helper gets two
additive read rows for job_finished and report, using the same N UID, host,
profile, project chaldea, audience akasha and resource mission-control-reader.
The helper matches kind locally; the existing signed JWT grants a resource and
action, not a cryptographically bound kind. No new JWT claim, signing key or
issuer ceiling is needed. Status-only registry configurations remain accepted.

The only additional query is GET /api/v1/events with exactly
`mission_control_operations=job_finished|report&window=48h&limit=16`.
No cursor, extra filter, other window, repeated parameter or different limit is
accepted. SQL binds complete source ID, issuer, profile, project, host, source
and kind tuples for the four registered fleet-timers sources in chaldea and
agent-a-daily-health in homelab. Each pair has its own 16-row limit, so the fleet
page has at most 64 rows and reports truncation if any pair has more.
Projection happens at the server before response/cache: no title, body,
invocation ID, run ID or arbitrary envelope is returned.

The existing reader loop starts operations about every 60 seconds independently
of its status path. A missing helper grant fails closed for operations while
status continues. Errors retain original row timestamps and last-good data,
with the latest check time and error state. The private cache remains 512 KiB
and the public DTO 128 KiB. Operations rows yield before admitted base identity
and resource data. Public report checks are capped at 16 with an omitted count;
all original bounded checks are validated before projection.

Fleet rows describe only changed or failed chaldea-fleet-pull and
chaldea-retention timer runs. Quiet success emits no event. An empty 48-hour
window means no observed changed or failed timer runs, without asserting health
or exec-job activity. No daily-health producer is added here; an absent report
remains an observed delivery gap.

## HTTP and activation gates

The trusted configured HTTPS site origin controls Host/Origin checks, never
forwarded headers. Cross-site Fetch Metadata, Cf-Ray, duplicate/mismatched Host,
upgrades and non-GET requests are rejected. The server retains eight SSE clients,
24 connections, 128 KiB browser snapshots, same-origin assets/connect policy,
no CORS and CSP frame-ancestors none. Embedding remains disabled. SSE heartbeats
age the sampled source rather than renewing it.

GET /healthz is liveness. GET /readyz reports source freshness separately.
Cached stale values remain visible during source or Akasha outages.

Before activation, root qualifies the exact reviewed runtime artifact under the
hosting Node version, dedicated reader UID/helper custody and exact grants,
matching canonical registry, source-local read-only credential, private/cache
permissions, broker traffic/headroom and delivery latency. The existing broker
14-day/1 GiB policy is unchanged. At the maximum 8 KiB/30-second payload rate,
one source is roughly 22.5 MiB/day or 315 MiB over 14 days before envelope
overhead. Measure the actual rate and reserve before enabling it.

Actual canary acceptance needs an existing non-PC thread and a later observed
state/activity change, with honest provenance, age and coverage. Do not start
inference to manufacture evidence. Source fixtures prove PC independence and
offline behavior; they are not live deployment or token-semantics proof.
LAN-only ingress, peer restrictions, rollback and second-pass idempotence belong
to the separately reviewed infrastructure packet.
