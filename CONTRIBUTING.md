# Contributing to quilla-kit

## Prerequisites

- Node.js `>=22`
- pnpm `9.x`

## Getting started

```sh
pnpm install
pnpm build   # tsc -b; this is also your typecheck
pnpm test
pnpm lint
```

## Workflow

1. Create a feature branch from `main`.
2. Make your changes. Keep each package's public surface minimal — if something
   only makes sense inside one package, don't export it.
3. Add tests next to the code (`*.test.ts`).
4. Run `pnpm build && pnpm test && pnpm lint` locally.
5. If your change affects published behavior of any `@quilla-kit/*` package, run
   `pnpm changeset` and commit the generated file.
6. Open a PR. CI must pass. A maintainer will review.

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
