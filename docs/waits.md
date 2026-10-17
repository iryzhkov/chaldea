# Durable waits and the decision inbox

This first slice adds time and same-host thread/run waits, a provider-independent
question store, and one shared SQLite wake/phone outbox. CLI and MCP use one local
user service through a mode-0600 Unix socket. There are no scans that post messages
and no recurring condition-polling loop. The answer page defaults to loopback.

## One wake, and the approved T3 0.1.0 deviation

Each resolved wait/question commits its outcome and one immutable wake command in
the same SQLite transaction. Command and message IDs are
`chaldea-wait:<id>:wake` or `chaldea-decision:<id>:wake`. Delivery uses
`message.dispatch`, `dispatchMode:{type:"queue_after_active"}`, empty attachments,
and short text:

```text
Chaldea wake (decision <id>): {"reason":"answered","answer":"Run","defaulted":false}
chaldea decision status <id>
```

Exactly one queued **user message** is the explicit deviation Igor approved on
2026-10-17, after disposable-server evidence disproved the brief's notification
path. A successful dispatch RPC confirms T3's durable receipt. A lost ACK or
watcher crash retries the identical stored payload and IDs. Sent rows are never
sent again. This promises one committed message, not one wire transmission or
exactly-once model execution. The only T3 delivery function is
`dispatchChaldeaWake` in `src/t3/adapter.ts`; qualify and change that seam when
native notifications become available, with a migration for existing payloads.

Evidence is pinned official T3 v0.1.0, commit
`81493efb71e8e8244f95d3e9f71d8369654ab151`:

