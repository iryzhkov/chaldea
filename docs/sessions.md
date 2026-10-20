# Fixed-preset sessions (local prototype)

A broad interactive thread can ask the local wait service to start one
operator-configured preset as a separate, visible thread on the same official T3
server and UI. The service launches it through the typed
`orchestration.launchThread` RPC, observes its root run, stores the exact final
result, and sends one wake to the caller through the existing wait outbox. The
caller never polls, copies tokens or manages a T3 connection.

This is disabled by default. It is a shared-server accident-prevention
prototype. It is **not** authenticated per-thread confinement.

## What this slice does and does not prove

The synthetic fixtures (`test/unit/session-lifecycle.test.ts`,
`test/unit/session-policy.test.ts`) drive the real wait engine and WakeStore
against a fake official T3. They prove the local lifecycle: admission before
launch, idempotency, uncertain-launch handling, root-result capture, result
bounds, preset quarantine and the issuance gate.

They do not qualify any of the following:

- Authentik credential acquisition or a credential helper.
- Unix identity custody.
- A live provider or a live T3 launch.
- The Jocasta service ACL.

The fixtures only check that grants name projectA. Denial of projectB is
proven by Jocasta's own tests and the external canary, not here.

## Configuration

The waits config gains one optional key, `sessionPolicy`, an absolute path. The
service re-reads the policy for every start and every gate check.

The policy must be readable by the ordinary service UID, so it is public, not
0600. A root-owned 0600 file cannot be read by the service and is not a valid
layout. Integrity comes from ownership instead:

- The file and every ancestor directory must be owned by root.
- None of them may be group- or other-writable.
- The file must be a regular file with one link, opened without following
  symlinks.
- It is parsed as strict JSON, and unknown keys are refused.

The policy never holds credentials. A minimal example:

```json
{
  "version": 1,
  "environment": "<T3 environment id>",
  "ceilings": [{
    "project": "projectA", "maxSeconds": 3600, "destinations": ["<caller T3 project id>"],
    "services": [{"audience": "jocasta", "grants": [{"resource": "project:projectA", "actions": ["get", "history", "list", "search"]}]}]
  }],
  "presets": {
    "jocasta-projectA-reporter": {
      "instanceId": "<dedicated provider instance>", "model": "<model>",
      "runtimeMode": "approval-required", "interactionMode": "default",
      "projectId": "<reporter T3 project id>", "title": "Jocasta projectA reporter",
      "prompt": "Report projectA status in at most 2048 bytes, with citations.", "inputs": {"scope": "status"},
      "project": "projectA", "maxSeconds": 1800, "delegate": false, "destinations": ["<caller T3 project id>"],
      "services": [{"audience": "jocasta", "grants": [{"resource": "project:projectA", "actions": ["get", "history", "list", "search"]}]}]
    }
  }
}
```

The preset alone chooses the provider instance, model, modes, T3 project,
prompt and inputs. The workspace strategy is always `root`. The model and the
caller cannot supply argv, environment, helpers, endpoints, worktrees or
providers.

## Admission

`chaldea_session_start {threadId, requestId, preset}` is the whole interface.
The service applies these rules before any launch:

- Any other field is refused. Explicit limits such as `maxSeconds` or
  `services` get `unsupported_reduction`, because this slice runs only fixed
  presets.
- The whole preset must fit inside one operator ceiling: the same access
  project, every grant a subset, no longer duration and no wider
  destinations. Equal and narrower presets pass. Broader ones get
  `preset_exceeds_ceiling`.
- Only read-only Jocasta actions are supported. Anything else gets
  `unsupported_audience` or `unsupported_grant`.
- `delegate` must be `false`. Otherwise the start gets
  `delegation_unsupported`.
- An unknown preset gets `unknown_preset`. With no policy configured, every
  start gets `sessions_disabled`.
- The caller thread must be live on this T3 environment. Its project must be
  one of the preset's destinations; otherwise the start gets
  `destination_not_allowed`.
- A session thread, or a descendant found through T3 lineage (native child,
  fork, deeper chain), gets `caller_not_delegating`.
- A preset whose previous session still holds its slot gets `preset_busy`.
  At most four slots are held at once.

The pure checks reuse `validateAdmission` and `narrowing` from
`src/access/run-lease.ts`. `RunLeases`, `HostIssuer` and `renew` are not used.

### Trust boundary

The existing private same-UID wait socket is operator-context ingress. The
caller `threadId` is only the wake destination, never proof of authority.

Any same-UID process can reach the socket and name any destination, including
a shell inside a reporter. The lineage check only catches mistakes by known
session threads. The reporter's provider instance should get no Chaldea MCP,
but leaving it out is not a security proof. Interactive threads and their
native children keep their existing behavior.

## Lifecycle

The session and every launch identity (command, thread and message IDs, plus
the exact launch bytes) are committed to the existing WakeStore SQLite journal
before any side effect. Launch moves through these states:

- `intent`: nothing was sent. Dispatch is safe, including after a restart.
  The bytes are identical on every attempt.
