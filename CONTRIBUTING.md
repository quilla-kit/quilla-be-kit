# Contributing to quilla-kit

## Prerequisites

- Node.js `>=22`
- pnpm `9.x`

## Getting started

```sh
pnpm install
pnpm build       # tsc -b across the workspace; also typechecks src/
pnpm typecheck   # typechecks tests/ against src/ (per-package tsconfig.test.json)
pnpm test        # vitest
pnpm lint        # biome check
```

## Workflow

1. Create a feature branch from `main`.
2. Make your changes. Keep each package's public surface minimal — if something
   only makes sense inside one package, don't export it.
3. Add tests in the package's `tests/` folder, mirroring the `src/` layout.
   Shared fixtures and helpers belong in `tests/helpers/` or `tests/fixtures/`.
4. If the package doesn't yet have a `tsconfig.test.json`, add one (extends
   the package's `tsconfig.json` with `composite: false`, `noEmit: true`,
   `include: ["src/**/*", "tests/**/*"]`) plus a `"typecheck"` script that
   runs `tsc -p tsconfig.test.json`.
5. Run `pnpm build && pnpm typecheck && pnpm test && pnpm lint` locally.
6. If your change affects published behavior of any `@quilla-kit/*` package,
   run `pnpm changeset` and commit the generated file.
7. Open a PR. CI must pass. A maintainer will review.

## Package boundaries

The interface-vs-adapter split is load-bearing. Before adding a dependency in a
package's `package.json`, ask:

- Does this push a runtime concern into an interface package? If yes, reshape.
- Does this couple two abstractions that consumers might want to swap
  independently? If yes, reshape.

Interface packages (`ddd`, `lifecycle`, `observability`, `execution-context`,
`http`, `persistence`, `messaging`, `runtime`) must have zero external runtime
dependencies unless there is a compelling reason documented in the PR.

## Releases

Releases are automated via [changesets](https://github.com/changesets/changesets)
and the `Release` GitHub Actions workflow:

- Every PR that changes published behavior must include a changeset.
- When changesets land on `main`, the workflow opens (or updates) a "Version
  Packages" PR that bumps versions and updates changelogs.
- Merging the Version Packages PR publishes the affected packages to npm with
  provenance attestation.

Versioning is **independent** per package.
