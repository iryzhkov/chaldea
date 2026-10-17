# Chaldea access v1

Status: package C source contract; no deployed issuer, keys, trust publisher, sandbox,
or enabled schedule. Authority: step-6 brief
`jocasta:14ce7ddae80badf228ca6ef0779e3f2e@1` §2/§6 and rebuild plan
`jocasta:b264e525acae2b5fa5f4a5376254e35b@18` decisions 9/10 and adopted findings.

## Wire contract

Bearer = compact JWS/JWT, UTF-8 JSON, unpadded canonical base64url, three nonempty
segments; maximum 16 KiB. Ed25519 only, through pinned `jose` (no custom crypto).
Protected header has exactly `{"alg":"EdDSA","typ":"chaldea-run+jwt","kid":"host-key-id"}`.
No unprotected headers, algorithm negotiation, embedded keys, jku/x5u, crit, compression,
URLs to fetch, or fallback to operator credentials. Reject duplicate JSON names
(including escaped names), invalid UTF-8, nesting over 16, and unknown fields.

Payload fields (all required except source/host):

```json
{
  "v": 1, "iss": "chaldea:agent-a", "sub": "daily-health",
  "aud": "homelab", "run_id": "run-unique-opaque-id", "project": "homelab",
  "iat": 1800000000, "nbf": 1800000000, "exp": 1800000600,
  "jti": "random-128-bit-base64url",
  "grants": [{"resource":"host:agent-a","actions":["health.summary","logs.read"]}]
}
```

* `iss` = chaldea: plus lowercase host identifier; `sub` = profile, `run_id` = one-use
  admitted run ID. Project is explicit. Audience is exactly one string from homelab,
  feed, akasha, jocasta, ov, huyang, github-broker; arrays and unknown services fail.
* IDs/actions use ASCII `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`. jti is random 128 bits
  encoded base64url (verifiers accept 22–64 base64url characters). Resource = 1–512
  printable ASCII characters, no whitespace, asterisk or backslash. Resources are
  exact opaque strings: no prefix, glob, regex or implicit parent grants. Each service
  derives a canonical resource and action from its request before verification.
  URI/path normalization and request bounds belong to that service.
* grants = 1–32 distinct resources, each with 1–16 distinct actions. A request needs
  an exact resource/action match in both the token and the issuer ceiling. Reject the
  entire token if any grant exceeds its matching ceiling; combining ceilings to
  construct a larger grant is forbidden.
* feed/akasha additionally require source and host; host must equal the issuer's host.
  The matching ceiling binds source. Other audiences reject those fields. Services
  derive attribution from verified claims, never request-supplied identity. feed's
  action is append/read and resource is the exact source name; future Akasha uses its
  own audience. This version reserves those audiences without deploying a service.

## Time and offline request verification

Timestamps are nonnegative safe integer Unix seconds, not fractional values/strings/bools.
All numbers in signed token/trust JSON MUST use decimal integer literals (0 or a
nonzero digit followed by digits), without sign, decimal point or exponent. Reject
UTF-8 BOMs; field order, whitespace and JSON string escapes remain unrestricted.
Require iat <= nbf < exp and exp - iat <= **780 seconds (13 minutes)**.
Verifier skew is explicitly 0–30 seconds (default 30): iat/nbf <= now + skew,
and now < exp + skew; equality at the expiry limit rejects. Negative/excessive
skew, future issuance, longer TTLs, missing claims and wrong type/key/issuer/audience fail.

Every verification requires a trusted host clock-health sample: healthy=true,
absolute offset <=30 seconds, current boot ID, monotonic time and wall time.
Clock state is durable before returning success. Wall time below the persisted high
water mark, monotonic regression on the same boot, or wall time lagging monotonic
elapsed time by over 30 seconds parks access. A reboot/restart retains wall high
water and requires fresh externally established health; unknown health fails closed.
A caller cannot assert health on behalf of a sandbox. The package does not implement
an NTP monitor. State creation/reset and clock recovery are operator operations. Missing state fails
closed; create it once with the explicit initialize option, which never overwrites an
existing file. Reopening requires the durable format marker; empty, truncated or
uninitialized databases fail closed instead of silently recreating their schema.
An incorrectly healthy forward time jump also parks access after time
corrects; preserve revocations during operator clock recovery rather than resetting
the database.

