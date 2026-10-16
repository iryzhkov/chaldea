# Vendored T3 contracts

This directory is an unmodified copy of `packages/contracts` from T3 Code, the
official stable release that Chaldea targets. Do not edit these files; replace
them wholesale when adopting a new T3 stable, after the contract and
end-to-end tests pass against that release.

- Upstream: https://github.com/pingdotgg/t3code
- Tag: `v0.1.0`, commit `81493efb71e8e8244f95d3e9f71d8369654ab151`
- Package: `@t3tools/contracts` 0.0.45 (private workspace package; its only runtime dependency is `effect`)
- Copied: `package.json` and every `src/*.ts` except `*.test.ts` (68 files, 27,676 lines)
- Source archive: `gh api repos/pingdotgg/t3code/tarball/81493efb71e8e8244f95d3e9f71d8369654ab151`, SHA-256 `80336b0fef0ed4860474ffade2ffdb5e1e87975e5c19447402eb38304638a1ad`
- Tree digest: `find src -type f | sort | xargs sha256sum | sha256sum` gives `745ddc3106e9d0a64eb7dd03e8f48fb6d1628ea30175bc12b816f0d03d75dd65`
- Runtime: `effect` pinned to 4.0.4 in Chaldea's `package.json`, the version T3 v0.1.0 embeds (its pnpm catalog and the `effect@4.0.4` regions of the shipped executable).

The full package is vendored rather than a subset: the `WsRpcGroup` RPC
definitions reach most of the schema modules, and an unmodified copy makes the
next upgrade a straight replacement. The files are erasable-syntax TypeScript
(upstream compiles with `erasableSyntaxOnly`), so Node 26 runs them directly
without a build step.

The installed `t3` npm package (v0.1.0) embeds the same contracts; the
end-to-end tests run against that executable, also installed by T3 itself as
`~/.t3/runtime/versions/0.1.0/t3`. CI checks it against this line:

- T3 executable SHA-256: `4baaddb56353e7fe0e356ec587e2546082933b6b1c0445756d4a02ef5e0f1929`
