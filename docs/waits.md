# Durable waits and the decision inbox

This first slice adds time and same-host thread/run waits, a provider-independent
fallback question store, native T3 question policies, and one shared SQLite outbox. CLI and MCP use one local
user service through a mode-0600 Unix socket. There are no scans that post messages
and no recurring condition-polling loop. The answer page defaults to loopback.

## One wake, and the approved T3 0.1.0 deviation

Each resolved wait/fallback question commits its outcome and one immutable wake command in
the same SQLite transaction. Command and message IDs are
`chaldea-wait:<id>:wake` or `chaldea-decision:<id>:wake`. Delivery uses
`message.dispatch`, `dispatchMode:{type:"queue_after_active"}`, empty attachments,
and short text:

```text
Chaldea wake (decision <id>): {"reason":"answered","answer":"Run","defaulted":false,"source":"page"}
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

## Native questions first

Igor answers in the T3 thread. Register a deadline policy **before** using a
native question tool: Claude's `AskUserQuestion` pauses the turn, so registration
after asking cannot work. This implements section 4 of the step-5 brief,
Jocasta `3c642bfd5e2d1a09084990039a392f04@1`. Chaldea's separate page/store
remain a fallback for providers without native questions.

`chaldea_decision_prepare` commits immediately, watches the caller's existing
thread subscription, and binds the first new `user_input` runtime request
created within ten minutes (or before the deadline, if earlier). Existing
requests are excluded. One unbound preparation per thread is allowed; an
unbound policy expires without a message or phone card. After binding, the
deadline applies to that request alone, including every question in a
multi-question request. Reconnect takes a fresh authoritative snapshot. An
already-answered request observed after downtime closes its policy; it never
binds a later, unrelated question.

For async questions whose ID is already known, use `chaldea_decision_track`
with `runtimeRequestId`. The service verifies the request belongs to the caller's
thread and is `user_input`. Permissions and approval requests are never bound
or answered. Both APIs require the caller's own explicit thread ID and a saved
retry key; retries preserve the policy's original binding and deadline.

A human answer in T3 records `native_answered`, `source:"t3"`, and the runtime
request ID, with **no Chaldea wake**. T3 delivers that answer itself. At the
deadline Chaldea persists one immutable `runtime-request.respond` command,
`commandId:"chaldea-native:<questionId>:default"`, before sending. Each
free-text answer is exactly:

```text
No answer by the deadline: defer deploy the dependent action
```

The declared action is only `skip` or `defer`; there is no approval-valued
default. The pinned UI treats absent `allowCustomAnswer` as true; Chaldea uses
that same free-text path. For `allowCustomAnswer:false`, it selects only an
option whose entire label and optional wire value match the declared action
(case-insensitively). It never guesses from prose such as “skip checks and
approve”. If any question has no safe path, is missing, or cannot resume,
the policy becomes `needs_attention` and commits one marked queued wake with
a status pointer. It sends no automatic answer. Respond in T3 or defer the
dependent action; do not manufacture permission.

T3's pending-state check arbitrates the human/deadline race. An accepted
durable receipt records `native_default`, `defaulted:true`, `source:"chaldea"`.
A definitive rejection is reconciled against T3: a resolved request records
the native winner; an unresolved/unavailable request needs attention.
Ambiguous sends replay the identical stored command and receipt before
classifying a resolved request. Neither a confirmed default answer nor a
human answer creates a second Chaldea message.

Pinned T3 evidence (official v0.1.0, same commit as above):

- [Runtime request kind, status and response capabilities](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/contracts/src/orchestrationV2.ts#L1114-L1133),
  [question contract](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/contracts/src/orchestrationV2.ts#L1242-L1259),
  and [public respond command](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/packages/contracts/src/orchestrationV2.ts#L3077-L3090)
  distinguish user input from permission decisions and permit string answers.
- [Respond arbitration and message continuation](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/Orchestrator.ts#L7351-L7590)
  checks pending state before resolution; message-capable answers enqueue
  `async-answer:<runtimeRequestId>` atomically. The only native response
  delivery seam is `respondChaldeaDecision` in `src/t3/adapter.ts`.
- [Claude native tool callback](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts#L8191-L8250)
  is live; [Codex async question mapping](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts#L5027-L5055)
  is message-capable.

Watcher restarts preserve either capability. T3/provider restart can lose a
**live** callback; pinned T3 marks it unavailable rather than reconstructing the
provider's blocked turn. [Startup/shutdown recovery](https://github.com/pingdotgg/t3code/blob/81493efb71e8e8244f95d3e9f71d8369654ab151/apps/server/src/orchestration-v2/ProviderRuntimeRecoveryService.ts#L222-L244)
preserves message-capable requests and cancels other pending callbacks.
Chaldea reports one attention wake, never claims that
turn continued. Message-capable async questions survive T3 restart and receive
one native continuation. This is a pinned T3 limitation, not a second delivery
path for live questions.

## Calls and identity

The session passes its own `orchestrator_capabilities.parentThreadId` explicitly.
This field names the calling thread, despite its name. The service validates the
configured local T3 environment, thread and project. It never infers identity from
cwd, provider session IDs, or parent lineage. Wrong environment fails closed;
deleted/archived/explicitly-settled parents become orphaned with an explicit
disposition. Unattempted wakes are suppressed; a wake attempted before an
ambiguous response remains `uncertain`, including after restart, rather than
claiming it never reached T3. Uncertain wakes are retained for operator attention
and are not retried to inactive parents. Items are never rebound.

```sh
# Save a retry key before invoking; reuse both key and arguments after ambiguity.
request_id="$(date +%s%3N):$(uuidgen)"
chaldea wait time --after 30s --thread "$thread_id" --request-id "$request_id"
chaldea wait thread --target "$other_thread" --run "$run_id" --thread "$thread_id"
chaldea wait status "$wait_id"
chaldea wait cancel "$wait_id"

