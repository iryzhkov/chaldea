# Operator-run blob maintenance

Implemented source, uninstalled and not live-qualified. Production stays disabled.
This command is an explicit root-operator interface, with no timer, daemon, remote
API, arbitrary command hook, candidate replay, or changes to ordinary job transport.

After separate installation and exact local qualification:

```text
chaldea blob-maintenance run
chaldea blob-maintenance resume <successful-backup-id>
```

`run` revokes every configured publisher's write permission through the pinned
Garage RPC CLI, confirms all bucket principals, stops the exact native service,
confirms its old process and control group exited, makes and verifies a stopped
local metadata/data pair, restarts unchanged state through the native every-start
guard, confirms durable fencing, and calls existing `cleanupBlobs`. It leaves
publication fenced. Only `resume` grants publisher write, after fence, health,
configuration, node, RPC secret, metadata identity and backup checks.

An intake flag is not the fence. Revocation sends
`DenyBucketKey` on JSON stdin with `{read:false,write:true,owner:false}`.
Those booleans select permissions to revoke. The required publisher state is
read=true/write=false/owner=false. Cleanup has read+write and no owner. Readers
have read and no write/owner. Every listed key is inspected without
`showSecretKey`; any unexpected writer or any bucket owner refuses. Known
publishers are still fenced when an unexpected principal is detected. That
failure does not claim the unexpected principal was fenced. The trusted operator
must reconcile it before continuing.

Exclusive operator custody includes RPC administration. No publisher may hold
the RPC secret, an owner grant, a second unlisted key, or access to a grant-making
bootstrap/converger. No native bootstrap runs during maintenance or restart.
The disabled Swarm source is not selected by this path. Concurrent root or RPC
administration can defeat these checks; it must remain excluded for the entire
interval. This is not protection against a malicious trusted operator.

## Trusted local inputs

The root-owned, non-writable-ancestor config is fixed at
`/etc/chaldea/blob-maintenance.json`. Root must run an independently qualified
Chaldea source installation, including `src/exec/blob_pair.py`, under root-owned,
non-writable directories. The ordinary client selection/fleet pins are untouched.

The following INERT schema example deliberately refuses with enabled=false,
null hashes and placeholder IDs. Fill actual bucket aliases/IDs, all publishers,
all readers, the separate cleanup key, principal and exact source/config hashes
only after local qualification and authority. Use one binding per bucket so
the 2 TB data budget remains total across artifacts and results.

```json
{
  "version": 1,
  "enabled": false,
  "unitSHA256": null,
  "starterSHA256": null,
  "preflightSHA256": null,
  "storageSHA256": null,
  "garageSHA256": null,
  "backupRoot": "/mnt/docker-data/swarm/objectstore-backups",
  "minFreeBytes": 2147483648,
  "minFreeInodes": 4096,
  "limits": {
    "maxRequests": 32768,
    "maxRequestBytes": 16777216,
    "maxResponseBytes": 67108864,
    "maxPageBytes": 1048576,
    "maxCandidates": 4096,
    "maxElapsedMs": 120000,
    "maxMutations": 4096,
    "pageSize": 1000
  },
  "bindings": [{
    "bucket": "<actual-bucket-alias>",
    "bucketId": "<actual-64-hex-bucket-id>",
    "principal": "<actual-manifest-principal>",
    "publishers": ["<every-actual-publisher-key-id>"],
    "readers": ["<every-actual-reader-key-id>"],
    "cleanupKey": "<actual-cleanup-key-id>",
    "credentialFile": "/etc/chaldea/blob-cleanup-<actual-bucket-alias>.json"
  }]
}
```

RPC is bound to the exact local Garage binary, config and native unit documented
in infra `docs/objectstore-storage.md`. The pinned v2.4.1 binary SHA256 is
`ae49f8de4aaee6b5ca305f7cbdccc8cd8a29b2804aac074649f18bfb83d0a2b6`,
from OCI digest
`sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`.
The operator checks on-disk unit/startup/preflight/storage/Garage config hashes,
no systemd drop-ins or pending daemon reload, native UID/GID, no automatic restart
or KILL escalation, process exe/argv, cgroup, and one live node.

Cleanup credential files contain only `accessKeyId` and `secretAccessKey`,
mode 0600, root-owned, singly linked, under root-owned non-writable ancestors.
The existing BlobStore private reader and SigV4 transport read these locally.
Secrets do not enter argv, logs, exported results or jobs. RPC secret remains
`/etc/garage/rpc.secret`, owner1000, mode0400; the operator can read it as root.
Publisher and reader credentials remain in their own previously qualified
host-local custody. No issuer, account, route or Unix user is added.

