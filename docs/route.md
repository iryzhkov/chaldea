# Native delegation routing

Call `chaldea route --role builder` or MCP `chaldea_route` before T3's
`delegate_task`. Pass the returned `providerInstanceId`, `model` and `options`
as the delegate target, then launch through T3. Children stay in their parent
thread. Chaldea recommends only.

```json
{"role":"critical-review","authorProvider":"codex"}
```

Input roles are `builder`, `critical-review`, `bulk-read` and `general`.
`authorProvider` forces a review onto the other driver. `effortOverride` accepts
only `low`, `medium`, `high` and `xhigh`. CLI equivalents are `--role`,
`--author-provider` and `--effort`. Max and higher efforts are rejected.

Fallbacks when no AA snapshot exists:

| Role | Claude | Codex | Default effort |
| --- | --- | --- | --- |
| builder | Opus 5.5 | Sol 6.1 | high |
| critical-review | Fable 5.1 | Astra | medium |
| bulk-read | Haiku 5.5 | Luna 6 | medium |
| general | Opus 5.5 | Sol 6.1 | medium |

The router uses the cached T3 `server.getConfig` model/option descriptors that
back `orchestrator_capabilities`. It preserves instance IDs, requires an
enabled, installed, authenticated provider and checks exact model and option
IDs. All live drivers can participate once their exact model and effort have a
reviewed AA mapping and probation evidence. Sonnet-family models are banned by
default, including custom IDs containing Sonnet. Haiku is allowed. Models without
the requested effort option are held. With no eligible candidate it returns an error, including for a review
whose required other provider is unavailable.

Results include `alternatives`, human-readable `reasons` and `dataAges`.
`byProvider` is keyed by catalog driver, such as `claudeAgent` or `codex`, and
returns each provider's best eligible `{providerInstanceId, model, options, eligible, reasons}`
under the same quota, review, pin and probation gates. A provider with no eligible
model remains present with `eligible: false`, null model/options and its rejection
reasons. Provider picks also consume probation recommendation shares. The overall
winner and alternatives remain available; no eligible model overall still returns an error.
Ages are seconds, or null for unknown/future timestamps. Fresh Codex credits classify as unlimited even with no native window; credits
near expiry classify as use-it. Identified results also include accountKey.
See [fleet quota accounts](quota-fleet.md) for account binding and shared snapshots.

## Capacity and preference

`chaldea quota status --json` includes a `capacity` object keyed by provider
and account hash when identified, or by instance ID for legacy local records. Human status prints the class, reasons and burn target. Both use
the pure classifier in `src/quota/capacity.ts`. Routing consumes the same
classifier, supplementing observer windows with opt-in Claude usage or the
operator weekly estimate.

Classes are `use-it`, `unlimited`, `paced`, `tight`, `stopped` and `unknown`.
Routing prefers use-it, then under-paced Claude, then unlimited, then paced or
unknown. Tight and stopped are excluded. Thus Claude weekly capacity is used
while under-paced, and positive Codex credits are used without a credit reserve
floor otherwise. With no pacing or known capacity preference, the role objective
decides. Without AA, unknown falls back to the role's Claude default. A review's provider
constraint always applies. The base pacing rule prefers Claude when remaining
fraction minus fraction of native window time left is at least 0.10; otherwise
it prefers Codex. Missing/stale pacing keeps the role default unless capacity
preference or usable Slopalytics statistics decide the comparison.

Only the weekly window, or the longest included window when there is no weekly
window, determines pacing and native quota projections. A session/5-hour window
never creates use-it capacity because its reset is close. Its only effect is a
temporary gate: under `minimumRemaining` left, default strictly under 10%, is tight;
zero left is stopped. These gates override advisory credits and reserves until the
short reset; they do not gate the proven credit-funded lane described below. An
active usage stop is always stopped. A short window alone leaves pacing
unknown. Reasons show both windows, for example "weekly 62% left with 40% of
window left: under-paced; 5h window 35% left".

