# Vendored T3 contracts

This directory starts with `packages/contracts` from official T3 v0.1.0.
Two files carry a bounded local extension from the external-wait fix:
`orchestrationV2.ts` adds server-owned lifecycle history and guarded external
wake admission; `server.ts` adds its explicit capability advertisement.
The matching T3 implementation must be installed separately. Official v0.1.0
does not support the guard, and new external waits/decisions fail closed on it.
This is not a vendor-version or runtime pin upgrade.

Keep these two files byte-identical to the corresponding files in the matching
T3 source batch. The runtime sub-executor report records the exact T3 commit and
isolated qualification jobs. Adopt a future official release by replacing the
whole package after qualification; do not infer support from protocol 2 alone.

- Local contract source: T3 commit `1b133cd8440b86d98dec99e0bcc68d086f6431cf`, based on the official commit below. Isolated source qualification is recorded in the runtime sub-executor report; publication and activation are separate.
- Upstream: https://github.com/pingdotgg/t3code
- Tag: `v0.1.0`, commit `81493efb71e8e8244f95d3e9f71d8369654ab151`
- Package: `@t3tools/contracts` 0.0.45 (private workspace package; its only runtime dependency is `effect`)
- License: upstream MIT text is preserved in `LICENSE`, copied from the repository root at the same pinned commit.
- Copied: `package.json` and every `src/*.ts` except `*.test.ts` (68 files, 27,676 lines)
- Source archive: `gh api repos/pingdotgg/t3code/tarball/81493efb71e8e8244f95d3e9f71d8369654ab151`, SHA-256 `80336b0fef0ed4860474ffade2ffdb5e1e87975e5c19447402eb38304638a1ad`
- Base tree digest: `find src -type f | sort | xargs sha256sum | sha256sum` gives `745ddc3106e9d0a64eb7dd03e8f48fb6d1628ea30175bc12b816f0d03d75dd65`
- Runtime: `effect` pinned to 4.0.4 in Chaldea's `package.json`, the version T3 v0.1.0 embeds (its pnpm catalog and the `effect@4.0.4` regions of the shipped executable).

The full package is vendored rather than a subset: the `WsRpcGroup` RPC
definitions reach most of the schema modules, and an unmodified copy makes the
next upgrade a straight replacement. The files are erasable-syntax TypeScript
(upstream compiles with `erasableSyntaxOnly`), so Node 26 runs them directly
without a build step.

The installed `t3` npm package (v0.1.0) embeds the same contracts. CI downloads
`t3-0.1.0-linux-x64.tar.gz` from the official v0.1.0 GitHub release, verifies
archive SHA-256 `f7703ff1bb8f6243580058b3ccf2c02abb62eba4b991e26bbb1da22f4b56d9b1`,
and runs disposable end-to-end servers from the extracted executable. The
executable hash is the same one previously checked on agent-a at
`~/.t3/runtime/versions/0.1.0/t3`:

- T3 executable SHA-256: `4baaddb56353e7fe0e356ec587e2546082933b6b1c0445756d4a02ef5e0f1929`
