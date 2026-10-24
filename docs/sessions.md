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

`test/unit/session-credential.test.ts` adds the native header helper against
a synthetic jose RS256 issuer behind an injected transport. It proves
Chaldea's release control: gate ordering, request shape, claim checks,
caching, rechecks after every await and refusal codes.

None of the fixtures qualify any of the following:

- Real Authentik behavior: the app-password exchange, token ownership, the
  scope mapping, `jocasta_projects`, or that the app password is refused
  elsewhere.
- Unix identity custody or hostile same-UID containment.
- A live provider, a live T3 launch or a provider's MCP header helper.
- The Jocasta service ACL or its token verifier.

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

The policy never holds credentials. A minimal example (`enrollments` is
optional; see [Native header helper](#native-header-helper)):

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
  },
  "enrollments": {
    "jocasta-projectA-reporter": {
      "form": "app_password",
      "issuer": "https://<authentik>/application/o/<jocasta app>/",
      "tokenUrl": "https://<authentik>/application/o/token/",
      "jwksUrl": "https://<authentik>/application/o/<jocasta app>/jwks/",
      "clientId": "<jocasta provider client id>", "username": "chaldea-<host>-<profile>",
      "scope": "jocasta.read", "resource": "https://<jocasta>/mcp", "project": "projectA",
      "maxTokenSeconds": 300, "secretFile": "/home/<user>/.config/chaldea/authentik/<profile>.secret"
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
- Admit read-only Jocasta legacy grants or one closed OV, homelab or HA service
  with an exactly matching enrollment. Generic legacy service grants remain
  parseable in ceilings but cannot authorize a typed service.
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

The pure session checks live in `src/session/service-grant.ts`. The separate
access-JWT codec, `RunLeases`, `HostIssuer` and their EdDSA wire are unchanged.

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

## Issuance gate

`authorizeIssue(preset, audience)` returns the preset's currently active
session: its session, run and thread IDs, preset hash, grants and expiry. Or
it returns a refusal: `no_active_run`, `run_inactive`, `run_expired`,
`run_not_launched`, `preset_changed`, `preset_removed`, `preset_exceeds_ceiling`,
`audience_not_admitted`, `session_policy_unavailable` or `sessions_disabled`.
It re-reads the protected policy on every call and fails closed. An unchanged
preset must still fit one of the current ceilings, using the same check as
admission, so narrowing or removing the admitting ceiling stops issuance.
Edits to unrelated presets or ceilings do not. The gate itself never returns
a token; only the native header helper below uses it.

## Native header helper

When the policy has an enrollment for a preset, the wait service can acquire
short-lived service tokens for that preset's active session. It uses the
existing service and socket. There is no new server, queue, store, key, lease
or issuer. The Akasha producer helper is unchanged.

The provider instance's protected MCP configuration runs this fixed command:

```sh
chaldea session headers --preset <preset> --audience jocasta
```

The command may also take `--config PATH`, like every wait command. Stdout is
exactly `{"Authorization":"Bearer <jwt>"}` and a newline. On any failure,
stderr holds one fixed refusal code and the exit status is 1. Nothing else is
printed: no receipts, tracing, service text or token bytes.

The command calls the private IPC method `chaldea_session_headers`, whose input
is exactly `{preset, audience}`, with `audience` one of `jocasta`, `ov`,
`homelab` or `ha`. Unknown fields are refused. The
method is never an MCP tool.

### Session-bound renewal

A supervisor that calls the helper several times over one session, such as a
foreground launcher that refreshes a token file, must not receive a token for
a later session that took over the preset. Two optional forms bind its calls
to the session it started with. The legacy form above and its output are
unchanged.

```sh
# First call: the header and the session it belongs to.
chaldea session headers --preset <preset> --audience jocasta --context
# Every later call: the identity the first call returned.
chaldea session headers --preset <preset> --audience jocasta --context \
  --expect-session <sessionId> --expect-run <runId> --expect-deadline <deadline>
```

The three `--expect-*` flags are given all together or not at all, and only
with `--context`. Stdout is exactly one line and a newline:

```json
{"headers":{"Authorization":"Bearer <jwt>"},"context":{"sessionId":"<id>","runId":"<id>","deadline":1793000000,"tokenExpiresAt":1792998800}}
```

- `sessionId` and `runId` name the admitted session that held the preset at
  the gate check that released this header.
- `deadline` is that run's original absolute deadline, in epoch seconds, from
  its stored admission.
- `tokenExpiresAt` is the released token's verified `exp`, in epoch seconds.
  It is never later than `deadline`, and at release it is at least 30 s away.

The header and the context come from one synchronous gate check, so they
always agree. With `--expect-*`, the service refuses `session_mismatch` when
the preset is held by any other session, run or deadline. It checks before
reading the secret or making a network request, and again after every await,
before a cached or fresh token is released. A cancelled, expired or released
original session gets the gate's ordinary refusal, as in the legacy form. A
stale caller's mismatch does not drop the current session's cached token or
in-flight fetch. A session swap while a shared fetch is out still discards
that fetch for every waiter (`session_changed`), as before.

The context is scheduling information only. It never grants access, extends
the deadline or bypasses any check: every call still passes the full gate.
The cache is unchanged. A call may return the cached token while it has at
least 30 s left, so a caller that wants a fresh token schedules its next call
for less than 30 s before `tokenExpiresAt`. No token is minted in a run's last
300 s (`run_ending`), so access ends before the deadline.

The IPC input forms are exactly `{preset, audience}`,
`{preset, audience, context: true}`, and
`{preset, audience, context: true, expect: {sessionId, runId, deadline}}`.
`context` must be `true`. `expect` requires `context`. The IDs follow the
usual identifier rule, and `deadline` is a positive integer of epoch seconds.
Any other shape is `invalid_request`. A context reply is
`{headers: {Authorization}, context: {sessionId, runId, deadline, tokenExpiresAt}}`.
The CLI checks that shape and the expected identity again before it prints
anything. MCP neither lists it nor forwards it, with or
without a session policy. IPC errors are fixed codes only, never response
bodies, headers, secrets or tokens.

### Enrollment

`enrollments` is an optional top-level policy map keyed by preset ID. Without
it, legacy sessions and waits behave as before. New services require enrollment.
A legacy Jocasta entry keeps exactly these keys and its normalized digest:

- `form`: only `app_password`. This is one ordinary host×profile Authentik
  service account with an app password. The client-secret fallback is not
  implemented, and would need its own review if the primary form fails.
- `issuer`, `tokenUrl`, `jwksUrl`: canonical HTTPS URLs with no credentials,
  query or fragment. The token and JWKS URLs share the issuer's origin.
- `clientId`, `username`: printable ASCII.
- `scope`: exactly `jocasta.read`.
- `resource`: the canonical HTTPS Jocasta resource. The token's `aud` must
  equal it.
- `project`: must equal the preset's project. The preset must grant Jocasta
  access to exactly `project:<project>`.
- `maxTokenSeconds`: exactly 300.
- `secretFile`: a normalized absolute path.

The secret is the ordinary runtime app password. It is read with the existing
`privateFile` rules: a regular file with one link, opened without following
symlinks, owned by the service UID, mode 0600 or stricter. No admin token or
SOPS material is ever read. The public enrollment digest is a SHA-256 over
every field.

### Acquisition

1. The request shape and the gate are checked first. Every refusal (inactive,
   expired, cancelled, changed or narrowed preset, missing enrollment, wrong
   audience) happens before any credential read or network request.
2. The enrollment must match the admitted project. Then the secret file is
   read.
3. The cache is in memory only, with at most one entry per preset and at most
   16 entries. The key covers session, run, thread, preset hash, enrollment
   digest, a digest of the secret's content, audience and run deadline, so
   rotating the secret or editing the enrollment forces a new token. A cached
   token is released only with at least 30 s left, and only right after a
   passing gate check. Expired entries are pruned on each call, without
   timers. Any refusal for a preset drops its entry. Tokens never reach
   SQLite, logs, status, outcomes or files.
4. On a miss, concurrent requests share one fetch. The fetch has an 8 s
   budget for both requests, uses HTTPS only and does not follow redirects.
   The JWKS is fetched first, because it has no side effect. Then one
   unretried `POST` is sent with the form body
   `grant_type=client_credentials&client_id&username&password&scope=jocasta.read`.
   Response bodies, JWKS key counts and the JWT size are bounded. Keys come
   only from the pinned JWKS URL; tokens naming `jku`, `x5u`, `jwk`, `x5c` or
   `crit` are refused.
5. The token is verified with `jose`:
   - RS256 only, with the pinned `iss`.
   - `aud` is exactly the resource.
   - `sub`, `iat` and `exp` are present, and `nbf` is honored when present.
   - `iat` is at most 30 s in the future.
   - `exp − iat ≤ 300`.
   - `scope` is exactly `jocasta.read`.
   - `jocasta_projects` deep-equals `[<admitted project>]`.
   - `exp` is no later than the run deadline (otherwise `token_outlives_run`).

   No fresh token is minted in a run's last 300 s (`run_ending`). A cached
   token whose `exp` fits may still be released then.
6. After every await (the JWKS read, the token request and verification), the
   gate, protected policy, enrollment and secret are checked again. They must
   give the same session, run, thread, preset hash, enrollment digest, secret
   digest and deadline, under a current ceiling. A cancel, expiry, ceiling or
   policy edit, enrollment change or secret rotation while a request is out
   discards the token for every waiter (`session_changed` or the gate's own
   refusal), and caches nothing. A change while the JWKS loads means the token
   request is never sent. An outstanding fetch for an old session is never
   delivered to the next run.

Refusal codes: the gate's codes above, plus `invalid_request`,
`unsupported_audience`, `enrollment_missing`, `enrollment_mismatch`,
`credential_unavailable`, `run_ending`, `issuer_busy`, `jwks_unavailable`,
`token_request_failed`, `token_response_invalid`, `token_invalid`,
`token_claims_invalid`, `token_outlives_run`, `token_expired`,
`session_changed`, `session_mismatch`, `sessions_unavailable` and
`headers_unavailable`. The CLI
adds `config_unavailable`, `service_unavailable` and `invalid_response`.


### Closed service enrollments

A new preset has exactly one service. Use the same flat grant in its `services`
list, admitting ceiling and enrollment. The enrollment has `form:app_password`,
`issuer`, `tokenUrl`, `jwksUrl`, `clientId`, `username`, `resource`,
`maxTokenSeconds:300`, `secretFile`, and the following service fields:

| audience | scope | required explicit arrays | fixed resource |
| --- | --- | --- | --- |
| ov | ov.read | ov_namespaces | https://ov.mcp.ryzhkov.dev/mcp |
| homelab | homelab.read | homelab_services, homelab_hosts | https://homelab.mcp.ryzhkov.dev/mcp |
| ha | ha.read, ha.control, or either combined order | ha_entities, ha_actions | https://ha.mcp.ryzhkov.dev/mcp |
| holonet | holonet.read only | holonet_server, holonet_libraries, holonet_catalog_users, holonet_history_users, holonet_target_users, holonet_actions, holonet_namespace | https://media.mcp.ryzhkov.dev/mcp |

HoloNet is initially one fixed server, one library and one catalog user,
catalog.read only, explicit empty history/target arrays and a fixed namespace.
The operator must qualify the IDs as TV and Movies before activation. No
UserData, playlist/home/collection writes or history follows from this profile.
The grant codec refuses widening; changing server/user/library/namespace is
not a subset. Enrollment equality and existing cache identity bind every field;
same-subject token renewal, rotation, canceled/outdated runs and in-flight
policy changes use the maintained helper gates. Headers remain native-only,
never MCP tools, public reports or model output.

The profile matches the accepted server's scalar media audience, RS256,
300-second lifetime, 30-second skew, ASCII subject1..128 without whitespace,
canonical required grant keys, 4096-byte payload, 8192-byte token and bounded
public RSA JWKS. Alias/unknown HoloNet fields, foreign service grants and
nonempty history/target grants are refused before caching. The helper retains
its stricter minimum remaining token lifetime and end-to-end acquisition budget.
The existing integer-only scanner also requires optional numeric payload metadata
to use nonnegative integer JSON spelling; decimal/exponent coercion is refused.
Synthetic signed-token/renewal/race results do not qualify real issuer,
protected runtime UID, native-client acquisition or deployment. No installation,
enrollment or credential change is part of adding this codec.

No `project` appears in these enrollments or signed service grants.
`preset.project` remains the local admission/accounting domain and must match
one whole ceiling. `projectId` remains the actual reporter T3 project;
`destinations` names allowed caller projects.

OV roots number 1..16, each at most 1024 ASCII characters, with grammar
`viking://resources/(segment/)*segment`. Segment characters are
`A-Za-z0-9_@+.,=-`; dot segments, escaping, wildcards, repeated/trailing
slashes, duplicates and overlapping roots are refused. Ceiling roots contain
equal roots or descendants at a slash boundary. Homelab lists each contain
0..128 unique IDs matching `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`; explicit empty
lists grant nothing. Both components must fit the same ceiling.

HA entities number 1..64, are at most 112 characters, and match
`(light|switch|sensor|binary_sensor)\\.[a-z0-9_]{1,96}`. Actions number 1..3,
with exact unique values `state.read`, `light.control`, `switch.control`.
Reads require `ha.read`; control actions require `ha.control`. Scope,
entities and actions must each fit the same ceiling. Initial rollout remains
`ha.read` with `state.read`. Control needs explicit protected operator grants
and separate live registry/control qualification; this helper adds no actions.

Enrollment and preset scopes and arrays must match exactly, including literal
scope order and array order. Issuer is canonical HTTPS ending in `/`; JWKS
equals issuer plus `jwks/`, and token URL equals issuer origin plus
`/application/o/token/`. New presets use distinct secret paths and ordinary
accounts at an Authentik origin. Different services also use distinct issuers
and client IDs. Presets of the same service may share a provider.

The POST requests the enrollment's full scope without a resource/audience
override. New JWTs require a scalar exact resource audience and deep-equal
signed grant arrays. Missing, null, duplicate, expanded, reordered and known
foreign-service grants are refused. Only HA's two combined scope orders are
equivalent on the signed wire. Subject is bounded but need not equal username.
Homelab and HA allow 10 seconds of skew and require optional `nbf < exp`;
OV allows 30 seconds for future `iat`. All retain the 300-second lifetime,
run deadline, and 30-second release margin. Jocasta's audience representation,
scope/project checks and normalized serialization are unchanged.

The cache identity includes every service discriminator and grant as well as
the existing run, enrollment and secret identities. At most 16 entries/flights
are held. Policy, JWT, JWKS and token-response limits remain 64 KiB, 8192 bytes,
64 KiB and 32 KiB; JWKS has at most 16 keys. Grant maxima do not guarantee a
combination fits these byte limits. Oversize refuses without truncation.
The rendered public policy must fit before activation; fleet preflight remains
authoritative.

Native provider bindings must separately configure each fixed endpoint,
preset and audience through the supported credential-helper mechanism.
Fleet socket routing alone does not install HTTP MCP bindings. Synthetic
fixtures qualify local release behavior only. Real helper acquisition,
renewal, cancellation and endpoint acceptance remain deployment work.

### Residual risks

- The helper is statically bound to a preset by the protected argv in the
  provider instance's MCP configuration and that preset's fixed instance.
  There is no per-run environment seam. The gate exposes the preset's current
  active session. A caller-supplied thread or run ID is not authentication,
  so none is accepted.
- Any same-UID process can call the socket during the active window, or read
  the ordinary secret file directly. Another thread on the same provider
  instance can use the active preset's headers during that window. The shared
  server is not hostile containment.
- The signed token carries no run or thread claim. Binding a token to a run is
  Chaldea release control, not server-side run binding. Jocasta must still
  qualify its own signed-claim contract, and these fixtures do not prove
  Authentik's behavior.
- Revoking the app in Authentik cannot invalidate an offline JWT already
  released or cached. After cancel, revocation or a policy change, a released
  token stays valid at Jocasta for at most 300 s and never past the run
  deadline.
- The provider's helper runs at connection time, and renewal inside a long
  run is not qualified. A long run should fail closed with a 401 rather than
  hold a stale token.

## Known gaps

- Cancellation and deadlines stop issuance and wake the caller, but do not
  interrupt the T3 run. No supported interruption is wired. The slot stays
  held until the run is observed to stop.
- After the slot is released, someone could still type a new message into the
  reporter thread, and that run would use the same provider instance. Its
  header helper is then refused (`no_active_run`), but a token released
  earlier stays valid for up to 300 s. This is a shared-server residual risk.
- Lineage knowledge lasts only as long as session records (42-day retention).
- Rolling back to a binary without sessions after sessions were used would
  meet unknown `session` items. While sessions are unused, the additive
  `sessions` table does not change the journal version, so rollback is safe.
- Before live use, an operator must provide:
  - a preset provider instance with its helper loaded;
  - an ordinary Authentik enrollment and its secret file;
  - live qualification that Authentik issues the expected claims for it;
  - a live check that the wait-service token may call `launchThread`;
  - confirmation that the wait service is deployed on the host;
  - a live launch canary on disposable data.
