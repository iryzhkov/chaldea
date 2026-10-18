# Existing-thread messaging over restricted SSH

Source milestone only. No user, key, grant, fleet role, release or deployment is
created by this change. Messaging is absent from CLI/MCP discovery without a valid
local root-owned sender configuration with a nonempty thread list. Local lists
only narrow visibility; only the target receiver ACL grants access. Any process
holding the pair key can exercise its caller's exact host/profile grant.

Send a marked, queued message with a stable request ID. Status never dispatches.

    chaldea message send --host laptop --thread THREAD --request-id EPOCHMS:KEY --text TEXT
    chaldea message status --host laptop --thread THREAD --request-id EPOCHMS:KEY

accepted means T3 durably queued the message, not that an agent read it. Active work
and the selected provider are preserved. There is no restart, interrupt, create,
model override, raw RPC, recover endpoint or automatic retry. Resolve a lost reply
with status. An explicit identical send may replay the original command within
24 hours. Never invent a new ID to resolve uncertainty.

## Configuration and custody

Sender default path is ~/.config/chaldea/message.json. It must be root-owned,
not group/other writable, regular, single-linked and at most 64 KiB.

    {
      "callerId": "pc-operator-laptop-v1",
      "sourceHost": "omarchy-pc",
      "database": "/var/lib/chaldea-message-sender/messages.db",
      "hosts": {
        "laptop": {
          "destinationHost": "laptop",
          "environment": "EXACT-T3-ENVIRONMENT",
          "address": "192.0.2.20",
          "port": 22,
          "keyFile": "/home/USER/.config/chaldea/message-laptop-key",
          "knownHostsFile": "/etc/chaldea/message-known-hosts",
          "threads": ["EXACT-EXISTING-THREAD"]
        }
      }
    }

Receiver fixed root-owned configuration is /etc/chaldea/message-receiver.json:

    {
      "host": "laptop",
      "environment": "EXACT-T3-ENVIRONMENT",
      "loopbackT3Url": "http://127.0.0.1:PORT",
      "tokenFile": "/var/lib/chaldea-message/t3-token",
      "database": "/var/lib/chaldea-message/messages.db",
      "callers": {
        "pc-operator-laptop-v1": {
          "sourceHost": "omarchy-pc",
          "sourceAddresses": ["192.0.2.10"],
          "threads": ["EXACT-EXISTING-THREAD"]
        }
      }
    }

No DNS, URL, executable or argv comes from the wire. Root controls executable,
runtime, configuration and their ancestor directories. The dedicated
chaldea-message UID has no operator groups, job keys, sudo or writable code/config.
Its login home and authorized_keys are root-owned. State directory is UID-owned
0700; bearer, DB and lock are UID-owned 0600. Use a dedicated target-local T3
session, with renewal/revocation arranged before activation. Its effective
authority may include broad local operate access; --scope narrowing is unproven.
No bearer crosses SSH. Do not forward credentials into jobs.

Missing, empty, corrupt or incorrectly bound receipt state refuses service.
An operator must initialize each store explicitly before enrollment, using
MessageStore(database, receiverBinding(config), true) or the senderBinding
equivalent in a local root-controlled provisioning action running as the store
owner. initialize uses exclusive creation and refuses an existing file. There is
deliberately no remotely reachable initialization command. After loss, restore a
consistent receipt DB and clock watermark from backup, or explicitly reinitialize
with a new environment and retire old grants. For the same T3 environment,
disable old grants, drain receiver processes and wait more than 24 hours plus
five minutes with verified healthy time before explicit reinitialization. Never
recreate a receiver DB while old IDs can still be eligible for dispatch. This is the lead's correction to the reduced review suggestion.

## Native launcher and SSH policy

Build host/chaldea-message-launcher.c statically with the target architecture's
compiler and libc static archives. The standard npm test suite now requires
cc, static libc development archives and readelf. CI qualifies Ubuntu x86_64;
aarch64 and other target architectures still need their own qualification.
Static glibc can process GLIBC_TUNABLES before main, so production AcceptEnv must
exclude GLIBC_*, LD_*, MALLOC_*, SSH_* and other runtime controls:


    cc -static -O2 -Wall -Wextra -Werror -o chaldea-message-receive host/chaldea-message-launcher.c
    readelf -l chaldea-message-receive
    readelf -d chaldea-message-receive

