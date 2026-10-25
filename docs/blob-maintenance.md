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

## Qualification producer compatibility

The fixed read-only Python snippet calls the hash-bound native producer's
`check`, including preflight qualification validation, then returns only its
existing `startup_headroom` object. Legacy string qualifications and explicitly
selected `operator_budget_v1` typed records use that same path. Maintenance adds
no selector, policy implementation or lifecycle knob. Normal startup and
maintenance still refuse any missing gate, wrong type or current-digest drift.

The selected operator-budget contract requires explicit data and metadata
operational budgets. Fullness/mount-loss gates accept only accepted-risk records;
restore/client gates accept measured or composite evidence; last-copy requires
measured custody/policy evidence. Composite records disclose distinct measured
and qualifying digests and an immutable difference reference. Startup checks
local shape and qualifying bindings only. The reviewed operator preparation
compares historical bytes, permits exact configuration differences and verifies
receipt truth/path mapping. Neither producer nor maintenance fetches evidence.

When changing either producer helper, review both repositories as one acceptance
batch. Freeze the infra head, then refresh the exact
`scripts/garage-storage-{preflight,native}.py` bytes into
`test/fixtures/blob-headroom/` using guarded repository edits. Record both SHA256s
and update the fixture-hash assertion in
`test/exec/blob-maintenance-headroom.test.ts` only where bytes changed. Run that
test against the actual fixed snippet with legacy and typed qualifications,
five-gate refusals and existing headroom cases, plus exec typechecks. Record
both source heads and job logs together. Fixture hashes are test assumptions,
not running configuration pins. Installation and new protected pins require a
separately reviewed operator packet and authority; these source fixtures grant
no start, credential, restore or maintenance permission.

## Trusted local inputs

The root-owned, non-writable-ancestor config is fixed at
`/etc/chaldea/blob-maintenance.json`. Root must run an independently qualified
Chaldea source installation, including `src/exec/blob_pair.py`, under root-owned,
non-writable directories. The ordinary client selection/fleet pins are untouched.
Root's PATH has no Node. A future invocation names the existing protected
runtime explicitly, for example `PATH=/opt/chaldea/node/bin:/usr/bin:/bin`,
without changing the global PATH or the installed runtime.

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
  "backupLimits": {
    "maxElapsedMs": 3600000,
    "meta": {
      "maxEntries": 4096,
      "maxAllocatedBytes": 17179869184,
      "maxReadBytes": 18253611008,
      "maxLogicalBytes": 2199023255552
    },
    "data": {
      "maxEntries": 135168,
      "maxAllocatedBytes": 69793218560,
      "maxReadBytes": 68719476736,
      "maxLogicalBytes": 68719476736
    }
  },
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

Headroom uses a fixed read-only Python snippet against the same hash-pinned
native starter, preflight, storage policy and Garage config. It calls native
`check()`, including all five normal qualification gates, current mounts and
custody, without calling `main()` or starting Garage. The native helper owns the
NFS filecount policy. Only its explicit storage-policy acceptance of all-zero
NFS data counters can return `filecounts: "UNKNOWN"` with
`available_inodes: null`. This establishes no free file-slot capacity.
Known counts still meet `minFreeInodes`, including values above 4096.
Local metadata and backup retain their byte and inode floors.
The finite command output and completion receipt include the headroom report.

The contract tests retain byte-identical native/preflight fixtures from infra
PR80, accepted source `d7de0142c623fa5498ec63fd50ab0cca7eca0879`.
They simulate telemetry, mounts and custody without real host access.
This source correction grants no risk acceptance or qualification. An earlier
S1/S2-only acceptance cannot authorize normal maintenance. S3 must separately
decide the applicable policy, exact source/config hashes and all normal gates.

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


### Managed DATA and pair version 3

