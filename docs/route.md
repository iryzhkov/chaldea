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

| Role | Claude | Codex | Default effort |
| --- | --- | --- | --- |
| builder | Opus 5.5 | Sol 6.1 | high |
| critical-review | Fable 5.1 | Astra | medium |
| bulk-read | Sonnet 5.5 | Luna 6 | medium |
| general | Opus 5.5 | Sol 6.1 | medium |

The router uses the cached T3 `server.getConfig` model/option descriptors that
back `orchestrator_capabilities`. It preserves instance IDs, requires an
enabled, installed, authenticated provider and checks exact model and option
IDs. It never substitutes older models, Haiku, OpenCode or an unsupported
effort. With no eligible candidate it returns an error, including for a review
whose required other provider is unavailable.

Results include `alternatives`, human-readable `reasons` and `dataAges`.
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
Routing prefers use-it, then unlimited, then paced. Tight and stopped are
excluded. Unknown falls back to the role's Claude default. A review's provider
constraint always applies. The base pacing rule prefers Claude when remaining
fraction minus fraction of native window time left is at least 0.10; otherwise
it prefers Codex. Missing/stale pacing keeps the role default unless capacity
preference or usable Slopalytics statistics decide the comparison.

The observer keeps up to 288 previous window observations per provider, sampled
at least five minutes apart and retained for 48 hours, with a 16 KiB per-provider
history budget. Burn uses the most recent
24 hours, requires at least five minutes of comparable observations, and stops
at a reset or refill. The heavy projection is observed fractional quota burn
per hour times the configured multiplier times hours until native reset.
Burn target is `max(0, remaining - 0.05) / hours to reset`. Missing or zero burn cannot
establish unlimited capacity. Claude collector/operator windows do not yet retain
burn samples in observer state, so their refill timing stays unknown unless
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
as use-it. Zero, stale and expired balances do not add capacity. Short native
windows do not exclude a Codex account with usable credits; an active stop does.

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
  "analyticsMaxAgeMs": 259200000,
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
      "creditsPerFullWeek": 1000,
      "creditExpiresAt": "2026-11-01T00:00:00Z"
    },
    "claudeAgent": {
      "claudeRefills": { "count": 0, "expiresAt": "2026-11-01T00:00:00Z" }
    }
  }
}
```

The example conversion is illustrative, not a measured rate. Set it from
operator knowledge of the account. Refill and credit expiry settings are
operator assertions, never an automatic source of Claude reserves.

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
to the configured instance. The collector reads
`~/.claude/.credentials.json` read-only and sends one GET to
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
failures, to once per five minutes. Collector off means no credential read.
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
Statistics never override the provider constraint or capacity ordering.
Retrieval age, publisher timestamp and window end must all be less than three
days old by default. A recently downloaded old report is stale. Missing,
unreachable or stale data keeps quota policy and role defaults, with a reason.

Routing emits no per-call feed records and never changes observer state.
Existing observer feed cadence is unchanged.

## Validation and fleet follow-ups

`chaldea route --role builder --fixture test/fixtures/route/builder.json`
runs only the pure policy against injected catalog, quota, analytics and clock.
It performs no collection or credential access. Unit tests include the
18-instance catalog, forbidden models/efforts, review separation, stale data,
capacity scenarios including native resets in 1 hour, 3 days and 6 days,
reserve expiry before useful redemption, collector safety and rate bounds. E2E checks the CLI and
existing MCP server against disposable pinned T3 with fake providers.

This repository ships no Chaldea SKILL.md. Follow-ups belong in fleet-config:

- Render route.json, quota.json contexts per host/account, and capacity.json.
- Enable approved Claude collectors on any host with the matching login.
- Register quota sources and R7 helper grants on Akasha before enabling shared publishing.
  See [fleet activation requirements](quota-fleet.md#activation-follow-ups).
- Add "call chaldea_route before delegate_task, then delegate natively" to the
  distributed CLAUDE.md and Chaldea skill.
- Distribute a validated client release and verify hosts manually. This PR does
  not deploy or change any host configuration.