chaldea decision prepare --thread "$thread_id" --request-id "$request_id" \
  --dependent-action 'deploy the dependent action' --default-action defer \
  --deadline 2026-10-18T09:00:00-07:00
# Ask natively in T3 next. For an already-known async runtime request instead:
chaldea decision track --thread "$thread_id" --runtime-request "$runtime_request_id" \
  --request-id "$another_request_id" --dependent-action 'deploy the dependent action' \
  --default-action defer --deadline 2026-10-18T09:00:00-07:00

# Fallback for providers without native questions:
chaldea decision ask --thread "$thread_id" --question 'Run the dependent step?' \
  --option Defer --option Run --dependent-action 'run the dependent step' \
  --default-action defer --deadline 2026-10-18T09:00:00-07:00
chaldea decision answer "$question_id" --answer Run
chaldea decision status "$question_id"
```

The call commits registration and returns immediately with `id`, `waitId` or
`questionId`, state and delivery status. A wait lets the session end its turn; a
fallback question lets it continue unrelated work. Native blocking tools follow their
provider semantics; preparation returns before asking. The fallback page and CLI/MCP share the
same transaction that arbitrates answer versus deadline. Answers after the
deadline apply the declared default even if the timer has not run yet.

For the fallback inbox, the asker declares `dependentAction` and `defaultAction:"skip"|"defer"`; there
is no option-valued default or safety attestation. At the deadline the immutable
outcome is only `{reason:"deadline",defaulted:true,action:"skip"|"defer"}`, with
no answer text. The wake says “no answer by the deadline: skip/defer <dependent
action>”. Even options named “Approve deploy” cannot become a deadline approval.
Obsolete `default`/`defaultSafe` inputs are refused. Previously parked questions
also use this structural deadline outcome; their old option-valued default is
never selected. Defaults never grant consent, permissions or expanded autonomy.

For fallback questions Igor answers through the authenticated page (source `page`) or CLI (source
`cli`). MCP/agent IPC answers must name `answeringThreadId`, validated on this
host's T3, and cannot come from the asking thread. Another thread's answer is
recorded as `mcp:<thread>`, never as human consent. Answer outcomes and wakes
carry the source. The CLI uses a separate human IPC method; socket access and CLI
execution share the local-user trust boundary, rather than proving a human is
at the keyboard. Do not manufacture consent or pass agent choices off as Igor's.
A notification tap does not answer.

MCP stdio: register `chaldea mcp --config /absolute/path/waits.json` with each
provider's MCP configuration. It exposes `chaldea_wait`,
`chaldea_wait_cancel`, `chaldea_wait_status`, `chaldea_decision_prepare`,
`chaldea_decision_track`, `chaldea_decision_ask`,
`chaldea_decision_answer`, `chaldea_decision_status`. Tool schemas document explicit
identity, stable retry keys and safe-default rules. Native tool arguments are:

- `chaldea_decision_prepare({threadId,requestId,dependentAction,defaultAction,deadline})`
- `chaldea_decision_track({threadId,requestId,dependentAction,defaultAction,deadline,runtimeRequestId})`
- `chaldea_decision_status({id})` returns the native binding, preparation expiry,
  immutable resolution and delivery status. It also accepts fallback IDs.

All preparation/tracking arguments are required; `defaultAction` is `skip|defer`,
`deadline` is RFC3339 with an offset. `chaldea_decision_answer` only answers the
fallback inbox; native questions must be answered in T3. The MCP process holds no T3
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

Each fallback question, or newly bound native question, creates one phone outbox row with immutable
`{content,title,id,priority,url}`, ID
`chaldea-decision:<environment>:<questionId>`. The service POSTs `/notify`
with a bearer credential, marks sent only on HTTP 202, and retries the same bytes
after ambiguity. It never creates notification rows on reconnect, scans or
deadline. Unaccepted notifications stop after the question resolves, at its
deadline, or after 24 hours. An already-queued relay card may arrive later; its
tap shows current state. A slow/offline relay cannot block the deadline or wake.
If relay URL/env-file configuration is absent, the phone row becomes
`undeliverable` with disposition `relay_unprovisioned`, zero send attempts and
no retry timer. Provisioning later affects new questions; scans/restarts do not
re-notify old ones. A configured relay retains capped backoff and expiry.

Native cards link directly to the T3 HTTP thread route, `/<environment>/<threadId>`;
fallback cards link to `/decisions/<id>`. Set `threadBaseUrl` to the trusted,
phone-reachable T3 origin (HTTPS LAN/mesh routing is deployment work). Without
it the watcher uses the configured/discovered T3 origin, which may only be
reachable locally. Unbound preparations do not notify.

This is one logical card identity, not a qualified exactly-once audible alert.
Existing relay ID replacement may re-alert; phone/relay ACK-loss, dismissal and
reboot qualification remain attended deployment work. Source:
OV `viking://resources/homelab/notify-relay.md`. This implementation does not
modify that relay or the phone.