Maintenance derives the fixed `managed_nfs_data_v1` profile from the exact
storage bytes covered by `storageSHA256`. There is no selectable maintenance
profile. Native `check()`, `check_headroom()`, startup preflight fields and
the every-start interface are unchanged. The producer fixture is byte-for-byte
the paired homelab-infra producer. Profile/acceptance additions exceed the old
S2 selector plus UNKNOWN-reference allowlist. Future composite records must
name a mechanically checked immutable difference receipt; accepted-risk,
composite and measured records must keep their distinct meanings. Source
preparation supplies no acceptance, production digest or gate.

Without the profile, private pair version 2 canonical bytes and dispatch remain.
With it, version 3 binds exact source storage SHA256, source configuration
digest, the fixed profile/immutable acceptance reference, effective profile
SHA256, mapped owner and exact limits. DATA accepts stable 0700/0770 directories
and 0600/0660 files. Version 3 metadata sources must be exactly 0700/0600;
0500 directories and 0400 files refuse. The expected service UMask is 077.
Both copied trees are root-owned
private local 0700/0600. Destination `mode`/content rows describe that normalized
copy; separate `sourceMode` and nine-field source stamps record historical
dev/inode/mode/uid/gid/nlink/size/mtime-ns/ctime-ns. They are provenance and change
guards, never expected local inode or ctime values.

Pre/post inventories compare paths and all stamps, each opened file checks its
descriptor before/after copying, and bounded source and local content scans
verify hashes. The first implementation refuses ALL observed epoch drift,
including policy-allowed mode changes and unexplained ctime-only changes.
It has no mode transition tolerance or actor attribution. Failures keep the last
good pair and partial output without rotation, overwrite, deletion or automatic
retry. Each content pass retains the configured read ceiling and the same
deadline; v3 adds a source verification pass and charges a larger bounded
manifest before creation. No full-scale throughput/capacity claim follows.

Version 3 verification requires private root local custody, exact canonical
bytes, content, profile-constrained historical provenance, digests and limits.
Unknown versions/profiles, mismatched bindings/limits, local group access,
unsafe owners and links refuse. Resume re-verifies the selected representation
using the same config-bound receipt and live protected storage bytes, whose
hash must match the config and the saved pair sidecar, before any grant.

Recovery remains the packet-local stopped-pair protocol
`jocasta:d20c4ef5fec9d4d4016748b9fdd0dbf5@4`. Its concrete consumers are
`restore-copy.py`, `prepare-host.py` and `restore-start.py` with derived
configuration checks. The old frozen annex is unchanged. The new protected
outside-Git `managed-persistent-source/recovery` annex freezes an inert
representation adapter and explicit integration gaps. Its identical test source
is `test/fixtures/blob-recovery/representation.py`; it is a packet fixture,
not an installed restore command. Version 2 delegates unchanged. Version 3
verifies the private pair before copying, checks normalized restored content
and actual fresh mapping 1000:1000 metadata / 977:988 DATA, and records requested
0700/0600 versus admitted 0700/0770/0600/0660. New destination identities are
recorded separately. Source-pair hash, current source storage, restored
path-derived config and effective profile bindings remain distinct. Wrong
content/mode/owner refuses and preserves partial state. Future packet-specific
identity/TERM/lifecycle/capacity/mount/secret constraints are retained, not
replaced by this adapter. No future production epoch values are invented.

For the proposed one-job window, capacity must cover TWO FULL maintenance runs
plus all retained pairs: before first publication, then after publication to
refence and back up new bytes. The second run requires the active healthy service;
it is not a fence shortcut. Only explicit separate `resume UUID` grants the
window. Abort uses trusted pinned local RPC `DenyBucketKey` for the exact known
publisher/bucket with selectors `{read:false,write:true,owner:false}`, followed
by `GetKeyInfo` proving read=true/write=false/owner=false. Reconcile uncertain
mutations read-only; never replay an uncertain run. Keep publisher, reader and
maintenance keys DISTINCT, with the same exact manifest principal and bucket.
No controller profiles, credentials, tunnel, units or production values are
created by this source.

