# Native delegation routing

CLI defaults to a bounded compact projection. Use `--explain` or `--legacy-full`
for the full result described below. The [route and quota contracts](quota-routing-contracts.md)
describe scoped Claude windows, typed errors and
the `review-pair` command and callable API.

Call `chaldea route --role builder` or MCP `chaldea_route` before T3's
`delegate_task`. Pass the returned `providerInstanceId`, `model` and `options`
as the delegate target, then launch through T3. Children stay in their parent
thread. Chaldea recommends only.

```json
{"role":"critical-review","authorProvider":"codex"}
```

Input roles are `builder`, `critical-review`, `bulk-read`, `general` and `executor`.
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
| executor | Opus 5.5 | Sol 6.1 | medium |

Use `chaldea route --role executor` for roadmap execution and other long-running
work with large, persistent contexts. This role prefers eligible Codex candidates
before quota pacing, including when Claude has unused quota near its reset.
Its separate intelligence floor defaults to the same 48 as general; legacy scoring uses the general objective. Pins still override
the preference, and availability, effort, quality, probation, reliability, quota
stops and review separation still gate eligibility. If no eligible Codex remains,
the usual policy ranks the remaining candidates. Bounded builders and reviewers
keep their existing roles. Routing recommends a target; it does not migrate an
existing thread or switch its provider.

The router uses the cached T3 `server.getConfig` model/option descriptors that
back `orchestrator_capabilities`. It preserves instance IDs, requires an
enabled, installed, authenticated provider and checks exact model and option
IDs. When server-side model preferences are present, their per-instance hidden
model IDs are excluded in every routing mode, including legacy mode and pins.
A hidden pin cannot route. If preferences are null, FATE has no server-side
hidden list to apply; unmigrated composer-local preferences are unavailable.
The generic quota-observer catalog stays unchanged. All live drivers can participate once their exact model and effort have a
reviewed AA mapping and probation evidence. Sonnet-family models are banned by
default, including custom IDs containing Sonnet. Haiku is allowed. Models without
the requested effort option are held. With no eligible candidate it returns an error, including for a review
whose required other provider is unavailable.

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

