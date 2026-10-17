# Quota resilience (plan step 3)

When a provider stops a T3 turn on a usage limit, T3 itself resumes the thread
at the reported reset time. `chaldea quota observe` records stops and resumes
in the fleet feed. Optional B3 provider switching can continue the same thread
immediately on an available equivalent model using T3's context handoff.
Switching defaults to off; native recovery and its five-second sweep remain
the fallback. Chaldea uses one timer for pending hold cleanup and transient
switch-path retry backoff; continuation at reset remains native.

Decisions behind this design (Igor, 2026-10-16):

1. Resume is done by T3's native auto-resume (`autoResumeLimitedThreads` on).
2. With provider switching disabled, Chaldea observes quota events in the feed.
3. Without an eligible switch target, a hard limit with no reset stays parked
   and gets one warning. A later provider event supplying a reset lets T3
   resume it natively.

## Optional provider switching (B3)

Switching is **off by default**. After review, enable it with
`chaldea quota observe --enable-provider-switch`, or pass
`--switch-config ~/.config/chaldea/quota-switch.json`:

```json
{
  "enabled": true,
  "equivalences": [
    ["claude-opus-5-5", "gpt-6.1-sol"],
    ["claude-sonnet-5-5", "gpt-6-luna"],
    ["claude-fable-5-1", "gpt-6-astra"]
  ]
}
```

These pairs are the defaults when `equivalences` is omitted. An explicit list
replaces them and may contain at most 128 pairs, unique on each side. Only the
`claudeAgent` and `codex` instances participate, with their matching drivers.
The observer matches exact model slugs in the live `server.getConfig`
catalog. It carries an explicit Claude `effort` to Codex `reasoningEffort`,
and vice versa; the target's option descriptor must support that exact value.
It leaves the original recovery alone if the model or effort is unsupported.
Other source options are not transferred.

Admission uses only T3's `ServerProvider`: enabled, installed, ready,
authenticated, and not unavailable, with a known, nonempty `usageLimits.windows`
list, no `usageLimits.unavailable`, a valid `checkedAt` no more than five minutes
old (and not in the future), and every window's `usedPercent < 100`.
Missing/failed probes, an empty catalog, disabled/unhealthy instances and any
exhausted window mean no switch. Chaldea does not scrape providers, infer a
refill from elapsed resets, use account billing as quota, or open an agent
session to refresh a catalog. Native auto-resume remains the fallback.
A quota reset never moves a working thread. If a later run on the replacement
provider itself stops on quota, it is a new stop and may switch back when the
other provider has fresh quota.

The same policy applies to interactive, delegated and scheduled threads. A
failed usage-limit stop must still be blocking: its reset is in the future.
A resetless stop must be less than two minutes old and first seen live, or
completed after this observer process started. Old abandoned stops are never
admitted on startup or reconnect. A human's per-thread `autoResume:false`
choice wins over switching. Chaldea distinguishes its deterministic hold ID
and T3's exact `limit-arm:<thread>:<run>:<resetMs>` snooze-only arm from a human
cancellation. A native arm with `autoResume:false, snooze:true` does not opt out
of switching, and its false auto-resume choice is preserved on release. There
must be no active run, pending runtime request, archival, deletion or explicit
settlement. Switching
waits for shell catch-up before acting. When enabled (or when saved intents
exist), reconnect begins with a current snapshot so stops remain discoverable
across observer and server restarts. No periodic Chaldea scan is introduced.

### Hold, guarded dispatch and restart behavior

Before any command, the observer saves an intent in its existing atomically
written state file. IDs use a SHA-256 digest of the JSON tuple `[threadId, runId]`;
a reset correction cannot mint a second continuation for the same run.

1. For a known reset, send `thread.metadata.update` with
   `limitRecovery: {runId, resetAt, autoResume:false}` for that exact failure.
   The omitted snooze choice is preserved. Check that the observer still owns
   that hold and that the source thread is still eligible.
2. Save the dispatch phase, then send one `message.dispatch` with target
   `modelSelection`, `manualContinuationOfRunId`, and text
   "Continue where you left off." Both `commandId` and `messageId` are
   `chaldea-switch:<digest>:continue`.
3. T3 serializes dispatch against the thread, checks its manual run guard and
   performs its native context handoff, retaining the thread and releasing the
   old provider session. A restart or uncertain response retries the identical
   payload and ID only after checking `delivered()` and repeating the current
   source/target preflight. If already delivered, claim the switch without
   resending. If the run, provider/model, settlement, pending requests, reset,
   target health or fresh quota moved, release instead. An ambiguous send
   checks delivery before falling back to release. A timeout may commit later:
   cleanup re-enters the receipt check, and subsequent thread events or snapshots
   reconcile even a cancelled intent into one `provider_switched`. While that
   outcome is uncertain, `quota_resumed` is deferred; a newer run without the
   dispatch receipt is reconciled as an ordinary resume.
