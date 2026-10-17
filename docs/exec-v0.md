# Fleet compute v0

`chaldea exec [--host agent-a] [--artifact out/file] [--gpu] -- CMD ARG...`
runs the current Git worktree on an enrolled Linux job host. Run it from any
directory inside that worktree; the command keeps that relative working directory.
Arguments are sent as an array, without shell expansion. Request a shell explicitly
as `-- sh -c '...'` when the build needs one; that shell runs inside the sandbox.
SSH itself never grants a shell.

Without `--host`, read `~/.config/chaldea/exec-hosts` in order. Fleet config
writes inventory names whose `chaldea-job-NAME` alias exists in
`~/.ssh/chaldea-job.conf`, one name per line, for example:

```text
agent-a
agent-b
omarchy-pc
laptop
```

Fleet config omits each machine's own inventory name from its list; the client
also skips its short OS hostname as a backstop. Blank lines and whole-line `#`
comments are allowed; duplicate names are tried once. Each skipped host prints
its reason, and a confirmed job result prints the host used. Fall through only on a confirmed refusal before
execution (busy, gaming gate, or unavailable sandbox), a local target lock held
by another exec, a stuck SSH ControlMaster, or a connection closed before sending
the job request. SSH connection setup times out after 10 seconds.
Server-refusal fallback relies on the server never sending `refused` once a job has launched.
After any request write, connection loss stays uncertain and is never retried;
preemption and protocol errors also stop the invocation. Every attempted host
has its own journal entry. All targets unavailable exits **69**, with a one-line
host/reason summary, without waiting or queuing. An explicit `--host H` attempts
only H and keeps the existing status/error behavior. If the list file is missing,
use `--host H` to target a host without it.


Use Node **26.10.0** (`mise install`), `npm ci`, then
`node bin/chaldea exec ...` or install the package's `chaldea` bin entry.
Only development/type-check dependencies are installed; the client has no runtime
npm dependencies. The package.json is deliberately small to merge with quota work.
Remote commands use system tools in `/usr/bin:/bin`; the operator's mise installs,
Rust home, credentials and caches are not imported. Install required system tools
on a job host or download toolchains into the job workspace.

