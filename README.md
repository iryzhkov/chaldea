# Chaldea

Fleet compute v0: `node bin/chaldea exec --host H -- CMD...`. See [setup, protocol, bounds and tests](docs/exec-v0.md).

Chaldea is a personal project extending T3 Code with quota resilience, fleet compute, durable waits, a decision inbox and agent access control. It targets the pinned T3 Code stable release v0.1.0 (commit `81493ef`); see [the vendored contracts and runtime provenance](vendor/t3-contracts/PROVENANCE.md).

Quota resilience (plan step 3): `chaldea quota observe` records T3 usage-limit stops and T3's native auto-resumes in the fleet feed. See [docs/quota.md](docs/quota.md) for how auto-resume is enabled, what the observer records, retention bounds, installation and tests.

Durable waits and decision inbox (step 5): `chaldea wait`, `chaldea decision`, and `chaldea mcp`. See [docs/waits.md](docs/waits.md) for the one-wake contract, queued-message deviation, local service and deployment provisioning.

Requirements: Node 26.10.0 (`.nvmrc`, `mise.toml`), `npm ci`, then `npm run typecheck` and `npm test`.

The plan of record is the Jocasta document `tooling/plans/chaldea-rebuild-plan-2026-10-16.md`. Execution state lives in `tooling/handoffs/chaldea-execution-checkpoint.md`.