4. A guard rejection starts release. Restore the prior native auto-resume
   choice while the observed `requestId` still belongs to Chaldea. If the
   recorded prior value was Chaldea's own hold, it is unknown and release
   uses the live global setting. Preserve the native snooze value; an expired
   true snooze is omitted from the update so T3 preserves it without rejecting
   a new snooze in the past. T3 caches rejected receipts, so a confirmed
   rejected release advances a saved attempt suffix; an uncertain release
   response reuses its existing suffix.
5. A successful dispatch claims one info `provider_switched` feed record with
   thread, source run, from/to provider and model. That stop does not produce
   `quota_resumed` or reset lateness, including on snapshot reconciliation.
   Feed delivery keeps B2's at-most-once trade-off.

A resetless stop cannot be armed for native recovery, so there is no recovery
hold to acquire. The same manual run guard arbitrates its continuation,
including a race with a later reset or human resume. Source/target preflight
reads are conservative; the pinned manual guard atomically checks the source
run and pending requests, but does not expose a compare-and-swap for a
concurrent model-only edit or settlement. Such an edit after the last
preflight check can therefore be superseded by the dispatch. Enabling this
optional path accepts that pinned-server limitation; stronger arbitration
requires an upstream conditional-dispatch contract.

Intents admit at most 128 unresolved switches; reaching the cap logs once and
leaves new stops on native recovery. Every active phase has a hard cleanup
deadline: reset plus two minutes, or two minutes after admission for a
resetless stop. One next-deadline timer handles idle threads; release retries
exist only while cleanup is pending. At the reset itself, an undelivered
continuation is no longer eligible and is released instead of resent.
After the deadline, an owned hold that T3 refuses to update because the
thread is archived, settled or awaiting input is cleared with
`thread.metadata.update limitRecovery:null`. This returns it to native global
policy and frees its intent slot. Immediately before every restore or clear,
including a fallback clear after a rejected restore, Chaldea re-reads the thread
projection and requires both its own hold request ID and the unchanged latest
run. A newer run or human/native recovery request is left alone and frees the
intent slot. A read-then-write race remains: pinned T3 has no guarded metadata
update, so a change after that final projection read can still be overwritten.
Remove this limitation when upgrading to a T3 version with a metadata update
that atomically checks the expected recovery request ID and latest run.

Switch work is coalesced in a bounded background worker. Quota records are
processed before it and never wait for optional switch RPCs. Any switch-path
exception, including protocol drift or insufficient scope, disables new
switches, tries to release existing owned holds, and claims one loud
`provider_switch_failed` warning per source run. Cleanup is attempted at most
once per active intent per drain. Observation continues. Transient connection
failures retry the live catalog after exponential backoff from one second to
at most one minute, then re-enable switching and log once. The failure warning
is not repeated. Authorization and protocol failures stay disabled until
credentials change or the observer restarts.
A genuinely revoked operate scope or an unreachable server cannot be bypassed:
failed cleanup stays durable and retries; restoring access or restarting the
observer reconciles it before new work. No client-only deadline can run while
the host/observer is down, so overdue holds are released immediately on
reconnect when access permits.

State format 3 migrates format 2 without losing cursor or feed claims. Old
active v2 switch intents are released, never replayed; a stored false restore
value of uncertain hold provenance uses the global setting. Completed/cancelled
records expire after 42 days and are capped at 1,000, with count eviction
ordered by stop time. The existing watermark prevents reviving evicted stops.
There are no new per-thread files, transcripts, credentials or unbounded journals.
Per-thread preflight uses `getThreadProjection`, and a batch shares one server
config read.

T3 keeps the handoff in the thread. **Binding B3 deviation from plan decision
12:** a Jocasta copy is deferred; no transcript export or Jocasta write occurs.

### Purchased credits and overage in pinned T3

Igor intends purchased Codex credits to be usable. The pinned
`ServerProviderUsageLimits` contract exposes no purchased-credit balance or
active-overage/credit-spending flag. Its `resetCredits.availableCount` counts
banked unfair-rate-limit reset entitlements: they clear windows only after a
separate redemption. They do not prove that a turn may spend purchased credits
while a window remains exhausted. `externalUsage` contains only a label and
URL for the provider's usage settings, with no capacity or permission value.
There is no `credits` field in this contract. Accordingly B3 retains the
fresh-window rule; unredeemed reset metadata and an external link do not
override a 100% window. Once a T3 redemption updates the windows, ordinary
admission can use them. A unit test fixes this boundary so a future contract
upgrade can add purchased-credit admission deliberately.

### Token migration

Switching requires `orchestration:operate` in addition to
`orchestration:read`. Re-issue the B2 observer token before enabling:

```sh
install -d -m 700 ~/.config/chaldea
(umask 077 && t3 auth session issue --base-dir ~/.t3 \
  --scope orchestration:read --scope orchestration:operate \
  --ttl 30d --label chaldea-quota --token-only > ~/.config/chaldea/t3-token.next)
mv ~/.config/chaldea/t3-token.next ~/.config/chaldea/t3-token
```

