# Direct NAS Garage canary operator packet

This is source for a proposed single-host experiment. It is not permission to
execute it. The parent must accept source, selected checks and independent review,
then obtain the applicable operator execution authority. Production stays disabled.
No production preflight or validator changes here.

## What this measures

The canary extracts the executable from
`dxflrs/garage:v2.4.1@sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`
using the existing bounded OCI verifier. It runs a disposable nonroot Garage
subprocess with RPC and S3 bound to 127.0.0.1. It reuses the pinned bootstrap,
SigV4 client and test custody retrieval protocol. Docker is neither installed nor
invoked. Registry HTTPS downloads are required; there is no executable override.

Metadata, RPC secret, executable, producer and private logs live in a NEW operator
disk scratch namespace. Garage data lives in a separate NEW 0700 directory on the
already-mounted NFS export. The existing fixture keeps its original default paths.
No default test suite or scheduler invokes this canary.

A tiny shell producer writes one fixed 36-byte report. Two content-addressed S3
objects hold the artifact and a manifest bound to a fresh UUID. The reader verifies
the UUID manifest and bytes before the producer directory is deleted, then a fresh
S3 client retrieves the artifact by UUID without a producer path. Selected denials
check writer read, reader write and another principal's read of the artifact.
Synthetic credentials remain in private scratch or memory and are never printed.

This experiment omits stopped data-plus-metadata restore, multipart, lifecycle
mutation and retention cases already covered by the existing fixture. It adds no
production client path, retention service, continuous fencing or physical cap.

## Preconditions for a later authorized run

- Use **homelab**, as **iryzhkov**, the observed ordinary UID 1000/GID 1000
  operator with passwd home `/home/iryzhkov`. Use no sudo, setuid identity or root
  primary group. The code records the actual effective IDs.
- `/home/iryzhkov/.cache` must already exist on local ext4, xfs, btrfs or zfs, owned by
  that operator UID and primary GID, with no group/other write bit. Every path
  component must be free of symlinks. No root-managed `/srv/swarm` path is used.
- `/mnt/nas/ml` must already be the mountpoint for exactly
  `192.168.40.40:/var/nfs/shared/machine_learning`, type `nfs`, with
  `rw,vers=3,soft,sec=sys`. No alternate source/type or nested mount is accepted.
  Existing mount and directory permissions must permit the operator's IO.
- Both proposed run paths must be absent, including symlinks. Each invocation uses
  a new shared basename. The canary refuses collisions rather than reusing a run.
- Current operator evidence observed a NEW directory owned by NAS UID 977/GID 988,
  mode 0700, after UID 1000/GID 1000 created it. That is the explicit expected data
  ownership in the command below. The canary checks both the new directory and a
  new file, plus effective access. A different mapping fails and preserves state.
  It never assumes process UID equals file UID, changes ownership, or infers the
  server's exact squash policy. The shared root's 988:988/0770 remains untouched.
- Python 3, a POSIX shell, Linux procfs and an amd64 host capable of running the
  verified Garage executable are required. Git is required for source staging.
  Registry HTTPS must be directly reachable, including registry auth and layer
  redirects. The global no-proxy opener also applies to OCI acquisition; ambient
  registry proxies are bypassed.
  Two temporary loopback ports must be available. No production credentials,
  external Garage endpoint, service restart or daemon is involved.
- The operator must have headroom for OCI download/extraction, Garage metadata and
  data. The machine_learning share is assumed unquotaed. The decimal 2 TB total is
  an operational budget, not a hard ceiling or a proven available-space guarantee.
  Exact console quota/squash labels do not gate this disposable experiment.

The NAS metadata receipt `jocasta:fa28312054d802a4e0dbfb78eea4689f@3`
records the exact share and `soft/vers=3/sec=sys` mount. The later direct canary
receipt `jocasta:39409c7a6a66ef15b07711c86d191521@1` records the distinct
mapped ownership above and the successful 4 MiB operator IO: write, file fsync,
rename, directory fsync, reopen/read and complete cleanup. That is context only. It does not qualify deployed service identity
or server stable storage, and the canary does not repeat that accepted source proof.