When Claude and Codex are both use-it, or (with no capacity evidence at all)
both under-paced (known pace at least 0.10), the larger expiring surplus goes
first regardless of driver. The surplus is pace: remaining fraction minus the
fraction of the window's time left. It is decided once per ranking, from each
driver's representative: the candidate the same-driver rules rank first, or the
cheapest benchmark representative under benchmark routing. The winning driver
then ranks first for every Claude/Codex pair in that tier, which keeps the
ordering consistent: adding a candidate of one driver never reorders the other
driver's candidates. The explain output then reads, for example,
`Quota pacing prefers codex: larger expiring weekly surplus (codex 0.86,
claudeAgent 0.27)`. If either pace is unknown, the rules above apply unchanged,
including the Claude default. The pacing reason line describes the final
ranking after probation-held models are withheld, so it never names a driver
without an eligible settled candidate. When only one primary driver remains (for
example a review, or a Claude model held by its probation share) it reads `Only
codex has an eligible primary candidate; quota pacing comparison does not
apply`. When both remain, the line names the comparison step that ordered the
top candidate of each primary driver in the final ranking: capacity class
(`Quota pacing did not decide; capacity class ranks codex first (codex use-it,
claudeAgent paced)`), expiring surplus, under-paced Claude, quota pacing,
role objective, Slopalytics completion rate (`Quota pacing did not decide;
Slopalytics completion rate ranks codex first (0.97 vs 0.95)`), Slopalytics speed
(`... speed ranks codex first (1.0 vs 8.0 minutes per turn)`), the Claude role default or instance
order. Legacy ranking computes its pacing preference before probation-held
models are withheld; when that differs from the settled candidates alone the
line reads `Quota pacing including probation-held candidates prefers <driver>`.
The line keeps its earlier position in the reasons. Executor's Codex preference, explicit
`providerPreference` ordering and the fallback-driver rule all run before this
comparison.

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
use-it capacity and under-paced Claude. Credits are drawn only after included
usage, so when the included lane is open (no short-window gate, ordinary usage
not denied) and its weekly window is under-paced (pace at least 0.10, not under
the minimum remaining), the credit-funded lane is classified use-it instead: the
included quota would otherwise expire unused at the native reset. It keeps
`creditFunded: true` and the credit-funded reason text, so short included
windows still do not gate it. An ahead-of-pace or exhausted included window
keeps it unlimited. Review separation, bans, pins, quality
floors and catalog effort checks still apply. Without that proof, the included
lane decides: a fresh ordinary-usage denial is tight, short gates exclude the
account, and a fresh `spendControlReached: true` means credits add no capacity.
Unknown, stale or errored spend control never establishes the credit-funded lane. This is a
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
  "analyticsMaxAgeMs": 1814400000
}
```

Optional absolute paths are `stateFile`, `cacheDir`, `t3BaseDir`, `tokenFile`, `quotaConfigFile`,
`capacityConfigFile`. Defaults use the normal
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

## Native usage

Included windows come only from T3. Missing or stale data stays unknown for routing;
no direct OAuth request or operator estimate supplies a fallback. Legacy collector
and weekly estimate config keys are accepted and ignored.

## Slopalytics

The router fetches [the T3 usage dataset](https://slopalytics.com/data/t3-usage.json)
at most once per day, including failures, retaining last successful aggregate
data and `fetchedAt`. Schema versions 2, 3 and 4 share the terminal/timing metrics
used here; additional v3 and v4 token, spend and sub-agent fields do not affect routing.
Schema 4 rounds each outcome count independently, so a row's completed, failed
and interrupted counts may sum to one more or one fewer than its terminal count,
but no single outcome may exceed terminal. Larger differences, an outcome above
terminal, and any difference in v2 or v3 reject the dataset. A failed collection
records one fixed category in the cache and the route reason: `fetch_failed`,
`oversized_response`, `unsupported_schema` or `invalid_metrics`. Raw errors,
upstream bodies and URLs are never recorded. It aggregates exact model names and matching native
harness rows over `start` through `endExclusive`: turn counts use terminal turns;
completion, failed and interrupted rates divide by the sum of those three outcomes;
minutes per turn uses timed turns.
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

## Benchmark selection within providers

Igor's policy, 2026-10-29, chooses the cheapest measured model and effort that
clears the role's intelligence floor within each provider. Quota admission and
provider pacing remain separate decisions; executor prefers eligible Codex even
when Claude quota would expire. Benchmark task cost is an efficiency comparison,
not a subscription bill or a prediction of the cost of the current task.

Opt in with `"benchmark": {"indexVersion": "4.3"}` in route.json after reviewing
the floor calibration for that exact upstream index. This mode requires a version
2 snapshot and refuses missing or mismatched data. It never falls back to fixed
pairs while claiming benchmark qualification. No floors are rounded or lowered.
An old, complete compatible snapshot stays usable with its real age and an
explicit stale-data reason. Quota observations retain their existing freshness
requirements.

A new benchmark scale can leave a role without a usable default baseline.
For example, the verified AA index 5 capture on 2026-10-29 has Luna medium 18.3,
below the unchanged reader floor 30, while Sol low 34.5 clears it. Explicit
operator calibration can add per-role baseline models with
`"benchmark": {"indexVersion": "5", "anchors": {"bulk-read":
["gpt-6.1-sol", "claude-opus-5-5"], "critical-review":
["gpt-6.1-sol", "claude-opus-5-5"]}}`.
These known models bootstrap those roles instead of waiting for a trial share
that cannot accumulate when every default is below the floor or hidden.
The measured role floor, required cost, catalog availability, bans, quota and
review separation still apply. Other models retain normal operational evidence
and probation. No calibration anchors are added automatically or in legacy mode.

### Antigravity and provider preference

Antigravity is eligible through its ACP `thought_level` option. All routed
drivers participate in capacity classification and account-mismatch exclusion.
T3 0.1.11 usage windows flow through the observer into routing with their
supplied durations and resets. `gemini-5h` and `gemini-weekly` apply only to
Gemini; `3p-5h` and `3p-weekly` apply only to Claude/GPT.
`gemini-argon-wtu-weekly` applies only to Argon. Provider-wide classification
excludes these scoped windows; candidate admission and pacing use only matching
windows. Unknown `gemini-*` or `3p-*` window IDs conservatively constrain that
family. Missing durations never establish pacing. Models outside the
Gemini/Claude/GPT families have no inferred family quota and use only common
windows. A parked Antigravity stop applies only to its alias/instance, including
all models on that instance: a third-party stop also blocks Gemini there. Stops
have no saved account identity or migration. Old stop identity metadata is
ignored. Claude/Codex retain main's stop handling.

Antigravity stores a hash of its verified credential context with the observation.
Every credential-context change, or a row without a saved context after upgrade,
holds that instance from routing with a clear reason until T3 supplies an
observation whose `checkedAt` is strictly newer than the change and attributed
to the current verified login fingerprint. Returning to a previous login
(A to B to A) also waits for a fresh observation; earlier snapshots are never
restored. Removing and re-adding an alias requires fresh admission too.
Restarting on the same admitted context preserves its snapshot, including
exhausted windows. At route time the live T3 fingerprint must match the saved
context, and routing uses the live snapshot windows, including exhausted limits.
Missing fingerprints, empty windows, unsupported or failed probes never admit
Antigravity or release a hold. The observer requires usable windows too.
Known exhausted windows remain binding for their model family until reset,
regardless of cache age, account-key availability, credits or reserves. Omitted
windows and failed probes preserve them. Only a strictly newer attributed
observation can replace a known limit with recovered capacity. Each retained
window keeps its own observation time, so updates to another family cannot
reset its recovery clock or make old replays supersede recovery. A later snapshot
that is still below the configured floor cannot shorten an older future limit,
even if its reset metadata changes or disappears. The retained
inventory preserves every known future-reset window in an Antigravity-only field.
These retained constraints never establish pacing; only live windows do. The
ordinary metric stays within the 32-window format accepted by main.
Credential strings are not stored.
Active stops and tight/stopped capacity still exclude the driver.
Without AA scores the fixed Claude/Codex pairs above stay unchanged.

**Known limitations.** An exhausted Gemini window observed only during routing
can be forgotten when a later same-fingerprint snapshot omits it. The observer
also loses retained exhaustion across a catalog gap where the Antigravity
instance disappears. Either case can permit routing before reset; both are
deferred to a follow-up.

`providerPreference` is an ordered array drawn from `antigravity`, `codex` and
`claudeAgent`; unknown driver names are rejected. For example
`["antigravity", "codex", "claudeAgent"]`. Listed drivers rank before unlisted
drivers, in that order, after eligibility checks. Explicit driver ordering takes
precedence over executor's Codex preference. Among equally ranked drivers,
executor still prefers Codex: `["antigravity"]` leaves both primaries tied and
keeps Codex first when Antigravity is absent or stopped. An empty or omitted list
preserves Claude/Codex quota and role ordering exactly, with Antigravity after both.
Unlisted drivers retain the default ordering. Pins, bans, floors, effort validation, probation, stops and
review separation still apply. Instance IDs never determine cross-driver priority.

Provider preference is pace-aware. A candidate's pace is its pacing window's
remaining fraction minus the fraction of that window's time left, the same value
the explain output prints as "on/ahead of pace" or "under-paced". While a
preference list is configured, a candidate whose known pace is below zero (it is
burning faster than linear) ranks after every candidate whose pace is unknown or
not below zero. Preference order still applies inside each of those two groups.
Unknown pace never demotes a provider. Under benchmark routing the pace groups
apply before price and driver grouping: a driver's ahead-of-pace and not-ahead
models rank as separate groups, so a cheap ahead-of-pace model never outranks a
not-ahead candidate and a not-ahead model is never pulled down by its driver's
ahead-of-pace model. When a demotion changes the order, the
reasons include a line such as `antigravity: preferred provider antigravity
demoted for pace: gemini-4-neon weekly pace -0.14 is ahead of linear; ranked
after providers whose pace is unknown or not ahead`. Each candidate's pace is
also reported as `pace` in its `diagnostics.quota` entry. For Antigravity the
pace comes from the model family's weekly window (for example `gemini-weekly`
for Gemini models). Antigravity capacity is classified per routed model from
the same family-scoped windows, so a Gemini model's capacity reflects
`gemini-weekly` and `gemini-5h`, while Claude/GPT models through Antigravity use
the `3p-*` windows (unknown while `3p-weekly` has no reset). The provider-wide
Antigravity capacity entry, which ignores family windows, remains for status
readers. Capacity never lifts Antigravity above an eligible primary driver: the
fallback-driver rule is applied before capacity rank.
`route review-pair` applies the same rule when it orders drivers for the main
and peer reviewers: a preferred driver whose pick is ahead of pace is tried after
the others, and the pair reasons name the demoted driver. Main reviewer
candidates are searched in two passes: every not-ahead candidate, in preference
order, is tried before any ahead-of-pace candidate, so backtracking through a
driver's models cannot pick an ahead-of-pace main while a complete pair with a
not-ahead main exists. Without a preference
list the default pacing policy is unchanged.

`roleProviderExclusions` maps a role to driver kinds that are never candidates
for that role, for example `{"bulk-read": ["antigravity"]}`. Keys must be route
roles and values unique routed driver kinds (at most 20); anything else is
rejected. The default is `{}`. An excluded driver gets a reason line and an
ineligible `byProvider` entry for that role, and stays eligible for every other
role. When nothing eligible remains, the `no_candidate` error names the
excluded drivers and the role. Exclusions also apply to pinned roles. `route review-pair` routes each slot
with its own role (`builder` unless `--main-role`/`--peer-role` say otherwise),
so an exclusion affects a review slot only when that slot's role is excluded.

The reviewed AA index 5 mappings cover Neon low/medium/high/xhigh, Hydrogen
low/medium/high, Argon medium/high and Flash low/medium/high. Neon's unsuffixed
AA slug means Xhigh; Argon's and Flash's mean High. Hydrogen's unsuffixed Xhigh
row is not mapped because that effort is absent from the T3 catalog. Neon remains
a calibrated baseline; other new models need operational evidence or explicit
benchmark anchors. Scores are keyed by model and effort, so Antigravity's Opus
uses the existing Opus rows. Operational evidence and baseline exemptions remain
scoped to the driver: native Opus is not automatically a calibrated Antigravity
baseline. An Antigravity driver allowlist can calibrate it; its exemptions apply
only to Antigravity accounting keys. Native benchmark anchors retain main's rules,
including configured anchors without a MODEL_MAP entry. Every route and review
call independently evaluates the catalog with Antigravity removed. All primary
history writes come only from that evaluation: first-seen, calls, trials,
returned review slots, rollback and the shared primary incumbent. They advance
exactly as a primary-only call would, even when the returned target is Antigravity.
The primary pick ledger and announcement budget are independent too; Antigravity
uses its own prefixed ledger and budget.
Settled Antigravity picks have a separate incumbent slot. Codex and Claude retain
main's shared incumbent slot; separating those primary slots is a follow-up,
outside this change. Claude/Codex first-seen times and trial allocations retain
main's plain model keys so mixed-version writers share the same counters. Only
Antigravity uses driver-prefixed keys. Antigravity probation alternatives appear
only when that driver/model is a reserved provider pick. Primary alternatives
stay visible and unreserved as on main. Only the selected primary model and
eligible driver picks spend primary trial budget; alternatives can therefore
exceed that share if a caller counts them as recommendations. This is pre-existing
main behavior, including with mixed-version writers, and is outside this change.
Primary call counting includes saved plain keys even while their models are
hidden. Primary first-seen, reservations and rollback follow main's path.
When the primary-only evaluation refuses or probes an unused slot, only
Antigravity first-seen entries may be layered over that unchanged primary history,
without spending trials. This lets a sole Antigravity
candidate age out of probation without persisting primary probe state.
For Claude-authored reviews, Antigravity excludes `claude-*` models; for
Codex-authored reviews it excludes `gpt-*` models, including allowlisted models.
Sonnet remains banned by default.

Benchmark coverage requires measured scores for every unbanned catalog model.
Orchestrators and gpt-oss have no usable AA rows. Recommended fleet configuration
to exclude those models and select Neon within Antigravity:

```json
{
  "benchmark": {"indexVersion": "5"},
  "providerPreference": ["antigravity", "codex", "claudeAgent"],
  "roleProviderExclusions": {"bulk-read": ["antigravity"]},
  "bans": [
    "*sonnet*", "gemini-pro-orchestrator-*", "gpt-oss-*",
    "gemini-4-hydrogen*", "gemini-4-argon*", "gemini-3.8-flash*"
  ]
}
```

Ban patterns match the whole model ID, case insensitively, with `*` matching
any characters. Dots are literal. The last three bans make Neon the Gemini pick;
Antigravity's Opus has shared measured scores but still needs driver-specific
calibration before selection.

`driverModels` optionally restricts drivers to operator-chosen models. Its
default is `{}`, with no implicit catalog restriction. For Antigravity, allowlisted
models count as calibrated baselines and the first becomes its incumbent; these
exemptions never affect native Claude/Codex probation. Explicit allowlists
restrict coverage and selection together.

Both route and review-pair inputs accept `authorProvider: "antigravity"`.
Review pairs try eligible different drivers for the main and peer, honoring
provider preference. Defaults preserve the Claude/Codex pair, then try
Antigravity. Selection tries another eligible main when the preferred main
prevents a valid independent peer. A missing provider or unknown quota never
authorizes a same-driver exception. Primary quota pressure retains main's rule:
every runnable instance must show fresh pressure, even a Haiku-only instance
that cannot supply the requested role anchor. For Antigravity, only targets
admissible apart from quota count as alternatives. Every routable model must
show pressure through fresh applicable windows or retained unexpired exhaustion. An incomplete Antigravity benchmark catalog or the
fixed-pair exclusion cannot block an otherwise valid primary quota exception.
A stopped Antigravity cannot authorize a primary waiver when the primary
counterpart is absent.

Version 2 adds `metric: "aa-intelligence-cost-per-task"` and
`benchmarkCostUSDPerTask` from AA's
`artificial_analysis_intelligence_index_cost.cost_per_task.total_cost`.
Coding and token prices may be null, and absent benchmark cost stays null,
distinct from a measured zero. This mode uses intelligence and task cost, so it
does not invent coding scores. Version 1 remains accepted by legacy routing.

Selection searches catalog-supported low, medium and high effort. Luna and
Haiku may also use xhigh. An explicit `--effort` remains exact. Max and higher
efforts never participate. The mapping includes Terra and exact additional
allowed variants of the native models; a max result never stands in for medium
or high. New models retain the existing operational evidence and probation gates.

`benchmarkCoverage` reports measured model coverage per runnable driver. It
excludes banned models and disabled instances. A model is covered when an
allowed, catalog-supported effort has measured intelligence and cost on the
configured scale. A provider missing any such model is held, rather than
advertised as fully compared. An exact effort request requires coverage at that
effort. A fully measured model below the role floor counts as covered but remains
ineligible. Per-provider recommendations use minimum cost, then intelligence,
then operational tie-breaks. Quota ranks the resulting provider choices.
After probation share admission, provider choices and quota ordering are
recomputed from the surviving candidates; a held trial cannot keep deciding
which provider wins. The separate topPick still describes the pre-draw choice.

Benchmark review pairs use the same cost/floor search and permitted effort
levels, instead of forcing legacy Opus medium. An explicit main/peer effort
remains exact. Automatic pair selection and trial-share reservation use the
same history context; returned effort does not silently change the request key.

The producer emits version 1 by default. Set `scores.formatVersion: 2` on the
existing homelab publisher only after consumers and the Akasha validator support
version 2. This source change does not enable score transport or modify grants.
Current AA API examples use index 5; that is not evidence that legacy 4.3 floors
are calibrated on index 5. A live rollout must verify actual index identity,
coverage, floor calibration and the existing protected publication/read path.

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
appear in reasons and remain queued for the next route invocation.

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

This repository ships no Chaldea SKILL.md; fleet guidance lives in fleet-config.