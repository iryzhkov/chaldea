# Akasha Authentik coexistence

JWT acceptance is off by default. Existing PKI configuration and producers continue
unchanged. This release adds no Authentik provider or host credentials.

Enable with these Akasha JSON configuration keys (camelCase):

- `authentikEnabled`: boolean, default false.
- `authentikIssuer`: exact HTTPS issuer including its trailing slash.
- `authentikAudience`: exact Akasha resource audience, e.g. `https://akasha.ryzhkov.dev`.
- `authentikJwksUrl`: pinned HTTPS JWKS endpoint; redirects are refused.
- `authentikJwksTtlSeconds`: integer 30–300, default 60. It may not be shorter than the 30 s JWKS refresh cooldown.

Issuer, audience and JWKS URL are required when enabled. JWT headers cannot select
a key URL. JWKS must contain RSA keys with `kid`, `use: "sig"` and either no
`alg` or `alg: "RS256"`. Requests time out after five seconds; responses are
limited to 256 KiB and 128 keys. The in-memory cache uses elapsed monotonic time;
expiry and unknown kids cause a refresh. Concurrent refreshes share one fetch.
A 30-second monotonic cooldown after every completed fetch attempt, successful or
failed, prevents further fetches. Unresolved keys and expired caches are rejected
during the cooldown. Fetch failure never falls back to stale keys or PKI.
Cached known keys remain usable until cache expiry.

## Claim contract for homelab-infra

The later Authentik application/provider must issue RS256 JWTs containing:

- `iss`: exactly the configured issuer.
- `aud`: exactly the configured Akasha audience (a one-element array also works).
  Tokens with additional audiences are refused. Authentik defaults to the OAuth2
  client_id as audience; homelab-infra must override `aud` with a scope mapping.
- `sub`: nonempty Authentik user subject. If opaque, also supply
  `preferred_username: "chaldea-HOST"`. Alternatively `sub` itself can be
  `chaldea-HOST` with no preferred_username. A host-shaped sub must agree.
- `host: "HOST"`: must match that username.
- `iat`, `exp`: required nonnegative integer Unix seconds. Optional `nbf`
  defaults to `iat`; if supplied, it must also be a nonnegative integer.
  Require `iat <= nbf < exp` and `exp - iat <= 300`. Time checks allow 60 seconds
  skew. Omit a custom `nbf` mapping unless it can guarantee `nbf >= iat`.
- `run_id`: a stable identifier per host account, not per run, with 1–128 ASCII
  identifier characters (letters, digits, dot, underscore, colon, hyphen; first
  character alphanumeric). Provenance `run_id` and compatibility `jti` therefore
  repeat across requests and runs for that host; neither is a unique run ID.
- Optional `source`: a signed source selector. If supplied, it must match the
  request's selector. It never supplies grants.

Each request selects its registry source using the `X-Akasha-Source` header,
or the signed `source` claim if the header is absent. A host token can select
only sources already registered to that host. Profile, project, source_id, kinds,
roots and read scope come from the registry, ignoring JWT grant-like fields.
Report registrations permit append only; service/operator registrations retain
their existing read scope. Route cross-host score reads require route_scores_read.
Event provenance retains the registry issuer/profile/project/source_id across the
migration. The internal access.claims compatibility view is normalized registry
metadata; it is not the original Authentik claim set.

A registry entry may set `revoked: true` to deny JWT access to every source for
that host. Unknown hosts have no authority. This flag does not alter PKI handling.
Authentik must refuse issuance for inactive/revoked host accounts; existing JWTs
remain valid until expiry plus skew (at most 360 seconds with healthy clocks).
There is no online epoch lookup or strict clock rollback guard for JWTs (R1).
PKI trust initialization and background service machinery remain during coexistence.

JWT and PKI formats choose one verifier: `typ: "chaldea-run+jwt"` goes to the
existing PKI verifier; other compact JWTs go to the optional Authentik verifier.
Signature or claim failures never try the other verifier.