The answer page uses HTTP Basic login `chaldea` and a private answer token as the
password (or bearer auth for API clients). It escapes all question/option text,
requires an HMAC form token and either `Sec-Fetch-Site: same-origin` or an
Origin matching `answerBaseUrl`. `Origin: null` is accepted only with the
same-origin fetch signal, fixing browsers using the page\'s `no-referrer`
policy. Cross-site fetches are refused, including null origins. Origin and
form-token failures return specific messages and log only an event reason,
never headers, submitted data or secrets. The page disallows framing and
cross-origin resources, and carries no credential in a URL. Use a trusted LAN
HTTPS reverse proxy or HTTPS mesh endpoint **before any non-loopback bind**;
plain HTTP Basic credentials must never cross the LAN. Listen/exposure is an
explicit deployment decision. Default bind is `127.0.0.1`, not LAN/WAN.

## Deployment provisioning (not performed by this change)

Install Node 26.10.0, Python 3 and Linux `flock` (util-linux), dependencies with
`npm ci`, and the reviewed
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
  "threadBaseUrl": "https://YOUR_TRUSTED_T3_ORIGIN",
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
   Missing relay configuration creates one `undeliverable` phone row with a
   clear disposition and no retries. Configured relay/credential failures use
   bounded backoff until resolution/expiry; they do not stop questions.
