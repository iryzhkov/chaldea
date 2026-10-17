# T3 restart continuation

Investigated 2026-10-17 against the vendored contracts at T3
`81493efb71e8e8244f95d3e9f71d8369654ab151` and the official v0.1.0 executable.
The archive and executable checksums are verified by
`scripts/ci/install-t3`; see `vendor/t3-contracts/PROVENANCE.md`.

## What the pinned release actually does

The premise that v0.1.0 has only quota auto-resume is incorrect.
`settings.ts` declares `continueThreadsAfterServerUpdate`, default **true**,
separately from `autoResumeLimitedThreads`. `environment.ts` advertises
`threadRestartContinuation`. `orchestrationV2.ts` declares
`restartContinuationOfRunId` on runs and `message.dispatch`.

The disposable probe in `test/e2e/restart-investigation.e2e.test.ts` uses the
existing fake Claude provider, isolated HOME/base directory and loopback port.
It compares the native restart setting both off and on:

| Event | Old run after event | lastErrorClass | Public interruption evidence | Native continuation |
| --- | --- | --- | --- | --- |
| Server SIGTERM then start | cancelled | null | No error or interrupt item | Once when enabled |
| Server SIGKILL then start | cancelled | null | No error or interrupt item | Once when enabled |
| run.interrupt | interrupted | null | run_interrupt_request and run_interrupt_result | None |
| Stop behavior (run.interrupt with holdQueue) | interrupted | null | Same interrupt items | None |
| Fake quota rejection | failed | usage_limit | error failure code blocking_limit; resetAt null in this probe | Owned by native quota recovery |
| Fake provider exit 17 | failed | transport_error | error: Provider turn failed | None |

Server-stop cancellation has **no dedicated cause field on the public run**.
The run schema has status and completion time, but no stop reason or interruption
cause. `lastErrorClass` is a shell summary of a root error item, not a restart
marker. Do not treat every `cancelled` run as a crashed server's work.

Pinned source corroborates the experiment:

- [ProviderRuntimeRecoveryService.ts](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts):
  shutdown/startup recovery cancels nonterminal runs, attempts, provider turns,
  nodes and open items. Its detailed shutdown reason is used in internal
  effect cancellation and runtime-request expiry, not a run-level cause.
- [RestartContinuation.ts](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/RestartContinuation.ts):
  native recovery prepares durable outbox work before graceful shutdown and
  on startup, checks current state again, skips explicit interrupts and user
  questions, and caps consecutive native restart continuations at three.
- [OrchestratorMcpService.ts](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/mcp/OrchestratorMcpService.ts):
  `task_cancel` dispatches `thread.stop` on the child and stops its descendants;
  thread interruption uses the thread-management interrupt path. These are
  explicit stops, not evidence of server death. The disposable stop probe uses
  the public `run.interrupt` with `holdQueue`, as the stop-button contract allows.

**Unplanned Chaldea recovery is not implemented.** There is insufficient public
cause evidence to safely scan historical cancelled runs. The pinned release's
native recovery already covers server crashes/reboots when enabled. Its
project/server settings, strong provider session requirements and chain cap
still apply; Chaldea does not bypass those for unplanned restarts. If native
recovery is disabled, an unplanned interruption remains a documented gap.

## Planned restarts

Run `chaldea t3 restart`. Default service command:

```sh
systemctl --user restart t3code.service
```

Before running that command, Chaldea captures fresh projections of active turns
into `~/.local/state/chaldea/t3-restarts.sqlite` (SQLite WAL, synchronous FULL).
Each row retains thread ID, run ID, provider, model, immutable command bytes and
a hash of the local runtime file. The journal is scoped to the T3 base directory.
A read/capture failure prevents the restart. A restart-command failure returns
nonzero. Readiness requires a changed runtime identity and a synchronized
authenticated shell subscription, with filesystem notifications plus bounded
retries (90 seconds by default). T3's new advertised port is rediscovered.

After restart, both the command and the quota observer's synchronized reconnect
can recover those rows. An old runtime identity cannot trigger recovery.
Fresh projections exclude archived/deleted/settled threads, pending or
shutdown-expired user questions, explicit interrupts, failures including quota,
newer runs, and provider changes. Only the captured run's server-cancelled state
can receive a new continuation. Existing native/manual progress takes precedence.

The normal `message.dispatch` command starts a user turn containing:

> T3 restarted while this turn was running. Check the current state before repeating any action, then continue the task.

The message and command identities deliberately match pinned native recovery:
`message:restart-continuation:<run-id>` and
`command:restart-continuation:<run-id>`. Run IDs already encode the thread.
Thus native recovery and two Chaldea processes cannot create distinct
continuations of the same run. Native recovery may supply its own continuation
text first. A crash after acceptance replays the stored command identity;
projection readback confirms a message/run before recording success.
The restart-continuation link also invokes T3's serialized source-run and
Stop checks, preventing a stale continuation from superseding a newer run.

One `restart_resumed` record per continued planned run uses the existing
`chaldea-quota` feed poster and deterministic transition key. Scoped Akasha
delivery retries the same key and persists acknowledgement in the restart
journal. Legacy feed delivery retains its existing single-attempt behavior:
an atomic claim prevents concurrent invocations, and a crash after that claim
can lose the feed record. Feed failure never causes another task continuation.

The observer needs an `orchestration:read` + `orchestration:operate` token to
recover pending planned runs; a read-only token can still observe quota events
but cannot dispatch a pending continuation. No settings-write scope is needed.

## Configuration

Both commands accept `--restart-config PATH` with the same JSON configuration:

```json
{
  "enabled": true,
  "command": ["systemctl", "--user", "restart", "t3code.service"],
  "timeoutMs": 90000,
  "journalPath": "/home/USER/.local/state/chaldea/t3-restarts.sqlite"
}
```

`enabled` defaults on. Setting it false disables Chaldea capture/delivery and
discards pending Chaldea intents when recovery runs. It does not change T3's
independent native setting. `command` is an argv array, never a shell string;
it can target another service manager. `timeoutMs` must be 1–300 seconds.

Use `--t3-base-dir DIR`, `--token-file PATH`, and optionally
`--server-url URL` for a disposable instance. An explicit URL must remain valid
after restart; discovery is preferable. The base directory's runtime file is
required for identity checks. `--feed-command PATH` selects a legacy feed CLI.

Pass the same configuration to `chaldea quota observe` and `chaldea t3 restart`.
Leave the observer running independently of T3: it completes a planned restart
even when restarting T3 kills the requesting agent process. No service or fleet
configuration is changed by installing this feature.

## Verification

All executable investigation and tests run inside Chaldea jobs, downloading the
checksummed pinned executable there. They never use the live T3 service, port,
settings or database. Tests cover the real CLI's configurable restart command,
native recovery on/off, cancellation, quota, user input, archive, settlement,
completion, provider exit, opt-out, and process death after accepted dispatch.