Require no PT_INTERP and no NEEDED entries. Install this root-owned 0755 binary as
BOTH the account's login shell and /usr/local/libexec/chaldea-message-receive.
A normal shell would evaluate BASH_ENV or ENV before a forced-command script.
A dynamic executable could evaluate LD_PRELOAD before main. The static login
shell accepts only -c followed by the exact forced-command prefix and one
restricted caller ID. It calls execve directly with a fixed Node, receiver and
configuration path, and only PATH, SSH_ORIGINAL_COMMAND and SSH_CONNECTION.
It sets a 20-second lifetime, private umask and zero core limit.

Defaults are /usr/bin/node, /usr/local/lib/chaldea/src/message-receiver.ts and
/etc/chaldea/message-receiver.json. MESSAGE_NODE/MESSAGE_RECEIVER/MESSAGE_CONFIG
compile definitions select fixed reviewed installation paths. The installed
receiver must include its pinned dependencies or a qualified bundle. Node's
path, code and dependencies must remain root-controlled. Static binaries are
architecture/libc-specific and need qualified compiler updates. This milestone
adds source and qualification only, not host artifact packaging or distribution.

Use a new per-source/destination/profile Ed25519 key, never an operator or build
key. Enroll exactly one root-controlled line per public key, rejecting duplicate
keys and principals before writing:

    restrict,from="192.0.2.10",command="/usr/local/libexec/chaldea-message-receive --caller pc-operator-laptop-v1" ssh-ed25519 PUBLICKEY

Global sshd policy must have PermitUserEnvironment no. It is invalid inside Match.
Do not attempt to clear AcceptEnv, which is additive. The native launcher cleans
even explicitly accepted hostile environment. Refuse activation if
/etc/ssh/sshrc exists, since sshd can run it through /bin/sh before this launcher.
Require the effective AcceptEnv set to allow only the needed locale variables,
with no SSH_* or runtime/loader controls. Inspect all startup paths. The fixture
deliberately accepts hostile runtime variables to stress the static launcher,
asserts no system sshrc, and refuses client-supplied SSH identity variables.

Use the ordinary daemon with the account-specific restrictions below. Verify
sshd -t and sshd -T -C user=chaldea-message,addr=SOURCE,host=SOURCE. Effective
ForceCommand must be none because it would override the per-key caller binding.
Existing AllowUsers/AllowGroups must admit the dedicated UID.

    PermitUserEnvironment no
    Match User chaldea-message
      AuthenticationMethods publickey
      PubkeyAuthentication yes
      PasswordAuthentication no
      KbdInteractiveAuthentication no
      HostbasedAuthentication no
      GSSAPIAuthentication no
      AuthorizedKeysFile /etc/chaldea/message-authorized-keys
      AuthorizedKeysCommand none
      TrustedUserCAKeys none
      AuthorizedPrincipalsFile none
      PermitUserRC no
      PermitTTY no
      DisableForwarding yes
      AllowAgentForwarding no
      AllowTcpForwarding no
      AllowStreamLocalForwarding no
      X11Forwarding no
      PermitTunnel no
      PermitOpen none
      PermitListen none
      MaxSessions 1

The sender uses /usr/bin/ssh with -F /dev/null, an explicit pair key and host-key
pin, no agent, no multiplexing, no forwarding or PTY, no proxy or local command,
a 10-second connection timeout and 35-second attempt timeout. It sends only the
literal protocol command chaldea-message-v1. The receiver rejects shell, suffix,
whitespace, SCP and subsystem commands, checks the actual SSH source address and
fixed caller argument, and checks destination/environment/thread ACL before
reading the bearer or any T3 metadata. It re-reads the ACL before dispatch.
Removing an ACL prevents the next operation, including replay of an accepted
receipt. A message already queued cannot be recalled.

## Protocol and durability

One JSON object then EOF, v=1, op=send or status, host, environment, threadId,
requestId, plus text only for send. Unknown fields are refused. Duplicate JSON
keys follow deterministic JSON.parse last-wins semantics; hashes use validated
fields. Wire is at most 8 KiB, text 4 KiB, generated T3 JSON 8 KiB and response
32 KiB. Errors are fixed categories, never raw exceptions, bodies or tokens.
The receiver buffers only after taking a nonblocking store lock. EOF has five
seconds; local T3 calls have five seconds; receiver lifetime is twenty seconds.