## Failure, backup and resume

The lock directory `<backupRoot>/.maintenance-lock` excludes simultaneous
invocations. A killed operator may leave it behind. Do not remove a stale lock
until the exact former invocation/process and service state are reconciled.
No stale-lock takeover or automatic retry exists.

Stop waits at most 35 seconds and uses only systemd's named unit. The native
unit uses TERM, TimeoutStopSec=30s and SendSIGKILL=no. If an incomplete upload
prevents exit, this run fails with publication fenced; backup and restart never
follow. No automatic KILL, success claim or forced-stop backup is allowed.
The previous experiment required fixture KILL, so graceful drain under arbitrary
active load remains unqualified.

Backups remain on the existing local service-state filesystem. Each run gets a
new UUID directory and never rotates, deletes or overwrites a previous pair.
A partial destination is retained on failure. Copies include metadata and data,
verified sparse manifests, and exact config/storage/RPC secret. These backups
contain keys and require root-only local custody. The command does not restore
or provision storage. Reuse the accepted stopped-pair restore protocol for a
separately authorized recovery.

The conservative limit is 4096 entries and 512 MiB allocated/read bytes **per
tree**, with 2 TiB logical sparse size per tree, 64 KiB copy chunks and 120 seconds
per backup/verification. Inventory and required local headroom precede destination
creation. Headroom requires 1 GiB worst-case pair capacity plus at least 2 GiB
free and 12288 free inodes, while retaining every older pair. Concurrent users
can consume that space after the check. The backup helper refuses symlinks,
hardlinks, wrong owners/modes, nested mounts, changed inventories and mismatches.

This does not support backing up 2 TB of actual data. It conservatively refuses
once either tree exceeds 512 MiB allocated/read. A larger local backup method and
capacity qualification remain required before growing beyond that boundary.
The observed 225 GB local free space cannot hold a 2 TB full local pair.
The data 2 TB and metadata 16 GiB figures are operational budgets, with no
physical quota, reservation or continuous enforcement. Startup requires at least
1 GiB data space and 2 GiB metadata space, plus 4096 free inodes. Maintenance
checks space again before cleanup/resume. Shared fullness and mount changes
after a check remain possible.

Cleanup uses fixed 14-day object/manifest retention and minimum 1-day abandoned
multipart age. Its limits above bound every bucket scan, memory, requests,
bytes, elapsed time and mutations. No CLI option accepts cached candidates.
A cleanup result file in the private pair records complete or partial/uncertain
mutation counts without object names or keys. A successful completion receipt
is written only after every scan and final fence/health check succeeds.

Any failure leaves publication paused. Preserve all pending local copies,
journals, original job UUIDs, original data/metadata and every backup. An
incomplete scan, outage, headroom refusal, uncertain mutation or backup refusal
has no resume receipt. Do not rerun an uncertain job or replay candidates.

Resume is separate and requires a successful, unconsumed receipt under the
unchanged trusted configuration. One private .resume-permit file binds it to
the latest successful run. Every new run removes that permission before any
revocation, so an older success cannot resume after a later failure. Resume
consumes the permission before grants; interrupted or uncertain resume has no
automatic replay. It rehashes both backup trees, confirms current
node/metadata/RPC identity, health and all fenced principals, then restores only
reviewed publisher write permissions. A partial/uncertain grant attempts to
refence every configured publisher and fails; verify the actual permissions
before any further action. Root/RPC access and manual permission changes remain
trusted administration. A backup receipt is not authority to resume production.

## Evidence and remaining qualification

Owning interface: Q2 `jocasta:75988be5921944746f349a2adee821b9@26`.
Accepted revocation/restart evidence:
`jocasta:56e6d40d605c7a3181aef45747357087@1`. Reuse the accepted NAS custody,
stopped restore and original-UUID SSH proofs; no broad NAS canary is repeated.
New contracts exercise multi-publisher revocation, unexpected owners/writers,
failure ordering and finite copy. The private real-Garage test exercises the
finite sequence with synthetic keys and a test-owned process adapter, local
storage and the same pinned executable. It does not qualify systemd installation,
real NAS ownership, production credentials, full-scale backup or power loss.

Actual installation, exact filled configuration hashes, initial bootstrap/grant
removal, credential custody, real service stop/start and adverse-storage behavior
still require parent integration and explicit applicable production authority.
No production source configuration has been enabled.