A copied bearer lasts at most 780 + 30 leeway + 60 seconds of opposite bounded clock
offsets = **870 seconds (<15 minutes)** after real issuance. Ordinary cancellation
disables mint/renew immediately; offline verification cannot learn it instantly.
Optional service denylists can shorten that delay, but are outside v1.

Verify every HTTP/MCP request, replayed receipt, stream operation and reconnect.
`verifyToken` returns claims, a conservative validUntil (no expiry leeway) and
`recheck()`. Service integration MUST cancel sessions/streams and running operations
at validUntil, using a monotonic deadline, and recheck before each operation/chunk and
after waits. Never authorize an unbounded connection at initialization alone.
A concurrent trust installation can return trust_changed; services may retry the
whole verification once against the new bundle, without using the old result.
SQLite waits up to five seconds for shared-state writers. A service may retry once
on SQLITE_BUSY; sustained contention parks access rather than skipping durable checks.
A newly installed bundle or key removal affects the next recheck. The package supplies
the check/deadline; each service owns transport cancellation and bounded work.

## Trust publication, freshness, and rotation

An independent deployment authority publishes a compact Ed25519 JWS with exact
header alg=EdDSA, typ=chaldea-trust+jws, kid naming a separately pinned deployment
anchor. Its payload has exactly:

```text
{v:1, sequence:positive-integer, published_at:unix-seconds, expires_at:unix-seconds,
 keys:[{issuer,kid,public_key:{kty:"OKP",crv:"Ed25519",x:base64url-public-32-bytes},
        not_before,issue_until,verify_until,
        ceilings:[{audience,profile,project,grants,source?}]}]}
```

Maximum envelope 256 KiB, 128 keys, 64 ceilings/key, lifetime 600 seconds.
Empty keys is valid emergency revocation. published_at <= now+30; now < expires_at,
with **no freshness leeway**. Publisher renews independently from run hosts.
Authenticated updater fetches at most every **120 seconds** and calls
`TrustStore.install`; services use only the local durable bundle for requests.
Network failure preserves the existing expiry rather than refreshing it.
Transport/publisher/updater deployment belongs to package F. This library supplies
signing, authentication, installation and offline consumption, without a listener.

Persist the bundle's sequence, exact signed envelope and key history atomically.
Only strictly higher sequence advances state; identical envelope/sequence is an
idempotent retry and never refreshes its signed expiry. Reject lower sequences and
different envelopes at the same sequence, including after restart.
Deployment anchors are configured outside the run and cannot share issuer public keys.
A run issuer has no bundle-publication key and cannot expand its ceiling. Unknown or
removed issuer/kid fails. Trusted bundle files/state and service entrypoints remain
outside sandbox write access.

Keys require not_before < issue_until <= verify_until, with verify_until - issue_until
<=810 seconds. Token iat must be within [not_before, issue_until), exp+30 <=verify_until,
and verification now < verify_until, without retirement leeway. The issuer clamps exp
to verify_until-30. Even a stolen retired signer backdating iat cannot extend authority
past its original window. Under a reused issuer/kid, key bytes and activation are
immutable, issuance/verification deadlines can only decrease, and a removed key can
never reappear. Rotation must use a new kid and new key material. A public key cannot
be shared across host/kid identities or reused from durable history under a new name. Durable history is capped at 4096 IDs;
at capacity, park for an operator-controlled epoch/state migration, never drop tombstones.