4. The local service unit and MCP registration in every desired provider.
   Precreate the state/cache/config directories with private permissions.
   Install `packaging/systemd/chaldea-waits.service` in the user's systemd
   directory, reload, and enable it when approved. If waits should run without
   an interactive login, user lingering must be provisioned by the operator.
   Do not restart or change the existing quota service.

The unit runs one watcher/outbox/store/page process; stdio MCP processes are
clients. An exclusive OS owner lock is held on the database's inode, independent
of the socket path. A second service using the same database is refused before
it can reset in-flight delivery. Linux releases ownership on exit/SIGKILL; there
is no stale lease to reclaim and no lock-file deletion race.
State survives watcher/T3 restart and host reboot. This PR installs/enables
nothing on any host: omarchy-pc, agent-a, agent-b and laptop are all undeployed.

## Bounds and retention

SQLite uses WAL and FULL synchronous transactions, with a 31 MiB main-file page
ceiling, cache spill disabled, and a truncate checkpoint before and after each
transaction. Disabling spill bounds each transaction to one WAL frame per dirty
page; the extra MiB leaves room for WAL frame headers under the shared 64 MiB cap.
A blocked checkpoint refuses another write until the reader releases it. The
watcher logs once per blocked episode and retries with capped 250 ms–30 s backoff;
it keeps running while checkpoints block deadlines, delivery or startup maintenance.
Other fatal storage errors log once and exit non-zero so systemd's
`Restart=on-failure` restarts the service; registrations are refused before exit.
Confirmed receipts waiting to be journalled are retained in memory without
re-dispatch; a crash still replays the immutable command/receipt protocol.
New work is rejected under disk pressure. No unresolved/uncertain/blocked wake
is pruned.

Defaults: 128 active waits (one per thread), 128 pending native/fallback decisions combined, at most 10,000
terminal tombstones and 42 days; wake/phone payload 4 KiB, normalized registration
3 KiB, recent-request baseline 4 KiB, native request ID 2 KiB, dependent action
512 bytes, question 1 KiB, 2–8 options of 256 bytes. No raw T3 event is persisted.
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

Native preparation/tracking is implemented; Chaldea\'s own inbox remains a
provider fallback. Auto-settlement hold/restore is still omitted. A long wait
can be automatically settled by T3; computed auto-settlement does **not**
suppress its wake. Only explicit `settledOverride:"settled"`, archive or deletion
parks delivery. Chaldea does not hold/restore auto-settlement preferences.

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

Unit tests cover transaction/retry-key invariants, concurrent answer/deadline
arbitration, the approval-labelled-default reproduction, source/self-answer
checks, cancellation, retention/fences/caps, quota/continuation/child completion,
lost wake ACKs, archived-parent ambiguity, unconfigured/configured relay handling,
real SQLite readers blocking deadlines/receipt persistence, database-owner
exclusion/SIGKILL recovery, deleted parents and credential modes. E2E uses
`test/helpers/disposable-t3.ts`, fake Claude/Codex and a loopback relay, with
isolated HOME/base directories. It exercises one wake per time/target run/question,
already-true/cancel cases, CLI/MCP/page answers, default races, relay ACK loss,
watcher SIGKILL at registration/latch/pre-send/post-commit/delivered, and watcher
and T3 restarts. Native tests cover prepare-before-Claude-ask, human answers
without a wake, multi-question deadline text and turn continuation, permission
refusal, fixed-only needs-attention, native command ACK loss, every native
watcher crash boundary, Codex message-capable restart and unavailable live
Claude restart. Pinned adapters never emit `allowCustomAnswer:false`; the
fixed-only e2e seeds only the disposable T3 projection to exercise that public
contract state through real reads/commands. Page tests cover null-origin
same-origin POST acceptance and cross-site refusal. Each run prints registration-to-committed-wake latency; about
two seconds is the healthy-host target. CI's existing workflow runs all of these
on the self-hosted agent-a runner. The real T3 settings/port, quota service,
feed, relay and phone are never part of these tests.
