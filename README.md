# Chaldea

`chaldea --describe` prints compact JSON discovery metadata. Messaging discovery
is a deliberate exception to static discovery: it parses the bounded private
sender config and loads messaging client modules to expose only configured
routes. It opens no journal or credential and makes no network connection. Each command has a one-line summary
and `read`/`write` access; local pruning and trust high-water updates count as
writes. `chaldea --help` lists every command; group help supplies full syntax.

Daemon/client config, XDG paths, compatibility, JSON logs and process exit codes are documented in [configuration conventions](docs/configuration.md).


Fleet compute v0: `node bin/chaldea exec [--host H] -- CMD...`. Without `--host`, try the ordered hosts in `~/.config/chaldea/exec-hosts` (one fleet inventory name per line; fleet config omits this machine). See [setup, protocol, bounds and tests](docs/exec-v0.md).

Chaldea is a personal project extending T3 Code with quota resilience, fleet compute and agent access control. It targets official T3 Code v0.1.9, with compatibility for v0.1.6 during the host upgrade. The small runtime-decoded client is in [src/t3/contracts.ts](src/t3/contracts.ts); CI verifies the official release checksums.

Native delegation routing: `chaldea route --role builder` and MCP `chaldea_route` recommend a T3 delegate target from quota capacity, pacing and Slopalytics. Launch the child through T3 after routing. See [routing, capacity and opt-in Claude usage](docs/route.md).

Quota resilience (plan step 3): `chaldea quota observe` records T3 usage-limit stops and T3's native auto-resumes in the fleet feed. See [docs/quota.md](docs/quota.md) for how auto-resume is enabled, what the observer records, retention bounds, installation and tests.


Fleet-managed client installs use `client-vX.Y.Z` releases. See [the fleet client role, migration and rollout guide](https://github.com/iryzhkov/chaldea-fleet-config/blob/main/docs/chaldea-client.md). The client artifact contains the app and locked production dependencies; the host artifact contains only host programs. Separate client tags keep client updates independent of host releases. Both release workflows require a commit reachable from main.

Requirements: Node 26.10.0 (`.nvmrc`, `mise.toml`), `npm ci`, then `npm run typecheck` and `npm test`.

The plan of record is the Jocasta document `tooling/plans/chaldea-rebuild-plan-2026-10-16.md`. Execution state lives in `tooling/handoffs/chaldea-execution-checkpoint.md`.
