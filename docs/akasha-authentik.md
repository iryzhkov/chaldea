# Akasha Authentik coexistence

JWT acceptance is off by default. Existing PKI configuration and producers continue
unchanged. This release adds no Authentik provider or host credentials.

Enable with these Akasha JSON configuration keys (camelCase):

- `authentikEnabled`: boolean, default false.
- `authentikIssuer`: exact HTTPS issuer including its trailing slash.
- `authentikAudience`: exact Akasha resource audience, e.g. `https://akasha.ryzhkov.dev`.
- `authentikJwksUrl`: pinned HTTPS JWKS endpoint; redirects are refused.
- `authentikJwksTtlSeconds`: integer 1–300, default 60.

Issuer, audience and JWKS URL are required when enabled. JWT headers cannot select
a key URL. JWKS must contain RSA keys with `kid`, `use: "sig"` and either no
`alg` or `alg: "RS256"`. Requests time out after five seconds; responses are
limited to 256 KiB and 128 keys. The in-memory cache uses elapsed monotonic time;
expiry and unknown kids cause a refresh. Fetch failure never falls back to stale
keys or PKI. Cached known keys remain usable until cache expiry.

## Claim contract for homelab-infra

The later Authentik application/provider must issue RS256 JWTs containing:

- `iss`: exactly the configured issuer.
- `aud`: exactly the configured Akasha audience (a one-element array also works).
  Tokens with additional audiences are refused.
- `sub`: nonempty Authentik user subject. If opaque, also supply
  `preferred_username: "chaldea-HOST"`. Alternatively `sub` itself can be
  `chaldea-HOST` with no preferred_username. A host-shaped sub must agree.
- `host: "HOST"`: must match that username.
- `iat`, `nbf`, `exp`: required nonnegative integer Unix seconds,
  `iat <= nbf < exp`, `exp - iat <= 300`. Time checks allow 60 seconds skew.
- `run_id`: a stable producer run identifier, 1–128 ASCII identifier characters
  (letters, digits, dot, underscore, colon, hyphen; first character alphanumeric).
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