- `dispatching`: the RPC is in flight. After a restart this becomes
  `uncertain` and is **never resent**.
- `accepted`: T3 returned the requested thread ID, or the requested thread was
  observed.
- `rejected`: T3 returned a typed refusal (`OrchestrationV2ThreadLaunchError`
  or an authorization error).
- `uncertain`: the answer was lost. The service observes the known thread ID.
  If the thread appears, the session continues. If it never appears, the
  outcome is `launch_uncertain` at the deadline. The reporter is never
  relaunched.
- `mismatch`: T3 returned a different thread ID. The preset stays
  quarantined.

A deterministic `commandId` is sent, but this slice does not claim that it
proves idempotence on a real server. Reconciliation relies only on observing
the requested thread.

The root run is the run whose user message is the session's message ID.
When that run's cohort is terminal, these outcomes are possible:

- **Succeeded:** the result is the last non-streaming `assistant_message` of
  that run's root node. Output from native child nodes is never used.
- **Failed, interrupted, cancelled or rolled back:** no result.
- **No final root message (`result_unavailable`), or still streaming after
  retries (`result_ambiguous`):** no result, and the run is not reported as a
  success.
- **Deadline, operator cancellation or thread deletion:** a terminal outcome
  with no result.

T3 reports no completion time, so the deadline wins unless this service saw
the root completed before the deadline. A completion first observed later,
for example after the service was down across the deadline, is a `deadline`
outcome with no result. A timely completion may finish reading its result for
up to 10 minutes after the deadline; after that the outcome is
`result_unavailable`. A cancellation during that read wins. Launch retries
and result-read retries have separate budgets.

### Preset occupancy

Each preset has one runtime slot, because per-provider credentials are bound
to the instance, not to a turn. A deadline, cancellation, orphaned caller,
rejected launch or uncertain launch ends the session logically and stops
issuance at once. None of these frees the slot.

The slot is released only by T3 evidence:

- The root cohort is terminal and no run, queued request or native child in
  the thread is still live (`runtime_stopped`).
- The thread is verified deleted or absent after an accepted or rejected launch.
- Nothing was ever sent (`never_launched`).

Until then a new start for that preset gets `preset_busy`. This stops a
surviving old reporter from using a preset-bound helper to obtain a later
run's credentials. Retention never prunes a held slot.

An uncertain launch whose thread never appears, and an identity mismatch, stay
quarantined. There is no operator release command yet; clearing one needs a
separate operator repair. The internal `reconcileSession` call re-reads T3
and applies the same rules, never a blind release.

## Results and wake

A result is stored exactly when it is well-formed UTF-8 (no unpaired
surrogate), has no NUL, and is at most 2048 bytes. Otherwise the outcome is
`result_invalid` or `result_oversize`, nothing is stored, and the thread stays
inspectable. Nothing is truncated or sanitized.

There is one deterministic wake per session (`chaldea-session:<id>:wake`),
sent through the existing outbox with its uncertain-delivery handling. This is
not network exactly-once delivery. The wake embeds the result only if the full
escaped command fits the local 4096-byte cap. Otherwise it is pointer-only and
marked `result_in_status`.

`chaldea_session_status {id}` returns the exact stored text. The 8 KiB
cross-host message envelope is a separate contract.

## Issuance gate (internal, disabled)

`authorizeIssue(preset, audience)` returns the active run, its grants and its
expiry, or a refusal: `no_active_run`, `run_inactive`, `run_expired`,
`run_not_launched`, `preset_changed`, `preset_removed`, `preset_exceeds_ceiling`,
`audience_not_admitted` or `sessions_disabled`. It re-reads the protected
policy on every call and fails closed. An unchanged preset must still fit one
of the current ceilings, using the same check as admission, so narrowing or
removing the admitting ceiling stops issuance. Edits to unrelated presets or
ceilings do not. It never returns a token. It is not reachable over IPC
or MCP, and only tests call it.

The actual helper, its socket, UID binding and Authentik enrollment are
deferred to a separate operator and credential packet. The Akasha producer
helper is unchanged, and no issuer or signing key is added.

## Known gaps

- Cancellation and deadlines stop issuance and wake the caller, but do not
  interrupt the T3 run. No supported interruption is wired. The slot stays
  held until the run is observed to stop.
- After the slot is released, someone could still type a new message into the
  reporter thread, and that run would use the same provider instance. This is
  a shared-server residual risk.
- Lineage knowledge lasts only as long as session records (42-day retention).
- Rolling back to a binary without sessions after sessions were used would
  meet unknown `session` items. While sessions are unused, the additive
  `sessions` table does not change the journal version, so rollback is safe.
- Before live use, an operator must provide:
  - a preset provider instance with its helper loaded;
  - an ordinary Authentik enrollment;
  - helper-to-gate binding with UID custody;
  - a live check that the wait-service token may call `launchThread`;
  - confirmation that the wait service is deployed on the host;
  - a live launch canary on disposable data.
