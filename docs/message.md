# Existing-thread messaging over NATS

Source implementation only. No live account, credential, broker configuration,
service activation or fleet deployment is included. The CLI and MCP expose
messaging only when a valid private root-owned sender configuration exists.

    chaldea message targets
    chaldea message send --host laptop --thread THREAD --request-id EPOCHMS:KEY --text TEXT
    chaldea message status --host laptop --thread THREAD --request-id EPOCHMS:KEY
    chaldea message recover --host laptop --thread THREAD --request-id EPOCHMS:KEY

The MCP names are chaldea_message_targets, chaldea_message_send,
chaldea_message_status and chaldea_message_recover. Targets lists configured
host/thread routes without contacting the broker; the receiver ACL remains
authoritative. Status never dispatches. Recover explicitly retries stored original
bytes, or reads status for a terminal receipt. An identical send is also an
explicit retry. Never choose a new request ID to resolve uncertainty.

A broker PubAck means the stream stored a command. An accepted application
receipt means T3 durably queued that message. Neither means an agent read it.
Active work and its provider are preserved. There is no thread creation,
interrupt, restart, model override, raw RPC, callback or automatic sender retry.

## Private configuration

Both JSON files are root-owned regular single-linked files, at most 64 KiB.
Use 0600 for a root process or 0640 with a dedicated read-only profile group;
other access and group writes are refused. Code and runtime must be root-controlled. Configuration readers check file ownership,
mode and link count; they do not establish root control of every ancestor. The
sender default is under the user's XDG/home directories. Enrollment must qualify
those path controls separately; root ownership of the JSON alone is insufficient. Seed, target-local bearer, DB and lock are process-owner
0600; state directories are 0700. Never use operator/job credentials.

Sender default: $XDG_CONFIG_HOME/chaldea/message.json, falling back to
~/.config/chaldea/message.json through the central paths() convention.

    {
      "callerId": "pc-laptop-v1",
      "sourceHost": "omarchy-pc",
      "database": "/home/example/.local/state/chaldea/message-sender/messages.db",
      "broker": {
        "url": "tls://broker.example:4222/",
        "account": "MESSAGES",
        "seedFile": "/home/example/.local/state/chaldea/message-sender/source.seed",
        "publicKey": "EXACT-SOURCE-USER-NKEY",
        "inboxPrefix": "_INBOX_message.pc",
        "commandStream": "MESSAGE_COMMANDS",
        "receiptStream": "MESSAGE_RECEIPTS"
      },
      "hosts": {
        "laptop": {
          "destinationHost": "laptop",
          "environment": "EXACT-T3-ENVIRONMENT",
          "commandSubject": "chaldea.message.command.pc.laptop",
          "receiptSubject": "chaldea.message.receipt.pc.laptop",
          "commandConsumer": "receive_pc_laptop",
          "receiptConsumer": "source_pc_laptop",
          "threads": ["EXACT-EXISTING-THREAD"]
        }
      }
    }

Receiver default: /etc/chaldea/message-receiver.json.

    {
      "host": "laptop",
      "environment": "EXACT-T3-ENVIRONMENT",
      "loopbackT3Url": "http://127.0.0.1:PORT",
      "tokenFile": "/home/example/.local/state/chaldea/message-receiver/t3-token",
      "database": "/home/example/.local/state/chaldea/message-receiver/messages.db",
      "logFile": "/home/example/.local/state/chaldea/message-receiver/events.jsonl",
      "broker": {
        "url": "tls://broker.example:4222/",
        "account": "MESSAGES",
        "seedFile": "/home/example/.local/state/chaldea/message-receiver/receiver.seed",
        "publicKey": "EXACT-RECEIVER-USER-NKEY",
        "inboxPrefix": "_INBOX_message.laptop",
        "commandStream": "MESSAGE_COMMANDS",
        "receiptStream": "MESSAGE_RECEIPTS"
      },
      "callers": {
        "pc-laptop-v1": {
          "sourceHost": "omarchy-pc",
          "publisherKey": "EXACT-SOURCE-USER-NKEY",
          "commandSubject": "chaldea.message.command.pc.laptop",
          "receiptSubject": "chaldea.message.receipt.pc.laptop",
          "commandConsumer": "receive_pc_laptop",
          "receiptConsumer": "source_pc_laptop",
          "threads": ["EXACT-EXISTING-THREAD"]
        }
      }
    }

The supplied unit is a user unit for the dedicated profile user. Replace
/home/example with that user\'s absolute home; explicit JSON paths do not expand
shell variables. Its state/log/token/seed paths must be under the unit\'s writable
~/.local/state/chaldea/message-receiver directory. Alternative root-process
installations need their own separately qualified service policy.