## Exact proposed command

Run only after the separate approval described above. The parent's review checkout
under `/home/igor` is on another machine and does not exist on homelab. The parent
must supply the full accepted commit as `CANARY_ACCEPTED_COMMIT` and approve an
absolute, NEW source staging path under `/home/iryzhkov/.cache` as
`CANARY_APPROVED_SOURCE`. Neither value has a default.

Stage the reviewed source explicitly. On the parent source machine, from the
accepted checkout, create a self-contained local Git bundle at an approved private
output path. This does not push or contact a Git server:

```sh
accepted_commit=${CANARY_ACCEPTED_COMMIT:?full accepted commit required}
test "$(git rev-parse HEAD)" = "$accepted_commit"
test -z "$(git status --porcelain --untracked-files=all)"
git bundle create "${CANARY_BUNDLE_OUTPUT:?new private bundle path required}" HEAD
```

The parent/operator transfers that bundle through a separately approved existing
file-transfer channel to a private disk path on homelab and supplies that path as
`CANARY_SOURCE_BUNDLE`. No transfer, credential enrollment or installation is
implicit in this packet. With Git already installed, stage on **homelab** as
**iryzhkov** using only the transferred local file:

```sh
set -eu
test "$(hostname -s)" = homelab
test "$(id -un)" = iryzhkov
test "$(id -u):$(id -g)" = 1000:1000
repo=${CANARY_APPROVED_SOURCE:?approved absolute source staging path required}
accepted_commit=${CANARY_ACCEPTED_COMMIT:?full accepted commit required}
bundle=${CANARY_SOURCE_BUNDLE:?approved transferred local bundle path required}
case "$repo" in /home/iryzhkov/.cache/*) ;; *) exit 1;; esac
case "$bundle" in /home/iryzhkov/.cache/*) ;; *) exit 1;; esac
test -f "$bundle"
test ! -e "$repo"
test ! -L "$repo"
git clone --no-checkout -- "$bundle" "$repo"
git -C "$repo" checkout --detach "$accepted_commit"
```

Then run the following on **homelab** as **iryzhkov**. The source path and full
accepted commit must be the parent-approved values, never a moving branch.
Do not precreate either run namespace or the new HOME/TMPDIR.

```sh
set -eu
test "$(hostname -s)" = homelab
test "$(id -un)" = iryzhkov
test "$(id -u):$(id -g)" = 1000:1000
repo=${CANARY_APPROVED_SOURCE:?approved staged source path required}
accepted_commit=${CANARY_ACCEPTED_COMMIT:?full accepted commit required}
test "${#accepted_commit}" = 40
case "$accepted_commit" in *[!0-9a-f]*) exit 1;; esac
test "$(git -C "$repo" rev-parse --show-toplevel)" = "$repo"
test "$(git -C "$repo" rev-parse HEAD)" = "$accepted_commit"
test -z "$(git -C "$repo" status --porcelain --untracked-files=all)"
run="garage-canary-$(python3 -c 'import uuid; print(uuid.uuid4())')"
local_run="/home/iryzhkov/.cache/$run"
nas_run="/mnt/nas/ml/$run"
env HOME="$local_run/.blob-image/home" TMPDIR="$local_run/.blob-image/tmp" \
  python3 -B "$repo/test/blob/nas_canary.py" \
  --execute-disposable-nas-canary \
  --local-run "$local_run" --nas-run "$nas_run" \
  --expected-data-owner 977:988
```

The explicit flag is an opt-in guard, not an authorization mechanism. The program
checks the exact scratch HOME and disk TMPDIR before writing. It creates a private
local run directory exclusively, initializes `report.json` to failure before any
NAS access or fallible scratch setup, and updates that report on handled failure.
If local identity/path validation itself fails, only a redacted failure JSON goes
to stdout. The program never writes a report into a colliding namespace.

