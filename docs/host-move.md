# Host programs and release installation

The public Chaldea release owns executable host programs. Fleet configuration owns
users, configuration, unit files, mounts, firewall rules and the selected version.
No host convergence is performed by this change.

Build with `npm ci --ignore-scripts`, then
`npm run host:build -- VERSION OUTPUT`. The build takes no Git metadata, stages
self-contained ESM trust-maintenance/signing, collector and Akasha service entry points, and writes
`chaldea-host.tar.gz` plus `manifest.json`. The manifest records the version,
archive SHA-256 and each member's SHA-256. Tests and their dependencies remain in
source and are excluded from the runtime archive. Archive ordering, ownership, modes and
timestamps are deterministic. Node 26.10.0 is the runtime baseline. All npm build
dependencies, including esbuild, are locked with integrity hashes.

The hosted `host artifact` workflow tests Python host programs, builds twice and
compares bytes, smoke-tests all three bundled entry points and uploads the candidate.
On a `host-v*` tag it requires the real exec E2E workflow as well, then attaches
those exact bytes to a versioned GitHub release. Main builds remain CI candidates.
It does not replace an existing release's assets. Fleet inventory pins the release
and archive SHA-256; downloads come from the public release, never the private
configuration repository or an executable fetched by the trust updater.

## Install mapping

Source baseline: chaldea-fleet-config main `6f4d6eb`, including the queue and
passwd fixes. Paths below are relative to that repository.

| Previous source | Chaldea artifact member | Installed destination |
| --- | --- | --- |
| roles/chaldea_job_host/files/chaldea-job-server | host/chaldea-job-server | existing chaldea_job_host_server |
| roles/chaldea_job_host/files/chaldea-job-image | host/chaldea-job-image | /usr/local/libexec/chaldea-job-image |
| roles/chaldea_job_host/files/chaldea-job-toolchains | host/chaldea-job-toolchains | /usr/local/libexec/chaldea-job-toolchains |
| roles/retention/templates/chaldea-retention.j2 | host/chaldea-retention | existing retention_script |
| roles/timer_reporting/files/chaldea-timer-report and roles/akasha_collector/files/chaldea-timer-report | host/chaldea-timer-report | ~/.local/bin/chaldea-timer-report |
| roles/timer_reporting/files/chaldea_outcome.py | host/chaldea_outcome.py | ~/.local/share/chaldea/timer-reporting/chaldea_outcome.py |
| roles/chaldea_access_trust/files/fetch.py | host/chaldea-access-trust-fetch | existing chaldea_access_trust_fetcher |
| src/access/maintenance.ts (already in Chaldea) | host/access-maintenance.mjs | root-owned release tree |
| src/events/collector.ts (already in Chaldea) | host/akasha-collector.mjs | root-owned release tree |
| src/akasha/entry.ts | host/akasha-service.mjs | root-owned release tree; invoked by homelab-infra |

Image creation, toolchain management, byte-only trust fetching and callback source
are byte-preserving moves. The image helper was formerly transferred temporarily
by Ansible's script module; it is now installed before execution. The server reads
its shared `exec-protocol.json` alongside the installed program. The client reads
the same source JSON. Safe-path preflight consistently reserves `.chaldea-*`
components for cwd and artifact paths too; those names were already reserved in
server snapshot entries. Request limits, frame names, versions and safe-path policy
are defined there; refusal `busy` is a boolean, independent of message text.

Retention reads its former template variable from `CHALDEA_NODE_VERSION`, rendered
by the fleet unit. It refuses mise pruning if that configuration is absent. The
merged reporter reads `~/.config/chaldea/timer-reporting.json` with explicit
`delivery: "feed"` or `"queue"`; its default is feed. Queue mode retains its
immutable spool budget, never falls back to shared feed credentials, and preserves
file and directory fsyncs. Both delivery modes use those durable status writes.

The artifact is root-owned, including the installed programs and callback.
Mutable user state retains its existing owner and bounds. Configuration and units
continue to be rendered by their existing roles. Runtime tests follow the programs
to `host/tests`; role and inventory assertions stay in fleet-config. The manual
toolchain SSH smoke test accepts a JSON `--versions` file instead of reading a
sibling repository. Its SSH templates are frozen test fixtures.

## Access path contract

The sole deployment mapping is `chaldea_access_paths` in
[chaldea-fleet-config inventory](https://github.com/iryzhkov/chaldea-fleet-config/blob/main/inventory/group_vars/all.yml).
Updater config and systemd units render its bundle, clock and updater-state values;
verifier runtime configuration uses its verifier-state value. Updater and verifier
have separate durable databases and owners. All TypeScript callers use the shared
clock-health parser in `src/access/clock.ts` while retaining their file trust checks.
The [Akasha runbook follow-up](https://github.com/iryzhkov/homelab-infra/pull/12)
uses that mapping and the agreed 24-hour signed-bundle age.

There is no separate trust-publisher program in fleet-config to relocate. Signing
already lives in Chaldea's access CLI and is included in the bundled host entry
point. Publishing remains the explicit operator action of committing only signed
`access-trust/bundle.jws` bytes to fleet-config main. No key generation or
publication is added to convergence. `mcp_registration.py` remains an Ansible
module in fleet-config. The OpenCode Huyang plugin remains owned by omarchy-setup;
fleet-config installs its checksum-pinned source.

## Before/after source evidence

Remote job `5a0c11aa-da4c-4120-af0f-03bf8fc515ab` compared the original Git
archive with moved source. The image helper, toolchain manager, byte-only trust
fetcher and Ansible callback were byte-identical. Retention's AST was identical
after normalizing its configured Node version and the missing-configuration
prune guard. The merged reporter retained both original delivery functions
exactly, the safer fsynced writer, and all common functions. Outcome recording
preserves each original ordering: feed persists its pending claim before posting;
queue persists its immutable spool input before claiming it. The server is covered by the shared-protocol
contract and real-server tests.

## Acceptance boundary

Remote unit suites and hosted real-SSH/bubblewrap/pasta E2E validate source behavior.
The orchestrator still must converge agent-a, agent-b, omarchy-pc and laptop and
compare behavior. This implementation neither enrolls trust nor activates Akasha,
and does not claim that CI is live host verification.