Replace the NKEY placeholders with enrolled U-prefixed public user keys. The seed
must match its configured public key before a connection is attempted. TLS or WSS
is required except for literal loopback disposable NATS. The TLS connection option
is set explicitly and certificate identity is pinned to the configured URL hostname/IP; a tls URL pointed at a plaintext broker is refused. Account names CHALDEA
and SYS are refused. The account label is a root-controlled enrollment binding;
it is not proof of server-side account membership.

At most eight routes/callers and 32 exact threads per route are supported.
Subjects, consumers, public keys and inbox ownership must be unique where checked.
There are no wildcard target/thread grants. Keep a dedicated target-local T3
session with renewal/revocation arranged before activation. Its effective local
authority may be broad; narrower T3 bearer scope is not qualified. The source
receives no T3 bearer. The root-controlled publisherKey records enrollment;
NATS does not attach it to delivered messages.

## Broker enrollment contract

Use one messaging account separate from Akasha's CHALDEA account, with no account
imports/exports into it. Precreate bounded WorkQueue command and receipt streams
and one exact-filtered durable consumer per route on each. The application never
creates, updates or inspects broker administration resources.

For route pc/laptop above, the source user may publish only its exact command
subject, $JS.API.CONSUMER.MSG.NEXT.MESSAGE_RECEIPTS.source_pc_laptop,
$JS.ACK.MESSAGE_RECEIPTS.source_pc_laptop.>. It may subscribe only to its own
_INBOX_message.pc.> inbox. The receiver
user may publish only its exact receipt subjects, corresponding exact
$JS.API.CONSUMER.MSG.NEXT.MESSAGE_COMMANDS.receive_pc_laptop requests,
$JS.ACK.MESSAGE_COMMANDS.receive_pc_laptop.> ACKs.
It may subscribe only to its own inbox. Do not grant generic $JS.API.>, stream or
consumer management, direct stream reads, another caller's pull/ACK/inbox, or
response permissions that permit publishing to arbitrary reply subjects.

Root enrollment must bind each authenticated source NKEY exclusively to its
configured command subject and receipt consumer/inbox. A shared publisher grant
breaks caller authentication. The receiver derives caller/source from the
configured consumer and validates the delivered original subject; it never
trusts a payload caller or a caller-selected pull reply. Destination, environment
and exact thread ACL are checked before T3 reads and rechecked before dispatch.
ACL removal prevents subsequent operations; it cannot recall a queued message.
Source host IP authentication has been replaced by this broker identity/grant
binding, which must be independently checked during enrollment.

The qualification uses NATS Server 2.15.1 and NATS client 3.4.0. Each stream has
1 MiB/256 message limits, at most 32 messages per subject with
discard_new_per_subject=true, 8192-byte maximum message size and at most eight
consumers. Command age is 24 hours; transport receipts expire after 120 seconds
(application receipts remain in SQLite for 42 days). Per-subject limits keep one
quiet caller from filling either shared stream; short receipt age bounds stale
or max-delivered receipt occupancy. Use explicit ACK consumers,
max_deliver 5, max_ack_pending 32, max_waiting 32, max_batch 1 and max_expires 1s.
The fixture uses ack_wait 250ms to exercise redelivery. Production ack_wait
must exceed bounded receiver work (for example 30s) to avoid excess redelivery.
No unlimited default or discard-old command policy is acceptable; use discard-new.
These server settings and exact consumer filters are an operator-verified
precondition; clients intentionally have no management/info authority.

## Durability and lifecycle

The v1 application schema and stable ID domain remain unchanged. UTF-8 commands
are at most 8 KiB, text 4 KiB, generated immutable T3 JSON 8 KiB and T3 response
32 KiB. Unknown fields are refused. IDs bind caller/source/destination/environment/
thread/request. Text is excluded from identity but included in its immutable hash.

The source commits intent before publishing. A fresh transport attempt nonce
correlates receipts without changing application IDs. Concurrent sends can consume
each other's receipts; a bounded SQLite attempt table durably transfers the
matching result after checking mapping, nonce, command ID and message ID.
Transport failure preserves local intent and returns uncertainty with original IDs.
The network exchange has a 35-second deadline, plus short bounded journal
contention waits. CLI/MCP processes sharing a sender store retry only lock/busy
transactions for at most two seconds at a time; they never republish automatically.

