# Route and quota contracts

CLI routing returns compact JSON by default. Native target fields remain at the
top level and under `target`, with the exact live catalog option IDs and values.
The projection includes up to two short reasons, stable reason codes, the selected
account binding, observation source and age, freshness, binding window and
`quality_source`. That source is `AA` only when the policy actually used a
validated score snapshot, otherwise `fixed_policy`. Fleet diagnostics distinguish
absent configuration, disabled collection, an empty result, a ready reader and an
unavailable reader, with the number of fresh shared accounts. No configuration is
activated by diagnostics.

Use `--explain` or `--legacy-full` for the full result, including rejection
reasons, alternatives and provider diagnostics. `--compact` explicitly selects
the default projection. CLI failures return one JSON error on stderr, without the
global usage banner. Exit codes are 2 for usage, 3 for configuration, 4 for catalog
availability, 5 for unavailable usage observations and 6 for no candidate.
An incomplete review pair returns JSON on stdout and exit code 7.

## Claude window identity

Native T3, direct usage collection, cache validation and observer fallback preserve
`five_hour`, `seven_day` and `seven_day_fable`. The existing snapshot version
and window `id` carry this distinction. The five-hour and general weekly windows
apply to all Claude models. The additional Fable weekly window applies to Fable
family model IDs, including namespaced aliases. Missing or invalid scoped evidence
remains unknown. It cannot establish use-it capacity or under-pacing.

Provider-wide capacity ignores model-specific weekly windows. Candidate routing
adds the applicable Fable constraint. Common weekly pacing remains account-wide.
Every applicable low remaining limit is checked even when another weekly window
determines pace. There is no new refill, extra-usage or redemption assumption.

## Fleet disagreement

Observations of the same provider and account are deduplicated, never added.
A newer observation replaces an older one. Equal observation times retain the
smallest remaining allowance for matching window IDs and reset epochs, with local
conflict diagnostics. Missing windows or conflicting reset epochs become unknown.
Credits and reset inventories that disagree become unknown. Host-name ordering
only chooses the display source, not utilization. Local active stops still gate
the account. Remote credits never establish local spend-control evidence.

## One-call review pair

`chaldea route review-pair --author-provider codex` recommends the adopted
Sol 6.1 high and Opus 5.5 medium pair. The main reviewer uses the other underlying
provider driver. Both picks come from one collected context and one history
transaction. Only returned recommendation slots consume their probation shares.

Optional `--main-role`, `--peer-role`, `--main-effort` and `--peer-effort`
apply the caller's role and effort requirements. Role pins remain binding. A pin
that prevents an independent pair produces `pin_conflict`, without changing
the pin. `--allow-quota-exception` permits two distinct models on one provider
only when fresh observations prove quota pressure on every runnable instance of
the other provider. An alternate still needs catalog, role, effort, ban, floor
and probation eligibility. Unknown quota, missing catalog entries and HTTP 429
alone never permit an exception. The result reports `complete`, `partial` or
`unavailable`; it never launches or schedules work.

ROOT can wire MCP methods to these exports:

- `route(value: unknown, options?: RouteOptions): Promise<RouteResult>` retains
  the full runtime result. `compactRoute(result: RouteResult)` projects it.
- `routeReviewPair(value: unknown, options?: RouteOptions): Promise<ReviewPairResult>`
  collects once and reserves selected slots once.
- `recommendReviewPair(input: ReviewPairInput, data: PolicyData, historyFor?: PairHistory)`
  is the pure fixture/policy entry point.
- `reviewPairInput(value: unknown): ReviewPairInput` validates the pair request.
- `collectRouteContext(options?: RouteOptions)` exposes the collected policy
  data, diagnostics and provenance for shared integration.

`ReviewPairInput` has required `authorProvider: "codex" | "claudeAgent"`,
optional `mainRole`, `peerRole`, `mainEffort`, `peerEffort`, and
`allowQuotaException`. `ReviewPairResult` contains `status`, `code`,
`main`, `peer`, `quotaException` and bounded `reasons`. Targets are nullable
and otherwise use native `providerInstanceId`, `model`, `options` and optional
`accountKey`. Full single-route diagnostics include per-instance/model quota
details and fleet readiness. Snapshot wire fields remain unchanged.