The existing NAS is a proposed visibility/integrity domain only for nonsecret,
replaceable DATA. NAS actors/ACLs/client restrictions remain UNKNOWN and raw
share clients may alter/read/delete bytes. Hashes do not authenticate replacing
both object and manifest. Local metadata, credentials and copies stay private.
The 2e12 TOTAL DATA budget is unquotaed, separate local metadata stays 16 GiB,
and all-zero NFS filecounts remain UNKNOWN rather than free inode capacity.
The namespace TEST receipt is consumed historical evidence; it is no current
artifact restore, NAS security, shared-fullness/outage, power-loss or full-scale
qualification. Unit `Restart=no`, every native start, TERM and `SendSIGKILL=no`
remain the existing lifecycle. Production shared-access acceptance is unresolved.

### Backup limits and local capacity

The selected operating model starts within verified local backup capacity. The
backup stays on the existing local `/mnt/docker-data` filesystem beside the
metadata; it is never moved onto the NAS or offsite.

`backupLimits` in the protected config sets explicit per-tree bounds for `meta`
and `data`: entries, allocated bytes, bytes read by the copy, and logical (sparse)
size, plus one elapsed bound for the whole backup and again for each verification.
Every value must be a positive safe integer at or below a finite global maximum:
262144 entries, 256 GiB allocated or read and 2 TiB logical per tree, and six
hours. Unknown or missing keys, booleans, fractions, zero, negative or oversized
values refuse, in the operator and again in `blob_pair.py`. When `backupLimits`
is omitted, the legacy fixture bounds apply unchanged: 4096 entries, 512 MiB
allocated/read and 2 TiB logical per tree, 120 seconds. Nothing increases a
bound silently.

The example above is a reviewable first-operation proposal, not an allocation,
a target qualification or a measured fact:

- `data`: 64 GiB logical and read, the proposed actual-data operating bound.
  65 GiB allocated covers block rounding of small files and directories.
  135168 entries covers 65536 files of Garage's default 1 MiB blocks even when
  all 65536 + 256 + 1 of its two-level hash directories exist (131329 entries).
  Many small objects can hit the entry bound first.
- `meta`: 16 GiB allocated, the existing metadata budget. 17 GiB read allows for
  64 KiB chunk rounding around sparse database pages. 2 TiB logical covers a
  sparse LMDB map, which is never read through its holes.
- One hour bounds the backup, which runs while the service is stopped and
  publication is fenced, and separately each resume verification. At the full
  bounds that needs roughly 40 MB/s sustained across NAS reads, local writes and
  rehashing. That throughput is unmeasured; exceeding it is a fenced refusal
  after up to an hour of stopped service. Live qualification must measure it,
  together with the entry count of the actual store.

The proposed bounds do not support a 2 TB backup. The 2,000,000,000,000 byte
NAS total and 16 GiB metadata figures remain operating budgets, with no physical
quota, reservation or continuous enforcement.

Each backup inventories both trees incrementally within the bounds, then
measures the copy without reading data. Sparse seeks give the exact 64 KiB
chunk-aligned ranges the copy will read. The required destination space is:

- every read range rounded up to whole filesystem blocks;
- for each file, a worst-case extent tree: one extent per filesystem block, every
  leaf and index node only half full, and only four extents in the inode. The
  copy writes each file once in ascending order, so ext4 appends and fills each
  node but the last; the half-full charge doubles that;
- 8 KiB per copied entry for directory blocks, directory entries and metadata;
- the manifest bound (4096 + 512 bytes per configured entry, about 68 MiB for
  the proposal) and 2 MiB for the operator's private sidecars.

Required inodes are the copied entries plus 64. The helper compares current
`f_bavail`/`f_favail` with that requirement plus `minFreeBytes`/`minFreeInodes`
BEFORE creating the destination. A small tree that fits is not charged twice its
configured maximum. Older pairs already consume the space they hold and are
never deleted to pass. The copy may read no more than measured, and after the
copy the destination's actual allocation must not exceed the measured
requirement; either failure refuses. The model is derived for ext4, so the
backup refuses on any other destination filesystem. It also assumes ext4
without `bigalloc` (cluster size equal to block size), which `statvfs` cannot
reveal; live qualification must confirm that read-only, for example with
`dumpe2fs -h`. The post-copy allocation check still refuses if the assumption
is wrong, but only after the space is consumed. Holes stay holes. If the
source cannot report holes, the whole remaining logical size must fit the read
bound or the measurement refuses without reading zeros.

