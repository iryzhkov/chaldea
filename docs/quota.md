# Quota observation and provider switching

T3 owns usage collection, reset timing, native restart recovery and automatic resume.
Fleet configuration sets `autoResumeLimitedThreads=true`. Restart T3 through its native
service lifecycle. Chaldea never reads the archived recovery journal.

`chaldea quota observe` follows the native T3 provider and shell streams. Included
usage windows come only from native usage limits. `chaldea quota status --json`
reports their source, `checkedAt`, observation age and freshness. Missing data stays
unknown; observations older than 15 minutes are stale. A credential change clears
cached windows. Account sharing requires an explicit account binding, never an
instance-name guess.

The optional Codex app-server read supplies only aggregate paid-wallet balance and
spend-control fields absent from native usage limits. It never supplies included
windows, plan or reset inventory. Credential contexts must match the local T3
instance. No collector refreshes credentials or redeems credits.

The provider switcher remains opt-in through `--enable-provider-switch` and its
existing switch configuration. Its durable intents and guarded continuation behavior
are unchanged. Capacity policy and FATE role and quality policy still apply.

Installed observer flags `--t3-base-dir`, `--token-file`, `--state-file`,
`--feed-command` and `--quota-config` remain supported. Retired restart configuration,
Claude collector settings and manual weekly estimates are accepted and ignored.
Legacy MCP registrations may still pass `chaldea mcp --config PATH`; the path is
ignored and tools/list returns only `chaldea_route` and `chaldea_route_review_pair`.

Run typecheck, unit tests and E2E tests in Chaldea with a scratch HOME. CI runs
official 0.1.9 and a packaged 0.1.6 compatibility lane.