Revoke the old session with `t3 auth session list` / `t3 auth session revoke`.
Revocation closes its old socket; the reconnect re-reads the token file.
A token lacking operate is rejected before a new hold is changed: log once
per credential/process, claim a warning, suspend switching and keep observing.
Previously held work requires the operate scope again to finish cleanup;
retries cannot bypass authorization. Do not remove an intent file to clear a
hold.

### B3 acceptance coverage

Unit tests cover both map directions, catalog/effort validation, unknown and
exhausted quota, deterministic IDs, scope refusal, durable-save failure,
hold/release ownership, rejected release retries and ambiguous responses.
Disposable pinned T3 tests use fake Claude stream-json and fake Codex
app-server peers, without provider credentials or network: Claude to Codex
with actual portable-history delivery and effort preservation; Codex exhausted
with native Claude resume; insufficient scope with native resume; SIGKILL
immediately after the real hold acknowledgement followed by disposable T3 and
observer restarts both before and after reset; and expiry while archived.
A pre-reset restart can switch once. A post-reset restart releases and resumes
natively once. Expired archival holds are cleared and, after unarchive, native
recovery works. Switched stops have one switch record and no native reset resume.

The defaults' remaining model pairs and Codex-to-Claude switching are covered
by routing unit tests; that reverse protocol path is not exercised end to end.
Delegated and scheduled lineage uses the same eligibility path; only standalone
threads are exercised end to end.

## What T3 does natively

T3 0.1.0 classifies a provider stop as `lastErrorClass: "usage_limit"` on a
`failed` thread and records the reset as `usageLimitResetAt` (from Claude's
rejected `rate_limit_event.resetsAt`, a `blocking_limit` result, or Codex's
exhausted rate-limit windows). The recovery worker runs on T3's shared
scheduler, which sleeps five seconds between ticks. On each tick it:

1. Finds candidate threads: the latest executed run failed, its root error is
   `usage_limit` with a reset later than the run's completion, the thread is not
   deleted, archived or settled, and it has no pending approval or input request.
2. If the thread's `limitRecovery` does not yet name this run and reset, and
   the global setting is on, it arms recovery with
   `thread.metadata.update` (`commandId limit-arm:<thread>:<run>:<resetMs>`,
   `autoResume: true`).
3. Once the reset has passed, it sends `message.dispatch` with the text
   "Continue where you left off.", `usageLimitContinuationOfRunId` set to the
   failed run, and the deterministic ID
   `limit-resume:<thread>:<run>:<resetMs>:<armRequestId>`. The server guard
   drops it if the thread moved on (new run, provider change, settled,
   archived, pending request), so a retry or a race cannot produce a second
   continuation.

A stop with no reset never becomes a candidate, so it stays parked; if a later
provider update patches a reset onto the same failure (Codex sends rate-limit
snapshots late), the thread becomes a candidate and resumes normally.

Expected lateness is therefore 0 to about 5 seconds after the reset, plus the
provider's own start-up. Measured in this repository's end-to-end test on
omarchy-pc: the continuation run started 3.4 to 3.9 s after the reset (3.383,
3.432 and 3.923 s in three runs); when the setting was switched on through
`settings.json` after the stop, 1.5 to 2.3 s.

### Enabling it on a host

The setting is server-scoped and defaults to off. It lives in T3's settings
file, `<base dir>/userdata/settings.json` (`~/.t3/userdata/settings.json` for
the service), under the top-level key `autoResumeLimitedThreads`. T3 watches
that file and reloads it about 100 ms after a change; the worker reads the
settings on every tick, so **no T3 restart is needed**. Turn it on while T3 is
running in one of two ways; both go through T3's own settings writer, so a
change another client makes at the same moment is kept:

