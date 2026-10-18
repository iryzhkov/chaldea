# Hosted Mission Control, one-source canary

This source path serves Mission Control on Normandy while agent-a captures its
own official T3 subscriptions. It does not need a running T3 server on the web
host or the PC. Existing local `mission-control serve` behavior remains available.

This is an opt-in source capability. Installation, grants and live activation
are separate gates. No configuration below grants itself access.

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
restart unchanged. New admissions are at least 30 seconds apart. A pending
attempt expires after 120 seconds as an explicit `status_expired_gap`, not a
delivery. A terminal server tombstone is also a status gap; ordinary collectors
retain their existing tombstone acknowledgement behavior. New input must itself
be at most 120 seconds old.

The canonical collector timer is 30 seconds plus up to five seconds jitter.
Long ordinary backlog runs may delay subsequent starts. This is sampled state,
with hosted source stale after 90 seconds and lost after ten minutes. Actual
selected-source delivery latency below 90 seconds remains a live qualification
gate. This change does not alter timers or add a faster transport.

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

Each refresh binds all pages to one fixed one-hour query. It reads at most four
128-event pages with a five-second deadline and a 2 MiB response cap. Redirects
are errors. A 410 cursor reset marks a gap and starts the same bounded query
without that cursor. Partial, oversized or malformed traversals retain the
previous good cache and mark a gap. Fetch time never replaces producer time.

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
observation arrives. Re-reading the same file or an older epoch cannot warm it. The reader owns the
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
