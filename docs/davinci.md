# Da Vinci runtime (disabled source)

Run an explicitly configured instance with chaldea davinci serve --config
/etc/chaldea/davinci-coordinator.json, or its worker configuration. There is no implicit
config, enrollment, installation or enabled definition. The coordinator has no T3/provider
credential. The worker uses the existing private waits socket, protected session policy and
supported credential helper/issuance. This source does not authorize activation.

## Contract and policies

One protected definition binds worker, T3 environment, authority epoch, preset hash and
published source commit. The preset hash covers the existing fixed profile/project/model/
options/prompt/inputs/grants. The worker reloads that root-owned policy immediately before
admission and requires the same hash. FATE-selected model/options belong in the qualified
protected preset. Webhooks and broker deliveries cannot select execution choices.

Only a daily HH:MM UTC schedule is supported; other cron/timezone forms reject. Cursor and
immutable occurrence commit in one SQLite transaction. Missed occurrences older than
60 seconds skip without a catch-up burst. Overlap skips while an earlier assignment is
unresolved, uncertain or occupies its native slot. Disabled definitions reject new work,
preserving committed assignments and receipts. The protected preset controls session
deadline. Assignment admission expires after five minutes. A possibly committed admission
never closes or reruns merely because that window elapsed; it remains uncertain until
the original read-only lookup finds its session.

Schedule and webhook work use the same assignment path, one fixed worker and stable request
IDs. Each side commits ownership before its next effect. Broker PubAck is transport custody,
not application success. A bound monotone result receipt travels back on the assignment subject
after coordinator journal commit. Worker terminal pruning requires that application receipt;
transport PubAck alone is insufficient. Result ACK follows durable coordinator commit, which
also persists the pending custody receipt. The existing journal replays receipts before any
assignment retransmission. A full command stream therefore cannot hold result-stream capacity. Monotone observation
sequences prevent reordered results replacing newer state. Results buffer locally during
broker outage. Admission owns native continuations, children, questions, quota pauses and
occupancy. Da Vinci copies those status/outcome fields without treating a completed provider
turn as completion, answering approvals or moving uncertain work.

Private IPC adds only chaldea_session_lookup with the existing exact input
{threadId,requestId,preset}. It reads the matching durable request even after replay age,
returning status or null without admission or an active preset. Changed payloads conflict.
Past the assignment deadline the worker only observes, including an assignment first delivered
after outage. It records that delivery, looks up the original request without admission and
returns expired only when it has no prior ambiguous attempt and no native session. Fresh clock
checks after lookup and immediately before admission prevent an awaited read crossing the deadline.

Journals have a local flock owner, SQLite WAL/FULL, 512 rows and a 31 MiB database-page bound.
Each cycle checkpoints WAL; refused checkpoints defer effects. No NFS journal. Closed rows
retain 14 days from closure; workers retain terminal outcomes until the coordinator application
custody receipt is committed and its confirmation has broker custody. Coordinators retain
closed outcomes until the worker confirms observing their receipt. Lost receipts remain replayable
through retention expiry. An already-retired worker row may reconfirm that it has no local
custody obligation, using the authenticated coordinator receipt, without recreating work.
For a retained row, every valid current-sequence receipt durably re-arms confirmation, even
if the previous confirmation received PubAck and expired before coordinator recovery.
The coordinator still owns the result. Active/uncertain ownership never expires or yields capacity. Full storage
refuses new work. Original admission time stays in webhook delivery IDs, so re-signing a
pruned old identity cannot create a fresh admission. Clock rollback refuses mutation.

## Protected configuration

Both configs must be root-owned, private, under root-owned nonwritable ancestors.
Common required fields:
- role: coordinator or worker.
- database and logFile: separate absolute local private paths per role.
- definition: id, worker, environment, epoch, preset, presetHash (64 lowercase hex),
  source (40 lowercase hex published commit), notBefore (epoch milliseconds), utc (HH:MM),
  enabled (initially false).
- broker: url (TLS/WSS origin with trailing slash, or literal loopback NATS for fixtures), account DAVINCI, seedFile,
  publicKey, inboxPrefix beginning _INBOX_davinci., commandStream and receiptStream.
- mapping: commandSubject beginning chaldea.davinci.assignment., receiptSubject beginning
  chaldea.davinci.result., commandConsumer and receiptConsumer.