With the proposal at its full bounds the requirement is about 83 GiB for whole
1 MiB block files and at most about 84 GiB for fully fragmented files, plus the
2 GiB reserve. The last read-only check on 2026-10-24 saw 216,670,908,416 bytes
available on `/mnt/docker-data`. That is point-in-time headroom on a shared
disk, not reserved or supported capacity. Pairs are never rotated, so each
successful run consumes space until the operator separately reconciles old pairs;
once space runs out, backups refuse with publication fenced.

The check is point-in-time. Concurrent shared consumers can still fill the disk
after it, and no continuous admission monitor or physical cap exists. Nothing
limits publishers to the backup bounds between runs: a store that outgrows them
is found only by the next `run`, whose backup refuses before any copy and leaves
publication fenced. Cleanup runs only after a backup, so recovery then needs a
separately decided operator action.

The backup helper refuses symlinks, hardlinks, wrong owners/modes, nested mounts
(including mount points whose names the kernel escapes), changed inventories and
mismatches. The manifest records the exact limits. Verification accepts only the
exact canonical manifest bytes the helper writes for the recomputed trees under
the same limits. A manifest from the earlier source (version 1), a changed
limit, or a mutated copy refuses. The completion receipt binds the config hash,
so changed limits also make an earlier receipt unusable for `resume`.

Startup requires at least 1 GiB data space and 2 GiB metadata space, plus 4096
free inodes. Maintenance checks space again before cleanup/resume. Shared
fullness and mount changes after a check remain possible.

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
the latest successful run. Every new run removes that permission and fsyncs its
parent directory before any revocation, so an older success cannot resume after a later failure. Resume
consumes the permission and fsyncs its parent directory before grants; interrupted or uncertain resume has no
automatic replay. It rehashes both backup trees, confirms current
node/metadata/RPC identity, health and all fenced principals, then restores only
reviewed publisher write permissions. A partial/uncertain grant attempts to
refence every configured publisher and fails; verify the actual permissions
before any further action. Root/RPC access and manual permission changes remain
trusted administration. A backup receipt is not authority to resume production.

## Evidence and remaining qualification

Owning interface: Q2 `jocasta:75988be5921944746f349a2adee821b9@30`; prior
accepted source receipt `jocasta:324dce60a5770b1f85aaf050ddd2a885@2`.
Accepted revocation/restart evidence:
`jocasta:56e6d40d605c7a3181aef45747357087@1`. Reuse the accepted NAS custody,
stopped restore and original-UUID SSH proofs; no broad NAS canary is repeated.
New contracts exercise multi-publisher revocation, unexpected owners/writers,
failure ordering and finite copy. The private real-Garage test exercises the
finite sequence with synthetic keys and a test-owned process adapter, local
storage and the same pinned executable. It does not qualify systemd installation,
real NAS ownership, production credentials, full-scale backup or power loss.

Maintenance's root process reads the mode0700 NAS data for backup. The accepted
NAS copy proof used process1000:1000. Root reads under the actual export's squash
policy remain unqualified and may refuse even when1000:1000 succeeds. Do not
infer root access from that earlier proof or change export/ownership to fix a
refusal. Root-read qualification is a remaining activation gate for the parent.
Each retained local pair also retains an RPC secret copy; later rotation does
not remove those older copies. The operator owns their continuing private custody.

Actual installation, exact filled configuration hashes, initial bootstrap/grant
removal, credential custody, real service stop/start and adverse-storage behavior
still require parent integration and explicit applicable production authority.
No production source configuration has been enabled.