Rotation: publish new public key, confirm updater receipts, activate new kid, stop old
issuance, shorten old issue_until to the cutoff and verify_until to at most cutoff+810,
then remove it after outstanding expiry. Emergency removal overrides all overlap.
A compromised active signer is bounded by the independent trust lease: fresh bundles
must remove it; a disconnected verifier fails closed within 600 seconds (+bounded
clock offset), even if the signer keeps issuing fresh bearers.

## Issuer and run lease

`HostIssuer` exists only outside the provider sandbox, under a distinct issuer UID.
`loadHostSigningKey` reads an already provisioned absolute PKCS8 key file using
O_NOFOLLOW, validates regular file/single link/owner/mode 0600 and a private owned
parent directory, and requires Ed25519. It generates no key, reads no credentials
from environment/keyrings, and never exports private bytes. Trusted deployment must
also protect ancestor paths and exclude the issuer UID/key/state from mounts, env,
FDs and model-accessible endpoints. This package cannot establish OS isolation.

`RunLeases.admit` takes a trusted fleet-config/run record with an immutable run ID,
profile, project, deadline and per-audience grants/source. Deadline is at most 24h;
package 3 owns the first report's 10-minute deadline and concurrency-one lifecycle;
this general lease library permits multiple admitted runs. There is no renewal endpoint in the
sandbox. Host code calls renew only for an active lifecycle lease. Each renewal
requires current external admission/profile authorization, may narrow its deadline
and grants, never increase them, and uses fresh trust and clock checks. Denial
persists cancellation. Successful narrowing is durable before releasing the token.

Cancellation/end is an atomic synchronous FULL SQLite commit before acknowledgment,
works even when clock/trust is unhealthy, and is terminal. Renewal checks the durable
revision after asynchronous authorization/signing; concurrent cancellation or renewal
discards the result. Host callers serialize renewals across a run's audiences or retry
run_changed after reauthorization. Admission must commit before the host exposes the
run's cancellation path; cancelling an unknown run fails without acknowledgment.
Unknown, expired or cancelled runs never renew after restart.
No background task recreates admission; the host drives renewal until lifecycle end.
State failure/corruption, disk full or unsafe permissions parks issuance.
All state lives in a private issuer/service directory, with no WAL or token log.
Prune grant payloads after 14 days; retain one-use run ID tombstones. Total capacity
10000 admissions; reaching it parks admissions for an operator epoch migration.
Do not restore an old database backup or reset state to bypass revocation.

## Operator diagnostic CLI

`chaldea access verify --help` describes the offline verifier. It requires explicit
token, signed bundle, deployment anchor, private durable state and clock-health files.
It cannot admit a run or mint a token. The operator uses --initialize-state once to
create new state; later calls require the existing file and cannot recreate it.
Health is read on every clock check, with
checked_at no more than 30 seconds old; Linux boot ID and monotonic time come from
the host. Files must be owned by the operator/root and protected from other writers;
the bearer file must be private. The command outputs only verified identity/deadline,
never the bearer. This diagnostic is not a service endpoint or a sandbox admission API.

## Shared vectors and validation

`test/fixtures/access/v1.json` and the separately frozen `v1-encoding.json` addendum
are immutable inputs, containing public fixture keys, signed
bundles, compact tokens, fixed clock samples/operation and expected accept/reject.
Private fixture keys are not shipped. It includes request vectors and ordered scenarios
for trust freshness, removal, rotation, rollback and restart. Consumers must use the
provided time rather than their current clock. Python reference uses vetted
cryptography Ed25519, never implements primitives. It is test code, not a deployed
Python service verifier. A Go consumer can use crypto/ed25519 and the same JSON cases.
Do not regenerate vectors during ordinary tests; changing v1 is a contract change.

Run `npm run typecheck`, `npm run test:unit`, and `python3
test/fixtures/access/verify.py`. Test coverage includes the brief's token negatives,
lease cancellation/restart/races, stale/removed trust and overlap without old-key revival.
Service/OS/network canaries and multi-host deployment belong to later packages;
passing these vectors alone does not enable a profile.