The observer keeps up to 288 previous window observations per provider, sampled
at least five minutes apart and retained for 48 hours, with a 16 KiB per-provider
history budget. Burn uses the most recent
24 hours, requires at least five minutes of comparable observations, and stops
at a reset or refill. The heavy projection is observed fractional quota burn
per hour times the configured multiplier times hours until native reset.
Burn target is `max(0, remaining - 0.05) / hours to reset`. Missing or zero burn cannot
establish unlimited capacity from native quota or reset/refill inventories. Fresh
positive Codex credits establish unlimited independently of burn. Claude
collector/operator windows do not yet retain burn samples in observer state,
so their refill timing stays unknown unless
comparable observer samples exist.

A Codex reset would restart full quota with a new one-week deadline, but its
advisory value is only the time from projected exhaustion to the original native
reset, capped at one week. It has no value when that lead is below the configured
minimum of 72 hours. A reset that expires at or before projected redemption adds
nothing. If a still-useful reset expires soon, the class is use-it.

Each subsequent reserve is considered at the next projected exhaustion of a
full quota allowance. Only the fresh available count is used when T3 omits an
expiry; a known expired earliest expiry invalidates that inventory. A Claude
refill retains the native deadline and is also valued only from projected
redemption to that deadline, without the Codex minimum lead. Claude refill count
defaults to zero. Missing or zero burn means no projected exhaustion, so reset
and refill inventories add no timed value.

Fresh, positive, unexpired Codex credits count as unlimited with no reserve
floor or required creditsPerFullWeek conversion. Credits nearing expiry count
as use-it. Zero, stale and expired balances do not add capacity. Weekly quota
exhaustion alone does not override credits. Missing credit and native-window data
remains unknown. An active usage stop always remains stopped.