## Bounds and side effects

The input is one fixed 36-byte artifact and one small manifest. The disposable
bootstrap creates two buckets with logical quotas of 1 MiB/four objects each and
four synthetic principals; only two custody objects are uploaded. The 1 GiB layout
capacity is a Garage placement parameter, not a reservation or disk limit.
The OCI verifier bounds registry responses and the compressed layer/executable at
128 MiB each. Memory, extracted binary, local metadata, NFS allocation and logs add
overhead. Finite input and logical object quotas do not prove a physical cap.

The Python attempt has a 300-second alarm and subprocess/request timeouts. Final
process shutdown/log reporting gets another 30-second alarm. Interrupt or TERM
enters failure handling. Linux/NFS blocking syscalls, power loss, SIGKILL and host
failure can prevent a timely report or cleanup. These are software deadlines, not
a guaranteed wall-clock IO fence. Do not create NAS outages, unmount anything,
disrupt networks or use private mount/network namespaces to test them.

Only the new local directory and the new NAS child are created or deleted.
A small temporary permission probe is created inside the new NAS child, checked
and removed before Garage starts. The root of the mounted export is never chmoded,
chowned or recursively cleaned. Registry requests and loopback sockets are the only
network activity initiated by the code; existing NFS client IO uses the mount.
Ambient proxy configuration is bypassed globally so S3 credentials stay on loopback.
This also requires direct registry HTTPS during executable acquisition.

Garage uses metadata_fsync and data_fsync. A successful run shows API custody and
retrieval under the current mount behavior. It proves neither NFS server stable
storage, power-loss durability, application/service identity equivalence, production
retention, a hard physical limit nor ongoing mount fencing.

## Results, cleanup and recovery

Exit zero requires successful custody, exact owned process shutdown and cleanup.
The stdout JSON and `$local_run/report.json` record the mount, actual process IDs,
expected/observed mapped file ownership, namespace device/inode pairs, image
digests, bootstrap binding, UUID, artifact hash, stage, cleanup state and redacted
log counts. No raw log lines or arbitrary exception text are exported.
`passed` applies only to this invocation. It is not production qualification.

On success, the canary stops only its own Popen process and waits for it, using
terminate and then kill on timeout. It removes the owned NAS child and the private
HOME/TMPDIR, leaving only the local report namespace. Cleanup checks the original
device/inode identity, ownership, regular files/directories, single-link files,
absence of symlinks/submounts, and bounded tree size before using Python's
symlink-resistant rmtree. It never traverses or deletes the shared root.
The private HOME identity is captured at creation and checked before cleanup;
a replacement is refused, even if its ownership matches.
No cleanup is attempted on a colliding path.

On failure, it still attempts exact owned process termination, preserves data,
metadata, producer if custody was not verified, binary, config and private logs,
and emits the failure report. The report persists UUID, artifact SHA256, byte
count and upload progress before producer deletion. It records confirmed custody,
the deletion phase, completed producer deletion and fresh-client creation/retrieval
phases as they happen. A failed fresh client leaves the UUID and confirmed custody
in the report, with `freshClientByUUID: false` and `passed: false`. Data and metadata
remain available for recovery. A cleanup failure can leave a partially removed
owned tree; `nasRemoved` records completed data removal. Raw logs and RPC secrets
remain restricted to private scratch. Share only report.json, not the raw files.

Before any retry, recover this original report and reconcile the original process.
If `processStopped` is false or missing after Garage startup, check the recorded
PID, its `/proc/PID/stat` start ticks, UID and command/config path together.
Never signal a PID based on its number alone or use process-name matching.
If exact identity cannot be established, retain both namespaces and escalate to
the parent/operator. A lost process/report is uncertain, never a pass.
Once the exact process is confirmed stopped, preserve any desired diagnostic
copy in approved private storage before deleting anything. Each retry uses a new
basename. Do not restart Garage against these paths or overwrite originals.