The companion role is in
[iryzhkov/chaldea-fleet-config](https://github.com/iryzhkov/chaldea-fleet-config),
`roles/chaldea_job_host` and `roles/chaldea_job_client`. Deployment, public-key
enrollment and firewall changes require operator review; this client provisions
nothing. See that repository's `docs/job-host.md` for per-host apply commands.

## Protocol (version 1, forced command chaldea-exec-v0)

1. Every frame is one uppercase ASCII type, a four-byte big-endian length, then bytes; maximum frame size is 1 MiB. Server sends H JSON with version 1; client checks it before upload.
2. Client sends Q JSON: version, UUID jobId, argv, relative cwd, gpu, artifact paths, and files with relative path, size, 0644/0755 mode and SHA-256.
3. Client sends B frames of at most 64 KiB in manifest order, followed by empty E; stdin remains open so EOF cancels the job.
4. Server streams O stdout and S stderr, then A JSON artifact metadata and B bytes for each named artifact (regular files only).
5. Server deletes the workspace before X JSON exitCode (0–255); R JSON is an error. Missing X or a failed SSH session leaves the journal outcome uncertain; dispatched work is never replayed.

## Snapshot and sandbox contract

The manifest follows the spike at 9d659aa: `git ls-files -c -o --exclude-standard -z`,
current bytes, executable modes, tracked deletions absent, already tracked ignored
files included. Two equal scans detect ordinary concurrent edits; they are not an
atomic filesystem snapshot. Names must be UTF-8 safe relative paths. Symlinks,
special files and submodules are refused. Git metadata is never copied.
`.chaldea/` is reserved and added to Git's local info/exclude, including for linked
worktrees. It holds only returned artifacts. Workspace files are inputs: callers
must not keep credentials in tracked or non-ignored input files.

The host creates a fresh data-disk workspace, runs argv in bubblewrap with fresh
PID/user/IPC/UTS namespaces, no capabilities, a read-only root, read-only /usr and
only public resolver/certificate/loader files from /etc. Only the workspace and
its disposable HOME and TMPDIR are writable on the host. Sandbox /tmp is backed
by that workspace, not host /tmp. /run and the original home are absent. No Huyang,
Docker, SSH-agent or D-Bus user sockets, credentials, sudo grants or host tool
configuration are mounted. All subprocess environment variables are rebuilt.

**Outbound networking is on through pasta in a private network namespace.**
Host-loopback/gateway mapping and forwarding are disabled, and nftables rejects
all non-loopback host interface addresses and connected subnets of interfaces
outside the default routes (including Docker bridges and overlay peers). These
lists are captured at job start; dynamic changes remain follow-up N2. Host
abstract sockets are isolated.
There is no general internet/LAN egress allowlist. Network authorization for
services remains their responsibility. This v0 does not offer job credentials.

NVIDIA device nodes are mounted only for --gpu. The operator selects the RTX 4090
nodes and NVIDIA Vulkan ICD; the AMD iGPU (normally Vulkan device 0 on omarchy-pc)
is not exposed. Nested user namespaces are disabled when supported. The isolated
Python forced command ignores user-site/PYTHONPATH configuration.

## Bounds and recovery

- Snapshot: 64 MiB, 10,000 files; request metadata: 1 MiB.
- Artifacts: at most 32 explicitly named regular files, 64 MiB aggregate per job.
- Output: 64 MiB combined stdout/stderr, streamed without a persisted host log.
- Runtime: six hours; upload: two minutes; one active job per host, immediate busy refusal.
- Workspaces, successful or failed: deleted immediately. Stale workspaces after
  an uncatchable server crash are removed on the next admitted connection/start,
  under the host lock, within a one-second cleanup budget. Unremovable leftovers
  are logged and stay inside the image bound without wedging later jobs.
- Host workspace state: one 20 GiB fixed-size ext4 image (inventory adjustable).
  Admission requires the mount and reserves 256 MiB free space plus snapshot capacity.
  Its optional mount cannot block boot. An absent mount gives a clear refusal.
  Authentication logs have a separate 16 MiB, 14-day journal namespace.
- Local artifacts: 14 days and 20 GiB per destination across worktrees, accounted
  through the journal. Old completed artifacts are evicted under size pressure.
  Journal eviction also removes the referenced artifacts. Kernel flock protects
  accounting and requires no stale-lock cleanup after reboot. A short state-wide
  lock protects journal changes, pruning and artifact reservations across targets
  and worktrees. It is released before SSH dispatch: calls to the same host may
  overlap, and the server's configured slots decide admission. Active jobs reserve
  up to 64 MiB each before dispatch, so parallel artifact writers cannot overbook
  the cap. A full server returns the existing refused outcome.
- Local client journal: mode 0600, fsynced before SSH dispatch and atomically
  replaced after confirmed completion; 14 days / 1,000 entries, no output logs.

The local journal lives in `~/.local/state/chaldea/exec/journal/<job-id>.json`.
Its initial outcome is deliberately `uncertain`, and only a confirmed clean result
changes it to `finished`. Definitive non-execution is `refused`; gaming that
interrupts a running job is `preempted`. Remote exit 125 passes through; local
Chaldea failures use 255. A remote 255 has a finished journal entry. Auto-mode exhaustion uses 69 (a remote 69 still has a finished journal entry).
A crash before dispatch, during upload/execution, after
remote cleanup or before journal completion never triggers another run. Inspect
an uncertain entry; an explicit new invocation is a new job.

SSH uses `~/.ssh/chaldea-job.conf` only, a dedicated private key, IdentityAgent none,
ControlMaster auto and ControlPersist 60. No user's agent is consulted. Multiplexing
reuses authentication while each request still reaches a new forced-command process.
The role pins known hosts separately in `~/.ssh/chaldea-job_known_hosts`; unknown
keys fail closed. A real disconnect closes stdin and kills the job process group;
bubblewrap's parent-death behavior and PID namespace also kill escaped descendants.
A silent network partition is detected by SSH keepalives (15 s, two missed replies).
Stale ControlMaster sockets are replaced before a new dispatch. There is no
reconnect/replay path; source or target reboot leaves dispatched work uncertain.

`CHALDEA_EXEC_HOSTS`, `CHALDEA_SSH_CONFIG` and `CHALDEA_STATE_DIR` override the host-list, SSH-config and state paths for
isolated tests. They are local operator configuration, never remote job input.

## Verification

```sh
export TMPDIR=/home/igor/.cache/chaldea-scratch/laneC
npm ci
npm run exec:check
npm run exec:test
# On agent-a: fake job hosts exercise fallback and connection-loss boundaries.
node --test test/exec/fallback.e2e.ts
# Companion checkout contains the exact server under review:
CHALDEA_JOB_SERVER=/home/igor/Work/chaldea/fleet-config-jobhost/roles/chaldea_job_host/files/chaldea-job-server npm run exec:e2e
```

The E2E must run without root and uses a free loopback port, disposable fixture
keys and its own sshd. It never changes the real daemon, firewall, keys or users.
It tests live output/status, artifacts and cleanup, real forwarding/PTY/shell
refusals, isolated HOME/sockets/GPU/environment, private network isolation and timed preemption,
connection loss (including a descendant with its own session), uncertain intent,
and fault-injected disk-full/over-cap admission. It reports spawn-to-first-stdout
latency on the second multiplexed invocation and asserts under two seconds.
Image mounting/cgroup enforcement, actual reboot behavior, real GPU execution and real-host desktop policy
are not exercised by this rootless test. Rendering uses an existing Python with
Jinja2 (CHALDEA_TEST_PYTHON overrides python3). The default pasta is the system
/usr/bin/pasta; CHALDEA_PASTA is an explicit override for an extracted distro
package, and the test reports its path. Do not substitute a newer fixture for
host package compatibility validation. CHALDEA_SSHD can select an existing sshd.
Round 2 exercises system bubblewrap 0.12.0 with the exact extracted Arch
2026_07_28 and Debian 20250503 passt packages because local passt is absent and
this lane does not install packages on real hosts. The suite also runs the role's
apply-time smoke command; actual enrollment must pass with installed packages. CI uses the same E2E and a pinned companion
commit through the existing read-only github-chaldea-fleet-config alias. It installs
no host packages and reports a notice when required tools or unprivileged SSH/
bubblewrap are unavailable. Unit tests in the fleet repository cover
the idle gate's fail-closed decisions; that repository's CI also tests client
key metadata and SSH configuration without opening a connection.
