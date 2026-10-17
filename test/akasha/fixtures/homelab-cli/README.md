# homelab-cli compatibility fixture

Source: https://github.com/iryzhkov/homelab-cli
Commit: d0b64f63f429bc52022b79d9d36344187ddcfd0a (PR #13, Akasha CLI compatibility).

The following files are copied byte-for-byte from that commit:

- bin/feed
- lib/common.sh
- lib/spool.sh
- lib/contract.py

These are test fixtures, not an installed CLI. Update them together at a recorded
upstream commit; do not patch the vendored files to make a test pass.
The legacy key-file branch uses a disposable loopback legacy HTTP contract fixture.
The scoped token branches exercise the real Akasha server, including helper and
private token-file credentials, idempotency, error exits and scoped open/url refusal.
