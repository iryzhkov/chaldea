# Chaldea

Fleet compute v0: `node bin/chaldea exec [--host H] -- CMD...`. Without `--host`, try the ordered hosts in `~/.config/chaldea/exec-hosts` (one bare name per line), skipping this machine. See [setup, protocol, bounds and tests](docs/exec-v0.md).

Chaldea is the agent platform that extends official T3 with what it does not provide: quota resilience, fleet compute, review loops, role routing and agent access control.

Quota resilience (plan step 3): `chaldea quota observe` records T3 usage-limit stops and T3's native auto-resumes in the fleet feed. See [docs/quota.md](docs/quota.md) for how auto-resume is enabled, what the observer records, retention bounds, installation and tests.

Durable waits and decision inbox (step 5): `chaldea wait`, `chaldea decision`, and `chaldea mcp`. See [docs/waits.md](docs/waits.md) for the one-wake contract, queued-message deviation, local service and deployment provisioning.

Requirements: Node 26.10.0 (`.nvmrc`, `mise.toml`), `npm ci`, then `npm run typecheck` and `npm test`.

The plan of record is the Jocasta document `tooling/plans/chaldea-rebuild-plan-2026-10-16.md`. Execution state lives in `tooling/handoffs/chaldea-execution-checkpoint.md`.
