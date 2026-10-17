# Access trust runtime tooling (package F, trust slice)

Source only; no deployment or real keys. The [access contract](access-v1.md)
remains authoritative. Commands: chaldea access initialize-state, sign-bundle,
install-bundle, clock-health (each accepts --help). Fleet packaging and exact
future rollout steps: chaldea-fleet-config docs/access-trust.md.
The deployment path contract is `chaldea_access_paths` in
[chaldea-fleet-config inventory](https://github.com/iryzhkov/chaldea-fleet-config/blob/main/inventory/group_vars/all.yml).
The updater config, clock unit and verifier config use its `bundle`, `clock_health`,
`updater_state` and `verifier_state` values. The two databases are distinct;
verifier state is owned by its service in a separate private directory. CLI examples
must use rendered values from this mapping.

The operator signs operator-reviewed public TrustedKey records from fleet-config
access-trust/issuer-grants.json on omarchy-pc. sign-bundle creates published_at
from the healthy clock, defaults to 86400s lifetime and requires an increasing
sequence. Its private AccessState retains sequence/key history through restarts:
TrustStore.install commits before exposing signed bytes. The deployment private
PKCS8 key uses loadHostSigningKey's owner/mode checks. Its public key is the
deployment anchor, never an issuer. No private key belongs in Git or on a run host.

Publish only the resulting compact envelope as access-trust/bundle.jws in the
existing private fleet Git repository. Verifiers fetch main every 120s with their
own read-only deploy key and pinned SSH host key. The byte-only downloader never
checks out or executes remote code. Signature verification uses an independently
pinned Ed25519 deployment anchor; transport credentials cannot grant authority.

install-bundle requires explicitly initialized private state and fresh host clock
evidence. It calls TrustStore.install then atomically replaces the public file.
An updater crash after the state commit is recovered by retrying the identical envelope.
If sign-bundle loses its output after committing state, re-sign with a higher sequence;
its new publication timestamp cannot reuse the committed sequence.
Tamper, rollback/equivocation, removed/reused keys and clock rollback fail closed.
The updater and each verifier retain separate durable state; never restore/erase
their high-water history during application recovery. Serialize publisher signing
and updater installation; run the latter through its systemd oneshot.

Requests use local trust. Fetch failure preserves bytes and signed expiry.
Outage tolerance is the remaining signed lease, at most 24h from publication;
it does not add another day when an outage begins. Renew well inside 24h and
alert before expiry. No fleet host is on another verifier's trust lookup path.
Emergency issuer removal takes effect on installation or cached expiry for a
disconnected verifier; it is not 15-minute issuer revocation. Bearer lifetime and
ordinary cancellation retain package C's bound.

## Clock adapter

The adapter supports systemd-timesyncd and chrony without changing time services.
On active timesyncd hosts it reads NTPSynchronized from timedate1 and NTPMessage /
PollIntervalUSec from timesync1 using bounded, read-only busctl calls on the system
bus. Each subprocess has a 1s timeout and 8 KiB output cap (including chrony
when selected by the default sampler). A cold D-Bus activation timeout may leave
one unhealthy 10s sample; it never produces assumed health. The typed NTP timestamps give offset = ((receive-origin)+(transmit-destination))/2;
each timestamp is in microseconds. It requires synchronization, a valid external
reference, NTP server mode/stratum/leap, a non-ignored packet and a recent measurement.
The layout follows [systemd's D-Bus implementation](https://github.com/systemd/systemd/blob/main/src/timesync/timesyncd-bus.c).
Unknown state or any active-timesyncd query failure writes unhealthy and never falls
back to another daemon. With timesyncd inactive, the retained chrony adapter reads
/usr/bin/chronyc -n -h /run/chrony/chronyd.sock tracking, with no UDP fallback.
Configure independent external sources separately; homelab, omarchy-pc and agent-a
retain timesyncd. No migration or daemon configuration is part of this change.

The adapter atomically writes exactly {healthy,offsetSeconds,checked_at} every
10s into the root-owned 0644 `clock_health` path from that mapping. /run removes
previous-boot evidence; Akasha requires freshness within 30s on every clock check.
Unknown/malformed output, local fallback/no reference, invalid stratum,
non-normal leap status, stale measurements and command failure write unhealthy.
Besides absolute system offset <=30s, it requires the conservative accuracy bound
|offset| + root dispersion + half root delay <=30s. For raw timesyncd packets,
root delay additionally includes the nonnegative client round trip
(destination-origin)-(transmit-receive); the packet's root delay alone only
covers the server's path to its reference. Reference age is limited to
three update intervals, with a 120s floor and 1h cap. See
[chronyc tracking](https://chrony-project.org/doc/4.4/chronyc.html).
The writable directory and adapter never belong in a sandbox.

## Validation and remaining deployment gates

Tests use disposable generated keys and isolated scratch HOME. Coverage includes
byte preservation, tamper/rollback/equivocation, durable key removal, rotation,
exact 24h expiry, unknown/unhealthy/stale clocks, permissions/symlinks, and operator
CLI signing/exclusive initialization. Frozen package C vectors remain unchanged.
No live canary, rollout or Akasha activation is claimed. Protect anchors, ancestor
paths, artifacts and entrypoints from issuer/sandbox writes. Deployment anchor
rotation is explicit operator work, never downloaded from a bundle it authenticates.
