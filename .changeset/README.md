# Changesets

This directory holds changesets — small markdown files describing pending version
bumps and release notes. Run `pnpm changeset` to author one before opening a PR
that changes published behavior. Release automation in `.github/workflows/release.yml`
picks these up, opens a version PR, and publishes to npm when that PR is merged.

Versioning is **independent** per package: adapters evolve out-of-lockstep with
their interfaces.