- The [public message command contract](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/contracts/src/orchestrationV2.ts#L2947-L2985)
  accepts creation fields and an optional notification; it does not prove public
  intake preserves those fields. The vendored copy has the same lines.
- [WS intake, src/ws.ts:1856–1866](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/ws.ts#L1856-L1866)
  unconditionally applies `createdBy:"user"` before dispatch.
- [Orchestrator.ts:4774–4787](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/Orchestrator.ts#L4774-L4787)
  requires `createdBy:"agent"` for a notification. A fresh disposable command
  returned `OrchestrationV2DispatchCommandError`, detail:
  “Notifications must be server- or provider-created queued messages.”
- [Orchestrator.ts:11093–11120,11244–11256](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/Orchestrator.ts#L11093-L11120)
  replays durable receipts; the accepted command/events/receipt commit atomically.
  A previously-rejected durable receipt parks delivery as `blocked`/`delivery_rejected`;
  it is retained for operator attention and never silently assigned a new ID.

## Calls and identity

The session passes its own `orchestrator_capabilities.parentThreadId` explicitly.
This field names the calling thread, despite its name. The service validates the
configured local T3 environment, thread and project. It never infers identity from
cwd, provider session IDs, or parent lineage. Wrong environment fails closed;
deleted/archived/settled parents suppress undelivered wakes and become orphaned,
with an explicit disposition. Items are never rebound.

```sh
# Save a retry key before invoking; reuse both key and arguments after ambiguity.
request_id="$(date +%s%3N):$(uuidgen)"
chaldea wait time --after 30s --thread "$thread_id" --request-id "$request_id"
chaldea wait thread --target "$other_thread" --run "$run_id" --thread "$thread_id"
chaldea wait status "$wait_id"
chaldea wait cancel "$wait_id"

chaldea decision ask --thread "$thread_id" --question 'Run the dependent step?' \
  --option Defer --option Run --default Defer --default-safe \
  --default-action defer --deadline 2026-10-18T09:00:00-07:00
chaldea decision answer "$question_id" --answer Run
chaldea decision status "$question_id"
```

The call commits registration and returns immediately with `id`, `waitId` or
`questionId`, state and delivery status. A wait lets the session end its turn; a
question lets it continue unrelated work. The answer page and CLI/MCP share the
same transaction that arbitrates answer versus deadline. Answers after the
deadline apply the declared default even if the timer has not run yet.

A default must equal one option, be attested `defaultSafe:true`, and declare
`defaultAction:"skip"|"defer"`. That is the asker's safety assertion, not semantic
proof about arbitrary prose. Defaults must only skip/defer the dependent action:
they never grant consent, permissions, approval, or expand autonomy. Only record
an answer that Igor actually supplied. A notification tap does not answer.

MCP stdio: register `chaldea mcp --config /absolute/path/waits.json` with each
provider's MCP configuration. It exposes `chaldea_wait`,
`chaldea_wait_cancel`, `chaldea_wait_status`, `chaldea_decision_ask`,
`chaldea_decision_answer`, `chaldea_decision_status`. Tool schemas document explicit
identity, stable retry keys and safe-default rules. The MCP process holds no T3
token and does not own state; Unix socket access is the local-user trust boundary.

## Observation, restart and cancellation

Time inputs require RFC3339 with an offset. Relative CLI durations are calculated
from the request key's timestamp, so retries do not move the target. A single
Linux CLOCK_REALTIME timerfd, provided by the Python 3 stdlib/ctypes helper,
watches only the nearest deadline. It includes suspend time and wakes on a clock
change; the watcher then reconciles and rearms. It creates no systemd timer units
or per-wait process. Overdue deadlines resolve once on startup.

Thread waits pin an explicit run, or the latest accepted run at registration;
there is no “next future run” or generic idle predicate. Self-dependencies and
local dependency cycles are rejected. Full public thread snapshots plus live
subscriptions close the subscribe/read race. Cursors are journalled on observed
events; reconnect requests a fresh authoritative full snapshot rather than
reconstructing state from old raw events. Missing pinned history never means
success. Restart continuations, work lineage, native children, and pending
questions are considered. Quota failures remain pending; known T3 quota-resume
and Chaldea provider-switch message identities retain source-run linkage that
0.1.0 omits from its run schema. Definite failure/interruption resolves once.
Use native delegation completion and `watch_pull_request` for those workflows.

Connection failure uses capped reconnect backoff, delivery failure uses persisted
backoff, and credentials are reread on every connection/request. Protocol/schema
drift and environment mismatch stop delivery until service restart after repair.
The calendar helper retries transient failure with capped backoff. Wake and phone
delivery use separate concurrency slots, so a stalled relay cannot consume wake
capacity. No connection event sends a wake. Offline T3 delays receipt acceptance; provider
execution latency is separate from registration/condition-to-receipt latency.

Cancellation before resolution produces no wake. Once resolution has latched,
pending delivery may still be suppressed. A claimed send returns
`uncertain_in_flight`; accepted delivery returns `already_delivered`. Neither
claims to retract an accepted T3 message. An orphan or rejected delivery needs
operator attention; do not edit IDs to force a retry.

## Phone and answer page

Each question creates one phone outbox row with immutable
`{content,title,id,priority,url}`, ID
`chaldea-decision:<environment>:<questionId>`. The service POSTs `/notify`
with a bearer credential, marks sent only on HTTP 202, and retries the same bytes
after ambiguity. It never creates notification rows on reconnect, scans or
deadline. Unaccepted notifications stop after the question resolves, at its
deadline, or after 24 hours. An already-queued relay card may arrive later; its
tap shows current state. A slow/offline relay cannot block the deadline or wake.

This is one logical card identity, not a qualified exactly-once audible alert.
Existing relay ID replacement may re-alert; phone/relay ACK-loss, dismissal and
reboot qualification remain attended deployment work. Source:
OV `viking://resources/homelab/notify-relay.md`. This implementation does not
modify that relay or the phone.

The answer page uses HTTP Basic login `chaldea` and a private answer token as the
password (or bearer auth for API clients). It escapes all question/option text,
requires an HMAC form token, checks supplied Origin, disallows framing and
cross-origin resources, and carries no credential in a URL. Use a trusted LAN
HTTPS reverse proxy or mesh before exposure; listen/exposure is an explicit
deployment decision. Default bind is `127.0.0.1`, not LAN/WAN.

## Deployment provisioning (not performed by this change)

Install Node 26.10.0, Python 3 on Linux, dependencies with `npm ci`, and the reviewed
checkout at `~/.local/share/chaldea/app` (the existing quota-service convention).
Install/link the CLI separately. Create `~/.config/chaldea/waits.json`:

```json
{
  "environment": "THE_LOCAL_T3_ENVIRONMENT_ID",
  "t3BaseDir": "/home/igor/.t3",
  "tokenFile": "/home/igor/.config/chaldea/waits-t3-token",
  "database": "/home/igor/.local/state/chaldea/waits.sqlite",
  "socket": "/run/user/1000/chaldea-waits.sock",
  "listenAddress": "127.0.0.1",
  "port": 7385,
  "answerBaseUrl": "http://127.0.0.1:7385",
  "answerTokenFile": "/home/igor/.config/chaldea/waits-answer-token",
  "notifyUrl": "http://192.168.70.223:8399",
  "notifyEnvFile": "/home/igor/.config/homelab-notify/env",
  "logFile": "/home/igor/.local/state/chaldea/waits.log"
}
```

Omit `serverUrl` to rediscover T3's advertised local URL after restarts/port
changes. `environment` must be the actual local ID from T3 `server.getConfig`.
The deployment operator must provision:

1. An owner-owned mode-0600 T3 token file with only `orchestration:read` and
   `orchestration:operate`. Provision short-lived sessions and an owner-side
   renewal process that atomically replaces that file. No minting credential is
   given to agents/the watcher. Expiry/renewal failure fails closed; the watcher
   retains pending work and reconnects after replacement. Renewal automation is
   deployment work, not implemented here.
2. An owner-owned mode-0600 answer token file with a random password. Never put
   it in argv, the URL or logs. Arrange authenticated LAN/mesh HTTPS routing and
   set `answerBaseUrl` to the externally reachable origin only if exposure is
   approved. The default loopback URL is useful locally but not on the phone.
3. An owner-owned mode-0600 relay env file containing the literal assignment
   `NOTIFY_TOKEN=<credential>` (the existing homelab-notify format);
   `NOTIFY_RELAY_TOKEN` and an optional `export ` prefix are also accepted. The parser does not source shell code.
   omarchy-pc has no such file yet. Resolve the credential through the existing
   SOPS/notify deployment; this PR neither fetches nor copies a real secret.
   Missing relay config/credential leaves a bounded retrying phone row until
   resolution/expiry; it does not stop questions.
4. The local service unit and MCP registration in every desired provider.
   Precreate the state/cache/config directories with private permissions.
   Install `packaging/systemd/chaldea-waits.service` in the user's systemd
   directory, reload, and enable it when approved. If waits should run without
   an interactive login, user lingering must be provisioned by the operator.
   Do not restart or change the existing quota service.

The unit runs one watcher/outbox/store/page process; stdio MCP processes are
clients. The socket prevents a second service instance from opening the DB.
State survives watcher/T3 restart and host reboot. This PR installs/enables
nothing on any host: omarchy-pc, agent-a, agent-b and laptop are all undeployed.

## Bounds and retention

SQLite uses WAL and FULL synchronous transactions, with a 31 MiB main-file page
ceiling, cache spill disabled, and a truncate checkpoint before and after each
transaction. Disabling spill bounds each transaction to one WAL frame per dirty
page; the extra MiB leaves room for WAL frame headers under the shared 64 MiB cap.
A blocked checkpoint refuses another write until the reader releases it. New work
is rejected under disk pressure. No unresolved/ambiguous/blocked wake is pruned.

Defaults: 128 active waits (one per thread), 128 pending decisions, at most 10,000
terminal tombstones and 42 days; wake/phone payload 4 KiB, normalized registration
3 KiB, question 1 KiB, 2–8 options of 256 bytes. No raw T3 event is persisted.
Request keys use `<13-digit epoch milliseconds>:<unique key>`; new keys older
than 42 days or beyond the monotone pruning fence are rejected before insertion.
Known keys return the original item and reject payload changes. This permits
bounded tombstones without resurrecting old intent after pruning. Cleanup runs
on startup/transitions/next expiry; pending delivery is protected.

The private event-only log is capped at 10 MiB/14 days and 120 lines/minute; it
contains no tokens, questions, answers, transcript text or credential URLs.
There is no per-wait directory. These bounds sit within the plan's host-state
budget and do not depend on an agent model being available.

## Deliberate gaps and later slices

Native T3 pending-question tracking and auto-settlement hold/restore are omitted
from this six-day slice. All providers can use Chaldea's own inbox. A long wait
can be automatically settled by T3; this suppresses its undelivered wake just
like human settlement. Deploy with the per-thread auto-settle preference disabled
for long waits if desired; Chaldea does not change it or restore a human choice.

GitHub/URL/service/feed sources, cron, scheduled sessions, LAN webhook ingress,
cross-host waits/broker, fleet deployment, and phone receiver hardening remain
out of scope. PR watching remains native. A generic user continuation whose
source-run identity T3 does not retain cannot be guessed into a pinned cohort.

## Validation

```sh
export TMPDIR="$HOME/.cache/chaldea-scratch/step5-build"
export CHALDEA_TEST_SCRATCH="$TMPDIR"
npm run typecheck
CHALDEA_T3_BIN="$HOME/.t3/runtime/versions/0.1.0/t3" CHALDEA_REQUIRE_E2E=1 npm test
```

Unit tests cover transaction/retry-key invariants, multi-process answer/deadline
arbitration, cancellation, retention/fences/caps, quota/continuation/child
completion, lost wake ACKs, deleted parents and credential modes. E2E uses
`test/helpers/disposable-t3.ts`, fake Claude/Codex and a loopback relay, with
isolated HOME/base directories. It exercises one wake per time/target run/question,
already-true/cancel cases, CLI/MCP/page answers, default races, relay ACK loss,
watcher SIGKILL at registration/latch/pre-send/post-commit/delivered, and watcher
and T3 restarts. Each run prints registration-to-committed-wake latency; about
two seconds is the healthy-host target. CI's existing workflow runs all of these
on the self-hosted agent-a runner. The real T3 settings/port, quota service,
feed, relay and phone are never part of these tests.