1. In the T3 app: Settings, the switch "Auto-resume limited threads"
   ("Resume usage-limit stops at the reported reset time. Each thread can
   cancel its scheduled continuation.").
2. With `chaldea t3 set-auto-resume on|off`, which calls the public
   `server.updateSettings` RPC with `{ patch: { autoResumeLimitedThreads } }`
   over the same adapter as the observer. That RPC needs only the
   `settings:write` scope (B:373688, 373829), which the observer's token
   deliberately lacks, so use a separate token that lives for minutes and is
   deleted afterwards. Each step assumes the previous one succeeded:

   ```sh
   install -d -m 700 ~/.config/chaldea
   (umask 077 && t3 auth session issue --base-dir ~/.t3 --scope settings:write \
     --ttl 10m --label chaldea-set-auto-resume --token-only > ~/.config/chaldea/t3-settings-token)
   node ~/.local/share/chaldea/app/src/cli.ts t3 set-auto-resume on
   rm ~/.config/chaldea/t3-settings-token
   ```

   It prints `autoResumeLimitedThreads is on` and exits 0. The token expires
   on its own after ten minutes; `t3 auth session list` and
   `t3 auth session revoke` end it sooner. The end-to-end test runs this
   subcommand with a `settings:write`-only token after a thread has parked,
   and checks that the thread resumes and that a setting changed just before
   by another client survives.

**Fallback, only while T3 is stopped:** set the key in the file directly, then
start T3. Editing the file while T3 runs is not supported: T3 also rewrites the
file, and a concurrent change made through the app or the RPC can be lost.

```sh
cd ~/.t3/userdata
cp -p settings.json settings.json.before-chaldea-quota
jq '.autoResumeLimitedThreads = true' settings.json > settings.json.chaldea-tmp
chmod --reference=settings.json settings.json.chaldea-tmp
mv settings.json.chaldea-tmp settings.json
```

T3 leaves default values out of the file when it persists settings itself, so
an absent key means `false`. This repository does not change the live T3
settings on any host.

### `snoozeLimitedThreads`

The sibling setting ("Snooze usage-limit stops until the reported reset time.
Combine with auto-resume to continue when they wake.") arms recovery with
`snooze: true`, which sets the thread's `snoozedUntil` to the reset time. That
only moves the thread into T3's snoozed state in the sidebar until the reset;
it sends nothing. With auto-resume off, the thread wakes at the reset without a
continuation; with both on, the continuation is still sent at the first tick
after the reset. It is not needed for quota resilience and stays at its default
(off).

### Which threads it applies to

The candidate query and the continuation guard filter on thread state only:
not deleted, not archived, not settled, no pending runtime request, and a
`usage_limit` root failure with a future reset. Neither looks at lineage or
creation source. From the source, therefore, auto-resume applies to every such
thread, including **delegated child threads** (`lineage.relationshipToParent:
"subagent"`) and **scheduled-task threads**. A user can cancel one thread's
continuation from the thread itself (per-thread `limitRecovery.autoResume:
false`), which overrides the global setting.

Only standalone threads were exercised end to end. For delegated children this
means a child stopped by a limit is continued after the reset even though its
parent may already have been told the child failed; whether that is wanted is a
review question, not something Chaldea changes. The observer marks such records
with `"subagent": true`.

## Cached headroom and credits

`chaldea quota status` reads the observer's latest durable snapshot without contacting
T3 or starting a provider. `chaldea quota status --json` preserves exact decimal credit
strings, nulls and units. Use `--state-file PATH` for an isolated snapshot. A missing
snapshot reports unknown. There is no implicit collection/refresh action in this command.

The report separates three advisory lanes: included-usage windows, credit-funded
continuation, and manual-reset inventory. Each metric includes its source,
successful observation time, age and `fresh|stale|unknown|unsupported|error` state.
A reading becomes stale at 15 minutes. Failed balance reads keep the last good value
and timestamp with a sanitized error class; a window update cannot refresh the
wallet or an omitted reset count. Empty/missing data never means zero. Future
reset times, percentages and positive credit balances do not prove provider recovery.

Advisory config failures, including contract drift, pause headroom collection and
retry with independent backoff; they never stop or reconnect the shell observer.
The observer reads cached `server.getConfig` and subscribes to
`subscribeServerConfig` snapshots/provider statuses. It retains window IDs,
kind, used/remaining percentage, duration in minutes, ISO reset time, checkedAt,
manual-reset count and optional expiry. It excludes redemption IDs, auth labels,
account/workspace IDs and credential fingerprints from reports and feed payloads.
Claude resets carry source `t3-internal-claude-reset-read`; they remain dependent
on T3's internal upstream read. No new private HTTP client is added.

Codex aggregate credits come from a separate short-lived **installed** Codex
app-server. They are credits, not dollars or a purchased-only ledger, and are never
summed across aliases/buckets. The wallet's decimal string, hasCredits/unlimited
flags, manual-reset count, ordinaryUsageAllowed and spendControlReached each retain
their own successful observation time. The only account RPC is
`account/rateLimits/read`, with `excludeResetCreditDetails:true` and
`supportsLunaReserve:false`, after initialize/initialized. No model thread or turn,
purchase, reset redemption, login change or explicit credential refresh is requested.
Normal provider-managed credential renewal during a read is distinct from these actions.
This exchange was designed against codex-cli 0.163.0; optional fields are tolerated
and incompatible responses degrade to unknown/error rather than inventing a balance.

Credential matching is deliberately explicit. At startup, `quota observe` reads
`~/.config/chaldea/quota.json` relative to its user's HOME. For the packaged
omarchy-pc service the exact path is `/home/igor/.config/chaldea/quota.json`.
A missing default file leaves Codex balance unknown. `--quota-config PATH`
overrides that path; an explicit missing file or malformed config is an error.
Creating the file takes effect on the next observer start.

Minimal example for an instance named `codex` whose effective runtime home is
`/home/igor/.codex`:

```json
{
  "contexts": [{
    "providers": ["codex"],
    "home": "/home/igor",
    "codexHome": "/home/igor/.codex"
  }]
}
```

The optional `command` is an absolute path to the installed Codex executable;
without it the observer resolves `codex` on its service PATH. The optional
`lowHeadroomPercent` defaults to 10. The operator binds aliases to the actual
HOME/auth context; use T3's effective runtime path for `codexHome`, including
a shadow home when configured. The observer
also requires a loopback T3 URL, an enabled/installed/authenticated Codex provider,
a confirmed ChatGPT auth type, and an exact normalized match between codexHome and the published effective runtime
home (shadowHomePath when present, otherwise homePath). Missing runtime paths,
instance environment overrides, a remote server or an unmatched context leave the
balance unknown. If T3 supplies a workspace identity, its private hash must also
match the read response; no identity or hash is persisted or reported. There is no fallback to the invoking shell's account. The collector
sets HOME/CODEX_HOME explicitly and excludes inherited auth tokens and endpoint
overrides. Instances requiring custom auth environment need a future context adapter.
Equal HOME/CODEX_HOME/executable tuples share one collector across aliases; paths and
context keys are internal and never appear in status/feed output. Reconfiguration
invalidates the wallet before a new context can report it. Without a quota config,
T3 windows/reset counts still work and Codex money remains unknown.

Rejected Codex bindings now log one `Codex balance collector` line per provider
and reason transition, and persist the same reason in the balance metric's
`error` field. Human status shows `reason runtime_home_unknown` instead of
`observed never`; JSON exposes the stable code. No paths, account identifiers,
credential hashes or raw provider errors enter these diagnostics.
`runtime_home_unknown` means T3 omitted published `runtimePaths`; changing
`quota.json` cannot confirm that missing effective home. T3 must publish it
before this collector can safely match the account. `runtime_home_mismatch`
means `codexHome` differs from the published effective path. Other codes identify
missing aliases, disabled/uninstalled/unavailable providers, auth type/status,
instance environment overrides, remote T3 and missing quota context bindings.
A missing configured alias appears in cached status within the 64-row bound.
The first scheduled read logs `read_started`; results log `read_completed` or
a sanitized failure code only when the outcome changes. `spawn_failed` means
the configured executable or its working directory could not be used, including
an executable absent from the service PATH. The existing read cadence and backoff
are unchanged.

Collection happens once when the observer receives its startup catalog, then every
five minutes with ±10% jitter while connected to T3. A ten-second scheduler checks
due work; reads are single-flight across the collector, sequential across contexts,
have a ten-second deadline and a 1 MiB stdout bound, and terminate their process
group. Failures/429 back off exponentially to at most 160 minutes plus jitter.
Shutdown aborts in-flight work. Reconnects do not reset the due time or create a
second polling loop. This path never asks T3 to refresh a provider.

Claude extra-usage spend/cap remains **unknown** in this initial implementation:
the experimental CLI control read is not enabled. There is no verified supported
Claude prepaid wallet. If a future feature-detected control read succeeds, its spend
and cap must retain currency **minor units**; cap remainder is not prepaid cash.
Unsupported money metrics are distinguished from an unknown observation.

The existing durable feed queue/poster carries one combined host
`quota_headroom_snapshot` per 15-minute UTC bucket while connected, including
startup. Its body contains all enabled, installed providers with at least one
fresh metric; unavailable or failed probes are excluded even if cached values
remain. Unknown-only and stale-only providers produce no feed records. The first
usable observation after startup establishes the change/low baseline silently.
Afterwards `quota_headroom_changed` reports metric availability, wallet availability,
permission or reset-count transitions, and `quota_headroom_low` reports a changed
nonempty set below the configured included-window remaining-percent threshold.
Each kind is combined per host per evaluation. Refresh timestamps and catalog
ordering do not trigger records. An empty eligible catalog produces no records.
Cached status retains per-metric stale/unknown diagnostics.

Each provider carries at most 32 windows, with at most 64 provider aliases. Claims,
snapshot slot and pending delivery are saved together before enqueue,
with at most the newest pending headroom intent per host/kind (3 total);
headroom intents are evicted before a transition can be rejected for capacity, so observer
restarts replay durable delivery intents through the existing poster path.
Legacy feed attempts retain their existing at-most-once semantics; scoped Akasha
delivery retains its receipt/retry behavior. Status does not post feed records.

Routing receives these three lanes as read-only inputs. Credit-funded admission
and automatic reset redemption are always disabled in this design. Inventory
cannot admit a provider switch; a fresh ordinary-usage denial blocks the included
lane, while spend controls remain separate in the credit-funded lane. A future paid-routing policy would need an explicit budget, adequate
**fresh** balance, spend-control checks and actual provider acceptance. Existing
usage-limit stop/resume behavior remains in place.

The fake Codex stdio fixture verifies the exact allowlisted request sequence,
redaction, null/zero handling and bounded failure behavior without any provider
account. Cadence/backoff/threshold tests inject time and randomness rather than
asserting elapsed wall-clock time. The status CLI is exercised against a fake
persisted snapshot with provider executables unavailable on PATH.

## The observer

`chaldea quota observe` connects to local T3 at
`ws://127.0.0.1:<port>/ws?orchestrationProtocol=2` with
`Authorization: Bearer <token>`, subscribes to `orchestration.subscribeShell`
and follows it. The port is read from `~/.t3/userdata/server-runtime.json`
(`origin`) on every reconnect, or given with `--server-url`. It posts:

| Record | Severity | When | Body |
| --- | --- | --- | --- |
| `quota_parked` | warn | a thread is `failed` with `lastErrorClass: usage_limit` and a reset | thread, run, provider, `resetAt` |
| `quota_reset_unknown` | warn | the same, but no reset is known | thread, run, provider |
| `quota_resumed` | info | a parked thread has a newer run | thread, parked run, continuation run and start, provider, `resetAt`, `latenessSeconds`, `trigger` |

**First start.** With no state file (no cursor yet) the observer reports no
history from its first snapshot and starts from that point. Stops already
continued are claimed silently so a later snapshot cannot report them as
history. A thread parked at that moment with a reset gets no `quota_parked`,
but it is remembered, so its `quota_resumed` is still posted. A thread parked
at that moment with no reset gets its one `quota_reset_unknown` (marked
`"reconciled": true`), since it stays parked until a later event supplies a
reset.

**Missed events.** When T3 cannot replay the shell from the observer's cursor
it sends a snapshot instead, and the transitions in between are gone. On a
snapshot, a thread whose `limitRecovery` names a run that is no longer the
latest run had a usage-limit stop that was later continued; the observer then
posts the `quota_parked` and `quota_resumed` it missed, marked
`"reconciled": true`, subject to the same keys and age limit. This also runs
for a thread the observer had cached as parked, so if a thread was continued,
stopped again and continued again while the observer was away, both the
cached stop's resume and the later stop's park and resume are posted. A stop that
happened and was continued while the observer was away is reported this way
only if T3 armed recovery for it (`limitRecovery` is set by the native worker
when auto-resume or snooze is on, or by the per-thread control). Lateness in a
reconciled record is measured to the thread's latest run, which may be later
than the continuation if more turns followed.

`trigger` is `auto_resume` when T3's armed recovery for that run was in place,
otherwise `other` (for example a person sent a message first). If a reset
arrives later for a `quota_reset_unknown` stop, a `quota_parked` follows.

Feed records use `feed post <title> --severity <s> --source chaldea-quota
--host <short hostname> --tag "quota chaldea" --body-file -`. Transition bodies hold thread/run identifiers, provider instance names and timestamps;
headroom bodies contain the sanitized metrics described above: never transcript
text, error messages, account details, tokens or URLs carrying secrets. The
end-to-end test checks the feed bodies and the observer's log for the tokens
and the transcript.

**At most once.** A record's key `(kind, thread, run)` is written to the state
file (fsync, rename, fsync of the directory) before the record is queued for
the feed. A crash can therefore lose a record but never repeat one, across
restarts, reconnects and snapshot replays. The end-to-end test kills the
observer with SIGKILL while a thread is parked and restarts it twice. If the
state file cannot be written (disk full, permissions), new records are held
back, not posted, until a write succeeds: one error is logged for the outage,
and the write is retried on the next event and on one backoff timer (1 s up to
60 s) that exists only while the state is unsaved. At most 256 records wait;
more are dropped with an error. If the observer crashes or stops during the
outage, the held records are lost together with their unsaved claims, so a
restart that replays the same events posts each of them once. A record is
never posted before its claim is on disk.

**Feed failures never block, and are not retried.** Records go to an
in-memory queue of at most 256. Each gets exactly one `feed post` attempt with
a 20 s timeout. The feed CLI has no idempotency key, so an attempt that failed
may still have reached the server, and a retry could post it twice; a failed
record is logged and dropped. The log line carries the exit status, signal and
the byte length of the CLI's stderr, never its content, which can contain
URLs or account names.

**Fail closed.** T3 answering the handshake with HTTP 426, or sending data the
pinned contracts reject, stops the observer with exit status 78; so does a
token file that is missing, empty, not owned by the user or readable by group
or others, and so does a state file it cannot read (rather than starting
afresh and repeating records). The unit does not restart on 78. HTTP 401/403 (expired or revoked
token) is retried every two minutes, re-reading the token file each time, so a
replaced token is picked up without a restart. Other connection failures,
including T3 not running or not listening yet, back off from 1 s to 60 s and
never exit. The shell transition observer has no periodic scan; headroom collection follows the separate bounded cadence above.

## Reboots and restarts

- **Boot.** The unit is `WantedBy=default.target` of the user manager, which
  starts at boot without a login because lingering is enabled for `igor`
  (`loginctl show-user igor -p Linger` gives `Linger=yes`). It is ordered
  `After=t3code.service`, T3's own user unit on omarchy-pc, but does not
  require it.
- **T3 not up yet.** If T3 is not running or not yet listening, the observer
  logs `T3 connection failed` and retries with backoff; it does not exit 78.
  It rediscovers the port from `~/.t3/userdata/server-runtime.json` on every
  attempt, so a new port after a restart is found. Covered by the end-to-end
  test that starts the observer before the disposable T3.
- **T3 restart.** The stream ends, the observer reconnects with backoff and
  resumes from its saved cursor; T3's shell sequence is stored in its
  database, so replay continues where it stopped, or T3 sends a snapshot that
  is reconciled as described above. Records are not repeated (the keys are on
  disk) and not lost beyond the trade-offs documented here.
- **Native auto-resume across a T3 restart.** `limitRecovery` is part of the
  thread record in T3's database, and the recovery worker's candidate query
  reads the database on every tick, so a parked thread still resumes at its
  reset after T3 restarts. The same end-to-end test restarts T3 while a thread
  is parked and checks for exactly one continuation and exactly one
  `quota_parked` and one `quota_resumed`.
- **Host reboot or observer restart.** The state file is written atomically
  and fsynced, so the cursor and claims survive. Events that arrived after
  the last save are replayed by T3 and deduplicated. A reset that passes
  while the host is down is handled by T3 once it is back, and the observer
  records that resume then.

## Retention

| Resource | Location | Bound |
| --- | --- | --- |
| Observer state (cursor, posted-record keys, parked threads) | `~/.local/state/chaldea/quota-observer.json`, mode 0600 | keys expire 42 days after the stop they describe, parked threads 42 days after they were seen; at most 10,000 keys and 1,000 parked threads, oldest evicted first; 2.7 MB with both caps full of real-length T3 IDs |
| Old stops | | a stop older than 35 days is never reported, so expired keys cannot revive old history |
| Evicted keys | `evictedThrough` in the state file | every eviction raises this watermark to the evicted key's stop time, and stops at or before it are never reported, so eviction at the cap can lose a record but never repeat one |
| Feed queue | memory | 256 records |
| Logs | journald (`journalctl --user -u chaldea-quota`) | at most 120 info and warn lines per minute in process (error lines are rare and not capped), plus `LogRateLimitBurst=200` per 60 s in the unit; journald's own size caps apply |

A stop's time, for the age limit and the watermark, is its reset when known,
otherwise the failed run's completion. A parked thread evicted at the
1,000-thread cap loses its `quota_resumed` unless a later snapshot reconciles
it; its `quota_parked` key stays, so nothing is repeated.
| Test fixtures | `$CHALDEA_TEST_SCRATCH` (default `~/.cache/chaldea-test`) | removed after each test, passed or failed; anything a crashed run left is removed by the next run once it is a day old |

Pruning happens on every save, which is every state change and at most every
five seconds while events arrive; there is no separate retention timer. Feed-server retention is
the feed's own concern.

## Installing on a host

This change writes observer state format 5 (and reads formats 2–4). An older binary
will reject a format-5 state file after rollback. Preserve a pre-upgrade state
backup for a coordinated rollback; do not delete state to bypass that refusal.
Malformed headroom state is refused once on load, preserving existing delivery claims.

Not done by this change; the orchestrator installs after review. Run as the
user that owns the T3 service (`igor`). Each step assumes the previous one
succeeded.

1. Check out the reviewed commit into the path the unit uses, and install the
   runtime dependencies with the pinned Node:

   ```sh
   git clone git@github.com:iryzhkov/chaldea.git ~/.local/share/chaldea/app
   git -C ~/.local/share/chaldea/app checkout <reviewed commit>
   cd ~/.local/share/chaldea/app && npm ci --omit=dev
   ```

2. Issue a token with only the scope the observer needs, written straight into
   a private file. Nothing is printed, and the token never appears on a
   command line:

   ```sh
   install -d -m 700 ~/.config/chaldea
   (umask 077 && t3 auth session issue --base-dir ~/.t3 --scope orchestration:read \
     --ttl 30d --label chaldea-quota --token-only > ~/.config/chaldea/t3-token)
   stat -c '%a %U' ~/.config/chaldea/t3-token   # expect: 600 igor
   ```

   `orchestration:read` covers `orchestration.subscribeShell`; the observer
   sends no commands while switching is disabled. For B3 switching, use the
   two-scope token migration above. Note the expiry: before it, issue a new token the same
   way into a temporary file, move it over the old one, and revoke the old
   session (`t3 auth session list`, `t3 auth session revoke`). The observer
   picks up the new file on its next reconnect.

3. Install and start the user unit:

   ```sh
   install -D -m 644 ~/.local/share/chaldea/app/packaging/systemd/chaldea-quota.service \
     ~/.config/systemd/user/chaldea-quota.service
   systemctl --user daemon-reload
   systemctl --user enable --now chaldea-quota.service
   journalctl --user -u chaldea-quota -n 20
   ```

   Expect `subscribed to T3 shell` in the log. The unit runs at boot without a
   login because lingering is enabled for `igor` on omarchy-pc.

4. Turn on `autoResumeLimitedThreads` with the app switch or `chaldea t3
   set-auto-resume on` as described above, if it is not on yet.

The unit's paths are absolute and specific to omarchy-pc (`/home/igor`, Node
26.10.0 from mise, `feed` in `~/.local/bin`); step 2 of the plan (fleet
configuration) will template them for other hosts.

## Tests

```sh
npm ci
npm run typecheck
npm test            # unit tests, then end-to-end tests
```

The scripts set `TMPDIR` and the fixture root to `$CHALDEA_TEST_SCRATCH`
(default `~/.cache/chaldea-test`), never `/tmp`. The end-to-end tests start the
real pinned `t3` (`CHALDEA_T3_BIN`, default the mise-installed v0.1.0) as a
disposable server on a free port with its own base directory, HOME and PATH,
and a fake `claude` (`test/fixtures/fake-claude.mjs`) that speaks the Agent
SDK stream-json protocol: its first trigger message gets a rejected five-hour
`rate_limit_event` with `resetsAt` ten seconds ahead (or none) and a
`blocking_limit` result; every later message completes. The feed command is
`test/fixtures/feed-recorder`, so tests never post to the real feed. They
skip themselves when the pinned `t3` is not found. The disposable servers
listen on 127.0.0.1 only and never touch a host's own T3.

The end-to-end tests assert: exactly one continuation message and one new run,
starting 0 to 10 s after the reset (the measured lateness is printed on every
run); exactly one `quota_parked` and one `quota_resumed` across an observer
crash and two restarts; for a resetless stop, exactly one
`quota_reset_unknown`, no continuation through more than two sweeps, and an
observer restart adds nothing; `chaldea t3 set-auto-resume` with a
`settings:write`-only token enables resume for an already parked thread
without a restart and keeps a setting another client changed; an observer
started before T3 keeps retrying, finds T3 once it is up, and a T3 restart
while a thread is parked still yields exactly one continuation and one
`quota_parked` and `quota_resumed`. The scenarios that start T3 with the key
already in `settings.json` exercise the stopped-server fallback.

CI runs on GitHub-hosted Ubuntu 24.04. It downloads the checksum-pinned T3
from `vendor/t3-contracts/PROVENANCE.md` and keeps HOME, TMPDIR and fixtures
in the job's isolated scratch directories.

Codex stops reach the observer through the same shell fields. The separate
`fake-codex-balance.mjs` fixture covers only the no-turn balance protocol.

## Evidence

Upstream is pingdotgg/t3code at tag `v0.1.0`, commit
`81493efb71e8e8244f95d3e9f71d8369654ab151`; `B:n` is line n of the source
embedded in the installed `t3` executable (research copy
`/home/igor/.cache/chaldea-scratch/laneB/t3-embedded.mjs` on omarchy-pc).

- Settings schema and patch: `vendor/t3-contracts/src/settings.ts:1216-1217`
  and `:1599-1600`; B:49339-49340, 49567-49568. Patch scopes
  (`settings:write` unless only providers change):
  `vendor/t3-contracts/src/settings.ts:1671`; B:48659-48668.
- Settings path `<base>/userdata/settings.json`: `apps/server/src/config.ts:161`;
  B:60955-60967. File watch with 100 ms debounce:
  `apps/server/src/serverSettings.ts:1115-1180`; B:64700-64725.
- Recovery worker and IDs: `apps/server/src/orchestration-v2/UsageLimitRecoveryWorker.ts:11`,
  registration `:113`; B:348628-348702. Reads settings every tick: B:348681.
- Candidate query (no lineage or source filter):
  `apps/server/src/orchestration-v2/ProjectionStore.ts:3580-3660`; B:124047-124117.
- Continuation guard: `apps/server/src/orchestration-v2/Orchestrator.ts:4589`;
  B:343110-343129. Arm and snooze handling: B:342058-342077.
- Five-second scheduler: `apps/server/src/scheduling/Scheduler.ts:60`.
- UI switches: `apps/web/src/components/settings/SettingsPanels.tsx:2360-2390`.
- WebSocket gate (426 without `orchestrationProtocol=2`, then bearer auth):
  `apps/server/src/ws.ts:3171-3200`.
- Research brief: Jocasta `tooling/research/chaldea-quota-resilience-brief-2026-10-16.md`
  (jocasta:2c97942a87c3a9122c18d3a88b4973f8@1).