The receiver holds its existing nonblocking store lock, persists the attempt and
exact immutable T3 payload before dispatch, and stores the application outcome.
A dispatch-capable command is ACKed only after storing an attempt result and
receiving a PubAck for the receipt. Read-only status needs no attempt row.
Refusals before the durable dispatch barrier publish uncertainty if possible,
then TERM even if publication fails: no T3 effect was possible for that attempt,
and the source journal remains uncertain. If TERM is lost, a later redelivery
can be evaluated afresh; refusal before that barrier is not a durable application
outcome. Redelivery of a stored dispatch attempt
returns its durable result; an attempt interrupted before its result was stored
returns uncertainty without automatic redispatch. Explicit recover/send uses a fresh transport attempt with the same
application IDs and original bytes. Receipt publication or state write failure
after the dispatch barrier leaves the command unacked. Exhausting broker max_deliver is not acceptance:
the source journal remains uncertain and requires explicit recovery.

The existing receiver semantics remain: metadata-only preflight, durable terminal
replay, and uncertainty after a possible dispatch despite later rate/clock/write
failure, missing status or archived target. Only a durable T3 rejection closes a
prior uncertain attempt as rejected. No projection absence proves non-delivery.
Requests dispatch within 24 hours, with five minutes future tolerance and a durable
observed-clock watermark. Rollback over five minutes refuses new dispatch, while
status and terminal replay remain readable.

Each store retains at most 10,000 receipts, 128 unresolved payloads and 16 per
caller, with burst two / ten sends per minute. A 4096-page SQLite cap with 4 KiB
pages and DELETE journal bounds DB plus rollback journal to about 33 MiB. Transport
attempts are capped at 128 per source / 10,000 per receiver / 1,000 per caller
and expire. A separate eight-caller durable request bucket (burst eight,
60/minute, including status) bounds admission before attempt reservation.
The original T3 send bucket remains burst two / ten per minute; terminal
payloads purge immediately, uncertain payloads after 24 hours and receipts after
42 days on operations/receiver maintenance. There is no unbounded local spool.

Run one supervised receiver with chaldea message serve. The source-only unit
packaging/systemd/chaldea-message.service is disabled until separately installed
and enrolled. The loop uses bounded reconnect backoff up to 30s, cancellation,
one-second pulls with a five-second subscription timeout, bounded T3 calls and
minute maintenance. The larger timeout covers broker round-trip margin;
subscription timeout retries are empty pulls. Caller delivery failures back off
independently; connection loss reconnects the supervised loop. Malformed poison is
terminated without T3 dispatch. Fixed event categories use the existing bounded
10 MiB / 14-day log helper; bodies, seeds, bearers and raw exceptions are not logged.
Broker failure has no dependency in local waits, exec or same-host T3 operations.

Stores must be initialized explicitly as their owner using
MessageStore(database, receiverBinding(config), true) or senderBinding(config).
There is no remote initializer. Missing/corrupt/misbound state refuses service;
never reset a journal to resolve uncertainty. Restore consistent DB/clock state,
or retire grants and use a new environment. Reinitializing the same environment
requires draining old receivers and waiting over 24 hours plus five minutes with
healthy time. No deployed SSH messaging state exists to migrate.

Rotation/revocation now requires broker NKEY enrollment and exact grant/inbox/
consumer mapping, private seed replacement, root config update and receiver
restart/reconnect. Revoke old broker credentials and verify existing connections
are evicted. Preserve journals/IDs during rotation. Broker credentials do not
replace target-local T3 token custody/renewal or application thread ACLs.

## Qualification boundary

test/message/run.sh asserts isolated HOME/TMPDIR, verifies the pinned official
NATS archive checksum and existing official T3 pin, then exercises the actual
sender/receiver against loopback disposable NATS and real T3 with a fixture provider.
Coverage includes concurrent reverse receipts, stable-ID replay/restart, interrupted
state writes, lost receipts, exact grants/original-subject identity, poison/capacity,
expiry/clock/ACL gates, reconnect/stop and independent local work during outage.
The test account, keys and processes are deleted. No production service is used.

The isolated transport fixture separately verifies positive TLS and WSS using a
scratch trusted certificate, hostname mismatch and untrusted-certificate refusal,
unenrolled/revoked NKey refusal, replacement acceptance and eviction of established
TLS/WSS connections on broker authorization reload. It uses the production
connection function and Node's trusted CA configuration, with verification enabled.
This does not qualify the canonical reverse proxy, live certificate chain or
operational key custody. Its redacted message-transport-proof.json records the boundary.

Live TLS/WSS, broker HA, operational credential revocation/rotation, deployed
service hardening, T3 token renewal and backup/restore remain unqualified. Account,
stream and credential provisioning are separate authorized operations. A green
source test or historical SSH qualification does not authorize fleet activation.