Credits are a separate, credit-funded lane (Igor's policy, 2026-10-19). When the
observer holds fresh, positive, unexpired, account-bound Codex credits and a fresh
`spendControlReached: false`, the class is unlimited (use-it near expiry) with
`creditFunded: true`, even if included quota is exhausted, short included windows
are gated, or the provider reports that ordinary included usage is not allowed.
Routing then ranks it like any unlimited provider: ahead of paced Claude, behind
use-it capacity and under-paced Claude. Review separation, bans, pins, quality
floors and catalog effort checks still apply. Without that proof, the included
lane decides: a fresh ordinary-usage denial is tight, short gates exclude the
account, and a fresh `spendControlReached: true` means credits add no capacity.
Unknown, stale or errored spend control, and credits from fleet snapshots (which
do not carry spend control), never establish the credit-funded lane. This is a
recommendation input only; automatic provider switching still admits only the
included lane.

Chaldea never spends credits, purchases capacity, redeems resets, refreshes
credentials, or calls any purchase, reset-redemption or refresh method.
A stopped provider remains stopped even with reserves.

## Configuration

Pacing and minimum-remaining thresholds default to capacity.json for both status
and routing. Explicit route.json overrides apply to both the pacing and capacity
calculation within routing; status continues to use capacity.json.

Routing configuration is `~/.config/chaldea/route.json`, optional and separate
from the observer's `quota.json`. Use `--config PATH` for CLI or
`CHALDEA_ROUTE_CONFIG` for MCP. Defaults:

```json
{
  "paceMargin": 0.10,
  "minimumRemaining": 0.10,
  "failureMargin": 0.10,
  "minimumTurns": 100,
  "quotaMaxAgeMs": 900000,
  "analyticsMaxAgeMs": 1814400000,
  "claudeUsage": { "enabled": false, "providerInstanceId": "claudeAgent" }
}
```

Optional absolute paths are `stateFile`, `cacheDir`, `t3BaseDir`, `tokenFile`, `quotaConfigFile`,
`capacityConfigFile` and `claudeUsage.credentialFile`. Defaults use the normal
Chaldea observer state, local T3, the shared observer token at
`~/.config/chaldea/t3-token`, and `~/.cache/chaldea/route/`. That token may include
`orchestration:operate` for the observer; routing only calls `server.getConfig`.
For least privilege, configure `tokenFile` to a dedicated token with only
`orchestration:read`, as the e2e fixture does. Routing runs inside the stdio MCP
process, which reads this token and owns its collection caches. Capacity configuration defaults to
`~/.config/chaldea/capacity.json`; quota status accepts `--capacity-config PATH`.

```json
{
  "heavyMultiplier": 2,
  "minimumResetLeadHours": 72,
  "recentWindowMs": 86400000,
  "maxAgeMs": 900000,
  "paceMargin": 0.10,
  "minimumRemaining": 0.10,
  "reserveFraction": 0.05,
  "expiryHorizonMs": 86400000,
  "providers": {
    "codex": {
      "creditExpiresAt": "2026-11-01T00:00:00Z"
    },
    "claudeAgent": {
      "claudeRefills": { "count": 0, "expiresAt": "2026-11-01T00:00:00Z" }
    }
  }
}
```

`creditsPerFullWeek` is accepted for existing configurations but is not required
or used to classify Codex credits. Refill and credit expiry settings are operator
assertions, never an automatic source of Claude reserves.

When Claude collection is off or unavailable, optionally set
`claudeWeeklyTarget` in route.json:

```json
{
  "claudeWeeklyTarget": {
    "observedAt": "2026-10-17T12:00:00Z",
    "remainingPercent": 62,
    "resetsAt": "2026-10-20T07:12:00Z"
  }
}
```

This estimate lasts until the stated reset, at most seven days after observation.
Its real age appears in the output. Without it, Claude pacing stays unknown.

## Optional Claude collector

T3 0.1.0 marks Claude windows unsupported. Opt in with
`claudeUsage.enabled: true` on the host whose local Claude credential belongs
to the configured instance. Select exactly one token source: `credentialFile`
defaults to `~/.claude/.credentials.json`; or set `envFile` plus optional
`envVar`, defaulting to `~/.config/claude/oauth.env` and
`CLAUDE_CODE_OAUTH_TOKEN`. Paths in configuration must be absolute. For example:

```json
{
  "claudeUsage": {
    "enabled": true,
    "providerInstanceId": "claudeAgent",
    "envFile": "/home/igor/.config/claude/oauth.env",
    "envVar": "CLAUDE_CODE_OAUTH_TOKEN"
  }
}
```

The same source fields are accepted on quota.json `claudeContexts`. JSON and
env-file sources are mutually exclusive; there is no implicit fallback to another
login. The env reader requires an owner-owned regular 0600 file, bounded at 64 KiB,
with exactly one assignment to the selected variable. Bare, single-quoted and
double-quoted values and optional `export` are accepted. It extracts that value
only, ignores other variables, performs no shell expansion and never populates
the process environment. Tokens containing expansion syntax or unmatched quotes
are rejected. Cache keys include the source path and selected variable.

The collector reads the selected source read-only and sends one GET to
`https://api.anthropic.com/api/oauth/usage`, the endpoint used by Claude usage
monitoring. This is an undocumented OAuth endpoint; authentication or schema
changes degrade to cached data or the operator target.

The reader accepts only a regular, bounded file, refuses symlinks and expired
tokens, and never refreshes or writes credentials. Requests use the OAuth bearer
and `anthropic-beta: oauth-2025-04-20`, a fixed HTTPS origin, no redirects, a
five-second timeout and a 64 KiB response cap. Failure text is sanitized.
Only 5-hour and 7-day utilization/deadlines and a hashed account identity are
cached, with mode 0600. A GET of the OAuth profile endpoint supplies identity
when the usage response omits it.
A persistent reservation plus cross-process lock limits attempts, including
failures, to once per five minutes. HTTP 429 records `rate_limited` and honors
`Retry-After` seconds or HTTP date, with the five-minute minimum cadence still
applying. Without a valid header, consecutive 429s back off for 5, 10, 20, 40
then 60 minutes, capped at an hour; success resets the backoff. JSON expiry at
zero or in the past records `credential_expired` without an HTTP request.
A 401 records `unauthorized`. Other credential failures record
`credential_unavailable`; other collection failures use `collection_failed`.
The mode-0600 cache records `attemptedAt`, `failureReason`, `failureCount` and
`retryAt`, keeping the last good value and original `fetchedAt`. Route reasons
show the failure and cached age; quota status retains the sanitized diagnostic
on the included metric for the board. No raw response/error or credential field
is persisted. Collector off means no credential read.
An old lock can be cleared after its cadence; lock contention skips collection.

## Slopalytics

The router fetches [the T3 usage dataset](https://slopalytics.com/data/t3-usage.json)
at most once per day, including failures, retaining last successful aggregate
data and `fetchedAt`. It aggregates exact model names and matching native
harness rows over `start` through `endExclusive`: completion, failed and
interrupted rates use terminal turns; minutes per turn uses timed turns.
The name-to-T3 mapping lives in one table. Older model generations stay separate.

With at least 100 terminal turns for both peers, a failure plus interrupt rate
more than 10 points above its role peer excludes that candidate. Otherwise
statistics break a tie by completion rate, then minutes per timed turn.
Statistics never override the provider constraint, quota pacing or capacity ordering.
With AA, they gate new candidates against the current pick and break objective ties.
The aggregate describes model behaviour that changes slowly and is published
irregularly. Its window end, `endExclusive`, must be less than 21 days old by
default, configurable through `analyticsMaxAgeMs` in route.json. Retrieval and
publisher timestamps must be valid and not in the future; they do not restart
the window's age. A recently downloaded report with an older window remains
stale. Missing, unreachable or stale data keeps quota policy and role defaults,
with a reason.

Routing never changes observer state. It retains its own probation counters,
first-seen timestamps, settled incumbents and transition outbox in
`~/.local/state/chaldea/route.sqlite`. A transaction reserves each recommendation
before returning it. CLI and MCP processes share the counters.

## Role targets and AA calibration

AA's [API reference](https://artificialanalysis.ai/data-api/docs/reference) supplies
`artificial_analysis_intelligence_index`, `artificial_analysis_coding_index`,
`price_1m_input_tokens` and `price_1m_output_tokens`. Prices are USD per million
tokens. The fetcher uses the reference's "Get language models (Free tier)"
contract, checked 2026-10-18: `GET /api/v2/language/models/free?page=N`, with the
key in `x-api-key`. This endpoint accepts Free, Pro and Commercial keys. Its
required top-level fields are `tier`, numeric `intelligence_index_version`,
`pagination` and `data`. Pagination contains 1-based `page`, `page_size`,
`total_pages` and boolean `has_more`. The reference's response example uses
version 4.1 and two pages of 200 rows. The collector follows at most eight pages
and requires a consistent index version. It intentionally does not guess the
shape of the older `/api/v2/data/llms/models` endpoint. Incomplete mapped rows
are reported with unmapped rows and held; other complete rows still publish.
A fixture follows the documented public shape, with fake model values and no key.
The real-key activation check is Igor's runbook step 5, before enabling the timer.

Bulk-read compares a 3:1 uncached input/output blend,
`(3 * inputPrice + outputPrice) / 4`. This avoids requiring a paid API tier or
assuming a cache hit rate. Builder maximizes Coding Index. Critical review
maximizes intelligence on a driver different from the author. General maximizes
`(intelligence + coding) / 2 - 2 * blendedPrice`, an explicit quality/cost tradeoff.
Ties use Slopalytics completion rate, minutes per timed turn, driver preference,
then instance ID. Quota admission and pacing apply before these objectives.

The old Sheba floors were execute 50, review 50 and read 35. Those values cannot
be carried across index versions or reasoning efforts. On 2026-10-18, AA's
Intelligence Index v4.3.2 release tables report the following allowed variants:

| Role | Permitted anchor scores | Default floor |
| --- | --- | --- |
| builder, high | Opus 5.5 54; Sol 6.1 50 | 50 |
| critical-review, medium | Fable 5.1 49; Astra 50 | 49 |
| bulk-read, medium | Haiku 5.5 34; Luna 6 30 | 30 |
| general, medium | Opus 5.5 52; Sol 6.1 48 | 48 |

Each floor is the weaker anchor at the role's existing effort, rather than a
score from a prohibited max variant. Sources:
[Opus](https://artificialanalysis.ai/models/releases/claude-opus-5-5),
[Sol](https://artificialanalysis.ai/models/releases/gpt-6-1-sol),
[Fable](https://artificialanalysis.ai/models/releases/claude-fable-5-1),
[Astra](https://artificialanalysis.ai/models/releases/gpt-6-astra),
[Haiku](https://artificialanalysis.ai/models/releases/claude-haiku-5-5),
[Luna](https://artificialanalysis.ai/models/releases/gpt-6-luna).
The floors are configuration choices derived from these anchors, not AA
recommendations. No coding scores or current prices are invented or bundled as
production data. The daily API snapshot supplies them. Recalibrate floors when
AA changes the index scale.

`src/route/scores.ts` contains the one reviewed table of AA slugs, T3 IDs,
efforts, Slopalytics names and harnesses. No family, generation or max-to-medium
inference is permitted. A new release with an existing reviewed mapping
participates automatically when present in the live catalog. An unmapped
release appears in reasons and fetch diagnostics; adding its exact table row
requires review. Provider instances and allowed effort options always come from
the live catalog. A model not exposed by T3 cannot be selected.

## Probation, pins and stale data

New candidates must clear the role intelligence floor and have at least
`minimumTurns` terminal Slopalytics turns. The current pick must also have
that sample. Candidate failure plus interruption rate must be no more than
the current pick's rate plus `failureMargin`. Missing or stale Slopalytics
holds new candidates. The initial fixed pair bootstraps each role's incumbents.
A selected model becomes the settled incumbent after its probation interval.

During the first `probationMs` from first catalog observation, each new model
gets at most `probationShare` of the role's recommendations on that host.
Counters are separate for review author-driver contexts and explicit effort
overrides. Every prefix of N calls obeys
`trials <= floor(N * probationShare)`; the first trial at 10% is the tenth call.
Restarting CLI or MCP does not reset it. A held model does not become eligible
just by waiting seven days. The Slopalytics gate still applies.
If there is no settled candidate and the share is exhausted, routing refuses.

Example additions to route.json:

```json
{
  "bans": ["*sonnet*"],
  "pins": { "bulk-read": { "model": "gpt-6-luna", "providerInstanceId": "codex" } },
  "floors": { "builder": 50, "critical-review": 49, "bulk-read": 30, "general": 48 },
  "minimumTurns": 100,
  "failureMargin": 0.10,
  "probationMs": 604800000,
  "probationShare": 0.10,
  "scoreMaxAgeMs": 259200000,
  "announceHost": "omarchy-pc",
  "scores": {
    "enabled": true,
    "url": "https://AKASHA-HOST",
    "tokenHelper": "/ABSOLUTE/PATH/TO/TOKEN-HELPER",
    "host": "omarchy-pc"
  }
}
```

Fleet pins override bans, AA floors, probation and quota preference. They still
require an available catalog model and allowed effort, respect review separation,
and cannot bypass active stops or tight capacity admission. If the pin cannot
run, routing refuses instead of silently selecting another model. Fleet-config's
`chaldea_client_route_targets` overrides are opt-in until a compatible client
release is pinned; the AA key never belongs in inventory or route.json.

AA snapshots older than `scoreMaxAgeMs` remain usable as last good data, with age
and an explicit reason. A failed refresh retains the last good snapshot.
Future-dated or invalid snapshots never replace it. With no snapshot the fixed
pairs above apply, with Sonnet removed. Stale AA never relaxes quota checks.

## Snapshot transport and route-change events

Use Akasha. Its existing source-bound token helper and authenticated
`/api/v1/events` reads already carry quota snapshots. A `route` service source
fits the same boundary, so there is no new secret, file server or shared token.
The daily homelab publisher appends `route_score_snapshot` with only the public
scores, exact mapping, index version and `fetchedAt`. The server requires
source `route` and host `homelab` for these snapshots.

Router registrations have `route_scores_read: true`. This permits only verified
homelab `route_score_snapshot` records in the same profile and project; it does
not grant reads of route events, other kinds, other projects or all events.
The helper needs a source-bound `route/read` grant on each router host.
Readers search the last 90 days, paginate within a fixed bound, refresh at most
every 15 minutes, and
keep local last good data when reads fail. With `scores.enabled: false`, readers
use valid local last-good scores without running the helper, making requests or
writing cache reservations and backoff. Reasons report disabled transport; score
age and stale-snapshot reasons still use the original timestamps.

Exactly one host, `announceHost`, publishes `route_pick_changed`. Configure
`scores.host` to the actual host name everywhere; the grant binds it as well.
The default authority is omarchy-pc, whose route database must be persistent.
The event checkpoint and outbox intent share a transaction, with a monotonic
transition number and a persistent random database epoch. Account or instance
switches within the same model are silent. Before a delivery attempt, transient
model changes coalesce into at most one intent per role context. Once attempted,
the payload and key remain immutable until acknowledgment. The queue is bounded
at 128 intents and 2 MiB; capacity or write failures defer announcements with an
explicit reason and do not undo or fail the routing recommendation. A full queue
keeps the last recorded top pick until a later recommendation can record its
replacement. Intermediate unattempted changes during an outage are not separate
feed records. Rebuilding a
lost database cannot reuse its old publication keys. Delivery retries use the identical idempotency key
and payload until Akasha acknowledges a visible record. Other router hosts
reserve probation shares locally but do not announce duplicate fleet changes.

The top pick is the best eligible target after quota policy, before the
probation share draw. Its event explains any temporary recommendation share cap.
Sampling a probation model does not generate repeated pick-change events.
Initial selection produces one event; unchanged targets produce none.
Reviews use a separate top pick per author driver, since cross-provider
constraints produce different targets. Explicit effort overrides do not
announce or mutate the normal role's pick. An explicit override with no mapped
role anchors falls back to the fixed pair without claiming its AA floor is met.
Transitions queue on the authority even before transport is configured.
Transient publication failures
appear in reasons and remain queued for the next route invocation. The
mission-control board can consume the normal Akasha event stream.

## Homelab activation, operator steps only

This change installs nothing and creates no key. After the reviewed client and
Akasha server are released:

1. Stage the released client at `/opt/chaldea-route/client` and pinned Node 26 at
   `/opt/chaldea-route/node` on homelab. The example units in
   `packaging/systemd/chaldea-route-scores.{service,timer}` use those paths.
2. Register the homelab `route` source with `route_score_snapshot` append permission,
   and router `route` service registrations with `route_scores_read: true`.
   Give the announcement host `route_pick_changed` append permission too.
   Retain the existing profile/project boundary. Issue source-bound helper grants
   and signed trust ceilings for each host. Homelab needs its own enrolled issuer;
   if absent, Igor must supply that identity through the existing Ruler procedure.
   For the root fetch service, grant uid 0 exactly route/append/route_score_snapshot.
   The installed helper uses sudo to drop to chaldea-issuer and writes its access
   state; keep the example service ReadWritePaths aligned with that state directory.
   Do not give routers global-read permission or the AA key.
3. Create `/etc/chaldea-route/route.json`, root-owned 0600, with the transport
   object above using `host: "homelab"`, its installed helper path and real Akasha
   HTTPS URL. Set `cacheDir` to `/var/lib/chaldea-route/cache`.
4. Igor places the key interactively on homelab using this command. The key is
   read from the remote terminal without echo, never in shell history, argv or an
   environment variable. A Python bytearray is cleared after the write.

```sh
ssh -t homelab 'sudo python3 -c '\''import getpass, os, pathlib
d = pathlib.Path("/etc/chaldea-route")
d.mkdir(mode=0o700, parents=True, exist_ok=True)
os.chown(d, 0, 0)
os.chmod(d, 0o700)
key = bytearray(getpass.getpass("Artificial Analysis API key: "), "utf-8")
fd = os.open(str(d / "artificial-analysis-key"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
try:
    os.fchown(fd, 0, 0)
    os.write(fd, key)
finally:
    os.close(fd)
    key[:] = bytes(len(key))'\'''
```

   The command refuses an existing key file. For rotation, Igor first removes or
   archives that file securely on homelab; agents must not read or copy it.
5. Install the example service and timer as system units, run
   `sudo systemctl start chaldea-route-scores.service`, and inspect its journal
   for mapped/unmapped counts and `fetchedAt`. Compare the actual unrounded API
   anchor scores against the configured floors and confirm the index version is
   on the calibrated scale before activating routing. The public anchor tables
   round their displayed values; configure floors from the actual API values if
   rounding would exclude an intended anchor. The fetcher requires hostname
   homelab and a regular root-owned, single-link 0600 key file; it rejects
   symlinks and files larger than 4096 bytes. Requests use a fixed AA HTTPS
   origin, no redirects, five-second timeouts and bounded response/pagination.
   Failures use fixed sanitized messages.
6. Verify an authenticated snapshot read from each router host and a fixture
   route before enabling `sudo systemctl enable --now chaldea-route-scores.timer`.
   The daily timer is persistent. Failed publication retries at five-minute
   intervals up to its systemd start limit. An AA fetch failure reserves that
   UTC day; a restart can republish last-good data, with the next AA attempt on
   the following UTC day. The fetch cache limits AA attempts to once per UTC calendar day, so timer jitter
does not skip every other refresh.
   A fetched snapshot with a lost Akasha receipt is retried with the same key.
   Confirm exactly one visible pick-change event by routing twice on the
   announcement host. Never claim distribution from a source merge alone.

## Validation and fleet follow-ups

`chaldea route --role builder --fixture test/fixtures/route/builder.json`
runs only the pure policy against injected catalog, quota, analytics and clock.
It performs no collection or credential access. Unit tests include the
18-instance catalog, a hypothetical cheaper Haiku promotion, sample and failure-rate
holds, a persistent 10% probation share, forbidden models/efforts, review separation, stale AA and analytics data,
capacity scenarios including native resets in 1 hour, 3 days and 6 days,
reserve expiry before useful redemption, collector safety and rate bounds. E2E checks the CLI and
existing MCP server against disposable pinned T3 with fake providers.

This repository ships no Chaldea SKILL.md. Follow-ups belong in fleet-config:

- Render route.json, quota.json contexts per host/account, and capacity.json.
- Render `envFile: /home/igor/.config/claude/oauth.env` for omarchy-pc in both
  route `claudeUsage` and quota `claudeContexts`, after this client is available;
  keep laptop on its current JSON credential source. Enable only matching logins.
- Register quota sources and R7 helper grants on Akasha before enabling shared publishing.
  See [fleet activation requirements](quota-fleet.md#activation-follow-ups).
- Add "call chaldea_route before delegate_task, then delegate natively" to the
  distributed CLAUDE.md and Chaldea skill.
- Distribute a validated client release and verify hosts manually. This PR does
  not deploy or change any host configuration.