For a handled failure with a complete report, after the operator has confirmed
the owned process is stopped, the following cleanup uses only the reported owned
namespaces. It is a separate operator action requiring the applicable authority.
Set `local_run` to the recorded original path, never a shared root. The report must
be the original trusted report. Read/copy its sanitized contents before deleting it.

```sh
set -eu
test "$(hostname -s)" = homelab
test "$(id -un)" = iryzhkov
test "$(id -u):$(id -g)" = 1000:1000
repo=${CANARY_APPROVED_SOURCE:?approved original staged source path required}
accepted_commit=${CANARY_ACCEPTED_COMMIT:?full original accepted commit required}
test "${#accepted_commit}" = 40
case "$accepted_commit" in *[!0-9a-f]*) exit 1;; esac
test "$(git -C "$repo" rev-parse --show-toplevel)" = "$repo"
test "$(git -C "$repo" rev-parse HEAD)" = "$accepted_commit"
test -z "$(git -C "$repo" status --porcelain --untracked-files=all)"
: "${local_run:?original /home/iryzhkov/.cache/garage-canary-* path required}"
case "$local_run" in /home/iryzhkov/.cache/garage-canary-*) ;; *) exit 1;; esac
python3 -B - "$repo" "$local_run" <<'PY'
import json
from pathlib import Path
import sys
sys.path.insert(0, str(Path(sys.argv[1]) / "test/blob"))
import nas_canary as c
local = c.plain_path(sys.argv[2])
r = json.loads((local / "report.json").read_text())
c.require(r["localRun"] == str(local), "report_path_binding")
c.require(local.name.startswith("garage-canary-"), "namespace_required")
data = c.plain_path(r["nasRun"])
c.require(data.parent == c.MOUNT and data.name == local.name, "namespace_required")
# The operator has already reconciled and stopped the exact original process.
# Refuse even a possibly reused live PID; investigate it rather than guessing.
c.require("pid" not in r or not Path("/proc", str(r["pid"])).exists(), "process_requires_reconciliation")
if "dataIdentity" in r and not r.get("nasRemoved"):
    c.nas_mount(data)
    c.remove_owned(data, tuple(r["dataIdentity"]), tuple(r["expectedDataOwner"]))
c.remove_owned(local, tuple(r["localIdentity"]), tuple(r["processIdentity"]))
PY
```

If ownership did not match the expected mapping, automatic tree cleanup refuses.
Have the operator inspect the observed mapping and approve an explicit recovery;
do not chown the export or silently substitute ownership. Early setup failures
may lack a complete report binding, and crashes can leave missing files. Preserve
the namespace until the parent/operator resolves those cases. Do not use
`rm -rf /mnt/nas/ml`, glob cleanup, or a catch-all retry.

## Source-only checks

The selected check command is deliberately separate from all default suites:

```sh
chaldea exec --host agent-a --artifact nas-canary-check.json -- \
  sh test/blob/nas-canary-check.sh
```

The runner initializes a failure artifact before setup, asserts a disposable
HOME/TMPDIR in the job's disk-backed snapshot, and uses local files plus fake
Garage/S3 adapters. It checks new path/mount/ownership guards, the existing Garage
constructor's default and separate-data configuration, actual UUID protocol reuse,
producer preservation on failed upload, persisted recovery reports on failed fresh
client creation/retrieval, process-stop handling, failure artifacts, refusal to
clean a replaced private HOME, safe cleanup and log redaction. The returned artifact
includes a SHA256 `sourceInputs.files` manifest of the actual canary, runner,
imported helpers, pinned bootstrap and operator packet from the job snapshot.
The parent can compare those hashes with the accepted commit's Git blob bytes. It downloads no image, starts no Garage server and
touches no NAS. These checks cannot supply NAS proof.

Accepted existing OCI/bootstrap/custody proofs are not rerun. Remaining gates are
parent review, any required source/CI acceptance, operator execution authority,
the live approved single-host canary and evaluation of its actual report.
Production gates remain unchanged and outside this packet.
