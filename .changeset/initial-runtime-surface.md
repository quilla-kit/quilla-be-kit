---
"@quilla-be-kit/runtime": minor
"@quilla-be-kit/messaging": minor
---

Initial runtime surface. Absorbs the deleted `@quilla-be-kit/lifecycle` package and adds:

- `Runtime` — OS signal + uncaught-error bridge that owns `process.exit`. Takes a startup callback; drives the process from start to drain to exit.
- `ComponentRegistry<TMeta>` — transport-agnostic registry with contract validation on construction (`{ contracts }`). Bridges to `ShutdownManager` via `toShutdownPhase(name)`.
- `ShutdownManager`, `Disposable`, shutdown types — moved verbatim from the deleted lifecycle package.

Messaging re-points `Disposable` import at `@quilla-be-kit/runtime` (no API change).