IDs hash length-prefixed domain/caller/source/destination/environment/thread/
request fields. Text is excluded from identity but included in the immutable
request hash. Changed text with the same identity conflicts. Caller identity
comes only from the restricted key's root-controlled command and ACL.

Sender commits intent before SSH. Receiver commits exact immutable T3 JSON before
any dispatch. Crash or unknown transport/T3 result is uncertain. Accepted and
durably rejected replay returns the matching stored result after ACL checking.
A rate/clock/write refusal, missing status, or missing/archived target after a
prior possible dispatch remains uncertain. Only a durable T3 rejection can close
a prior uncertain attempt as rejected. Refusing an attempt now does not establish
whether an earlier attempt reached T3.
No fallback ID, background worker or resend loop exists. The T3 preflight reads
only shell metadata after ACL acceptance, refusing absent/archived/deleted
threads; it does not request a transcript.

The real pinned official T3 0.1.0 qualification asserts successful direct RPC
replay, one message, queued active work, unchanged model and replay after restart.
This proves the tested receipt contract, not infinite replay after hypothetical
upstream receipt compaction. Projection absence after compaction never proves
non-delivery. Chaldea's receiver receipt is authoritative for terminal replay.

Requests dispatch only within 24 hours, with five minutes of future tolerance.
A durable observed-wall-time watermark refuses dispatch after rollback over five
minutes. It is NOT the latest request timestamp. Distinct valid out-of-order
requests remain accepted. This is the second lead correction to the reduced
review. Status and terminal replay remain readable during rollback.

Each store has at most 10,000 receipts, 128 unresolved payloads, 16 per caller,
eight current rate buckets and a 4096-page SQLite cap. SQLite defaults to 4 KiB
pages, enforced at initialization, so main DB is at most 16 MiB and a DELETE
rollback journal at most about 16 MiB plus headers. FULL synchronous transactions
and no WAL bound idle retained storage below 33 MiB per store plus the single
small lock. A smaller existing max_page_count is never enlarged by data growth.
Disk/write failures refuse before dispatch or return uncertainty after dispatch.
There are no application log files or payload/token logs.

Receiver send/replay uses a durable 10/minute bucket, burst two; status is bounded
by one nonblocking process lock and the lifetime. Pruning runs on operations.
Terminal payloads purge immediately. Uncertain payloads purge after the 24-hour
window on the next operation. All receipts expire after 42 days on the next
operation; an idle store may keep old data, but its row and physical size bounds
remain. No timer or maintenance framework is added. After pruning, old requests
are outside the dispatch window; the observed clock watermark prevents rollback
from reopening them.

## Qualification and rollout prerequisites

All agent builds/tests run through chaldea exec agent-a with scratch HOME and disk
TMPDIR. Agent-a job 1e3ce236-6394-4b56-b87e-9a9e7eb5c8d8 passed pinned T3 direct
replay and restart. SSH qualification there is blocked: job
8848bed8-c623-4488-b1b0-21d782e77367 reports "Privilege separation user sshd does not
exist"; diagnostic 66fbb207-0f7c-4186-a7a4-0191765e6db3 confirms only the synthetic
job UID, no /run/sshd and no capabilities. No host identity or daemon was changed.

The existing GitHub-hosted exec/client check runs test/message/ssh-qualification.ts
on an ephemeral runner. It creates and cleans only fixture users, keys, loopback
sshd, code/config and state. No secrets, persistent runner, deployment environment
or fleet credential is involved. Existing token permissions, actions, toolchain
and checks remain. The fixture never skips a missing dependency or failed gate.

Before live enrollment: accepted exact-head review and green hosted qualification;
qualified target-architecture static launcher and root-owned runtime packaging;
explicit first-pair account/key/ACL and two-host approval; independently checked
host key/source address; target-local T3 credential custody/renewal; effective
ordinary-daemon policy and startup-path checks; marked canary and rollback plan.
No live messaging readiness is claimed solely from source/unit tests.
