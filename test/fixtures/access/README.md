# Access v1 frozen vectors

Authority: [access-v1](../../../docs/access-v1.md). No production keys or secrets.
`v1.json` SHA-256: `5d49ee7b2c8a8e36b25e8f440295b158b4fb8c7fbd73e0c5c252f43f746aee88`.

`v1-encoding.json` SHA-256: `1732273d8d109e4f877ffdb9075d0e6591ff44900f9a52b189885d1fb267436f`.
The encoding addendum fixes the v1 wire grammar before publication: BOMs, decimal-point
or exponent number literals fail; old public key material cannot be renamed/reused.
The 24-hour freshness contract changes only the expected result of the original
`overlong-trust-lease` case: its signed 601-second bundle is now accepted. Its legacy
ID and signed bytes are retained, as are all other original cases.

`v1-freshness.json` SHA-256: `f29c45a95b9a42e199ec0b5214f7caa6ad9b278cb34d8ae7986c2b85fccb4845`.
This contract addendum raises only the maximum bundle lifetime to 24 hours for
single-host outage tolerance. It accepts 23-hour-old trust, rejects 25-hour-old
trust, tests the exact 24-hour cutoff, rejects longer lifetimes, honors shorter
signed expiries, and rejects tokens under an installed empty-keys bundle. Token
lifetime and skew are unchanged. Existing vector IDs and signed bytes remain unchanged.
Both runners consume all three files.

Each fixture was signed once with ephemeral Ed25519 issuer/deployment keys; only
public JWKs and signed messages are retained. Tests never generate/replace vectors.

Top-level fields:
- format: chaldea-access-v1
- anchors: independently configured deployment kid + public_key
- bundle: signed baseline compact trust JWS
- clock: fixed Unix/monotonic seconds, boot ID, health and offset
- operation: audience/resource/action supplied by the service
- cases: isolated cases (name, token, accept), optionally overriding clock, operation,
  bundle or skew. Initialize fresh state, install bundle, then verify token; any
  failure rejects. A null token represents an absent Authorization bearer.
- scenarios: ordered steps in one persistent state, initialized with baseline
  clock/bundle. A step can change clock, install a bundle, verify a token and/or
  restart. accept applies to the operations in that step. Failed installs must leave
  trust/history unchanged. Restart keeps durable clock/bundle/key tombstones.

All times are Unix seconds or monotonic seconds, integers within JSON's safe range.
Token bytes are ASCII compact JWS, signatures cover the original ASCII first two
segments joined by a dot. Ed25519 public keys are raw 32-byte x values in unpadded
base64url; Go can use encoding/base64.RawURLEncoding and crypto/ed25519.
JSON objects reject duplicate keys, even escaped duplicates. Never reserialize the
signed input before verifying. Use fixed fixture clocks; do not consult real time.

Python (test-only reference, independent parser and cryptography Ed25519):

```sh
python -m pip install -r test/fixtures/access/requirements.txt
python test/fixtures/access/verify.py
```

The TypeScript tests exercise the same cases plus actual SQLite reopen, issuer,
lease, permission, race and storage-failure behavior. The Python reference simulates
durable storage with JSON round-trips; service adapters must supply their own durable
storage/clock-health integration. Go service implementations consume this file in
their owning repositories. No Go runtime dependency is introduced into Chaldea.
