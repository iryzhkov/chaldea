# Fleet quota accounts

Capacity belongs to a provider and an account. The public key is
`<driver>:<sha256(account-or-organisation-id)>`. Account IDs come from a
provider response. Tokens, email addresses, hostnames and credential paths
never form an account key. A host is observation provenance only.

Codex's read-only app-server exchange is initialize, initialized,
`account/read {refreshToken:false}`, then `account/rateLimits/read`.
Identity prefers rateLimits' accountId, which T3 uses for its workspace binding,
then falls back to an ID from account/read. If account/read is unsupported,
the rateLimits read still runs.
If neither response supplies an ID, observations remain local and are not
published. Claude uses the organisation/account ID in the usage response or
a GET of the OAuth profile endpoint when usage omits identity. Both requests
are GET only. Missing identity also keeps Claude observations local.

## Host configuration

Every host with a login can collect it, independently of omarchy-pc.
Render one context per account in that host's `quota.json`. Existing Codex
contexts remain supported. Claude contexts opt in individually.

```json
{
  "contexts": [
    {
      "providers": ["codex"],
      "home": "/home/igor",
      "codexHome": "/home/igor/.codex",
      "assertRuntimeHome": true,
      "accountKey": "ACCOUNT_HASH_FROM_VERIFIED_PROVIDER_RESPONSE"
    },
    {
      "providers": ["codex-work"],
      "home": "/home/igor",
      "codexHome": "/home/igor/.codex-work",
      "accountKey": "SECOND_ACCOUNT_HASH"
    }
  ],
  "claudeContexts": [
    {
      "enabled": true,
      "providerInstanceId": "claudeAgent",
      "credentialFile": "/home/igor/.claude/.credentials.json",
      "accountKey": "VERIFIED_ORGANISATION_HASH"
    }
  ],
  "fleet": {
    "enabled": false,
    "url": "https://AKASHA_INGRESS",
    "tokenHelper": "/usr/local/bin/chaldea-token-helper",
    "host": "agent-a",
    "cacheFile": "/home/igor/.cache/chaldea/quota-fleet.json"
  }
}
```

The illustrative hashes must be replaced with 64 lowercase hexadecimal
characters. The accountKey assertions are optional for collection and checked
against provider-returned identity. Before the first identity observation,
routing trusts the operator assertion; a mistyped assertion can bind another
account's capacity. A reported identity mismatch excludes the local instance.
A T3 alias cannot appear in both a Codex and a Claude binding. Several aliases
for the same account share one account capacity record. Existing runtime-HOME checks and asserted-binding
visibility remain in force for Codex.

T3 currently exposes one usable instance per provider in Igor's configuration.
A second account needs a second provider instance, such as codex-work or
claude-work, with a separate login/runtime home in T3. Set its exact instance ID
in that account's context. No synthetic instance is invented from a remote host
alias. Routing only considers models and options present in the local live
catalog and returns both providerInstanceId and accountKey for identified
accounts, including alternatives. Unknown legacy accounts retain local routing
behavior until identity is available.

The observer collects Claude even when T3's Claude usage windows are unsupported.
The credential reader refuses symlinks, nonregular/oversized files and expired
tokens, never refreshes or writes credentials, and emits no credential/error
prose. The usage/profile collection cycle runs at most once per five minutes
per credential path, across observer and route processes, including failures.
Caches retain only a hashed identity and sanitized windows, mode 0600.
A failed collector preserves its last successful observation until stale.

## Shared snapshots and fallback

The fleet switch is off by default. When enabled, the observer publishes one
combined quota_headroom_snapshot per host per 15-minute bucket through
POST /api/v1/events. Persistent reservations, a process lock and the immutable
key capacity:HOST:BUCKET bound publication to four records per aligned hour,
including failures and observer restarts. This replaces the old combined feed
snapshot in shared mode; changed/low and stop/resume records keep their existing
behavior. There is no per-account publication fan-out or per-route feed record.

The closed capacity schema permits at most 32 accounts, eight native windows
per account, and 40 KiB total. It contains provider, account hash, native
windows, credits, reset inventory, asserted credit expiry, active-stop state,
observation time and staleness bound. It rejects unknown fields. It never
contains tokens, raw account/organisation IDs, email, credential paths, T3
aliases, provider payloads or diagnostic prose. Akasha validates this schema
and binds the snapshot host to the authenticated host.

Routing reads GET /api/v1/events filtered to source quota, snapshot kind and the
last 15 minutes. It accepts only verified events with matching envelope and
snapshot hosts. Reads are bounded to four pages of at most 1,000 events and
2 MiB each; incomplete pagination falls back to the local observer. Both
read and append use a fresh R7 helper token. A missing helper, denied request,
unreachable store or stale shared snapshot leaves local routing available.

Merge uses the freshest observation per provider/account, never the host or
local instance alias. Future observations and snapshots past their own
maxAgeMs are ignored. maxAgeMs cannot exceed 15 minutes. Ties choose the
lexically first host, so read order does not change the result. Packaging uses
the oldest observation timestamp among the metrics it includes, so publishing
cannot rejuvenate an old wallet or window. Local active usage stops still
block that local instance. Output reports the winning host and age in seconds.
Shared observations carry no burn history; timed reset/refill projections
remain conservative where local history is unavailable.

Route configuration may set quotaConfigFile to an explicit quota.json.
Otherwise routing loads the usual quota config for that host. Capacity reserve
settings for identified accounts use provider:accountKey keys in capacity.json;
legacy unidentified local observations still use instance aliases.
The observer publishes credit expiry from its host's default capacity.json.
A route-only capacityConfigFile override affects that route, not the observer's
publication. Fleet-config must render expiry in the observer's capacity.json.

## Codex credit policy

Fresh positive Codex credits, including a tiny final balance, classify as
unlimited. No credit conversion, quota projection or reserve floor is required.
Credits expiring within expiryHorizonMs, default 24 hours, classify as use-it.
Expired, stale or zero credits add no capacity. An active usage stop still
classifies as stopped. This is routing advice; Chaldea does not purchase,
redeem or spend credits itself.

## Activation follow-ups

No deployment is included. Fleet-config must render the per-host, per-account
contexts and matching local T3 instance mappings, enable approved Claude
collectors, and later enable fleet publication/reads. Keep fleet.enabled false
until the helper and Akasha registrations are ready.

For each producer host, Akasha needs a registry entry with issuer
chaldea:HOST, source quota, unique source_id quota-HOST, host HOST,
profile quota-service, project chaldea, mode service, and the required quota
kinds including quota_headroom_snapshot. Set quota_fleet_read:true on that
entry to permit reading only quota snapshots in the same source/profile/project
across hosts. This grants no global reads, other event kinds or foreign receipts.
The helper needs explicit producer-UID grants for audience akasha, source quota,
host HOST, kind quota_headroom_snapshot, separately for append and read.
The issuer's signed ceilings must permit those actions. Existing stop/resume
and changed/low publishers need their own kind selectors and grants when enabled.
Source registration, grants, helper installation, service-side activation and
host rollout remain operator work. No host was updated by this change.