Coordinator adds port (1024..65535, literal loopback listener) and keys (one or two key-ID
to secret-file paths). It has no socket/caller/policy. Worker omits port/keys and adds socket
(existing private waits socket), caller (operator-chosen existing wake destination), policy
(existing protected session policy). The caller is not authority. Same-UID ingress prevents
accidents; it is not hostile-code confinement. Stable bindings cannot change on live reload;
enabled and signing-key references may change.

DAVINCI must be isolated from CHALDEA, SYS and messaging. Reuse existing NKey/TLS/WSS
connection and exact pull/ACK helpers with normal CA verification. Coordinator publishes only
its worker subject and consumes only results; worker has reverse rights. No management API,
arbitrary inbox, Akasha seed or messaging rights. Provision before producers: file-backed
workqueue streams, discard-new, explicit ACK, finite bytes/messages/pending/age and at least
16384-byte result messages. No wildcard fan-out or multiple consumers. Publish failure retains
local state. Canonical ACL/TLS/WSS/rotation/eviction and sizing require operator qualification;
the fixture's 32-row/8-KiB streams are not production sizing.

## HTTP signing and rotation

Ingress binds loopback; HTTPS ingress/firewall are external operator changes. POST /webhook
accepts exactly {"job":"source-status"} (4 KiB transport cap). GET /jobs/<64-hex-id> reads
assignment plus latest session/thread/result. GET /schedule reads cursor and last skip.
GET has an empty body and never triggers recovery/admission.

Every request carries Davinci-Key, Davinci-Delivery, Davinci-Time and Davinci-Signature.
Delivery is <13-digit original epoch-ms>:<1..80 ASCII identifier>; time equals that original
prefix. Signature is hex HMAC-SHA256 over the concatenation:
key-id + newline + delivery + newline + time + newline + METHOD + space + exact-path +
newline + body. Method/path binding prevents signature reuse at another endpoint.
Secret files hold 64 lowercase hex characters (32 random bytes), service-UID owned0600.
No provisioning/renewal command is introduced. Five-minute freshness plus durable original
identity bounds replay. Retries preserve original ID/time/body. Root config can name current
and previous IDs (maximum two). Removing an ID revokes it on the next request; rotate to a
new ID. Errors and logs use fixed categories.

## Recovery, restore and activation boundary

A supervisor restarts the same local journal/config. Owned work continues observation while
coordinator/broker is absent. Do not delete journals, reassign active work, reset epochs or
initialize replacements because a heartbeat is missing.

Backup restore is an operator action, never automatic takeover. Disable intake and fence
the previous coordinator first; preserve worker/admission journals and reconcile all committed/
uncertain assignments. Root-controlled epoch/notBefore are the authority fence, not restored
journal claims. Old-epoch assignments and a backup opened against a new epoch refuse. Never
restore all fence copies together or reuse a lost epoch. There is no automatic migration across
epochs: retain old databases for reconciliation before an authorized fresh generation.
Single-host restart evidence is not HA or multi-worker failover qualification.

Before install/enrollment, prepare a reviewed packet with immutable release/source pins,
exact coordinator/worker UID and supervisor commands, state/backup paths/capacity, protected
preset/profile/source/hash and FATE options, broker streams/ACLs/TLS/revocation/eviction,
supported local issuance, HTTPS/signing-key custody, read-only confinement, restore fence and
rollback. Actual authority must cover the named hosts/network/credentials. M1, M2 and existing
shared admission live qualifications remain prerequisites relevant to the canary. Stop new
intake on failure and retain uncertain ownership. No live host was changed.

## Evidence

runtime.test.ts covers cursor rollback, policies, bounds, stale epoch, expired lost answers,
revoked qualification, read-only HTTP, rotation and result reorder. service.test.ts exercises
actual coordinator/worker loops with isolated real NATS and synthetic admission IPC; this
does not qualify a live T3/profile. The official-T3 admission.test.ts separately proves
durable lookup, protected admission, acknowledgement loss, restart/continuation and one
result/wake. Fixtures distinguish actual checks from assumptions.

Run through chaldea exec --host agent-a --artifact davinci-runtime.json
--artifact davinci-proof.json --artifact davinci-restarted.json -- sh test/davinci/run.sh.
HOME/TMPDIR are asserted disk scratch. Source qualification is not deployment or live canary.
