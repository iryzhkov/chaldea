# Quota resilience (plan step 3)

When a provider stops a T3 turn on a usage limit, T3 itself resumes the thread
at the reported reset time. Chaldea adds only an observer, `chaldea quota
observe`, that records each stop and each resume in the fleet feed. Chaldea has
no timers, no journal of its own waits and no wake dispatch: that work belongs
to T3's `UsageLimitRecoveryWorker`, and its five-second sweep is accepted.

Decisions behind this design (Igor, 2026-10-16):

1. Resume is done by T3's native auto-resume (`autoResumeLimitedThreads` on).
2. Chaldea adds only a thin observer that records quota events in the feed.
3. A hard limit with no reset time stays parked. The observer posts exactly one
   warning. The thread resumes only if a later provider event supplies the
   reset, and then T3 resumes it natively.

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
--host <short hostname> --tag "quota chaldea" --body-file -`. Bodies hold
identifiers, provider instance names and timestamps only: never transcript
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
never exit. There is no periodic scan.

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
five seconds while events arrive; there is no timer. Feed-server retention is
the feed's own concern.

## Installing on a host

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
   sends no commands. Note the expiry: before it, issue a new token the same
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

CI runs on the self-hosted runner on agent-a (labels `self-hosted, chaldea`),
because GitHub-hosted runners are unavailable to this account. The workflow
points `CHALDEA_T3_BIN` at agent-a's `~/.t3/runtime/versions/0.1.0/t3` after
checking its SHA-256 against `vendor/t3-contracts/PROVENANCE.md`, and keeps
`TMPDIR` and fixtures under the runner's temporary directory.

A fake Codex provider is not included; Codex stops reach the observer through
the same shell fields.

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
