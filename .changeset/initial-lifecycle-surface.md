---
"@quilla-kit/lifecycle": minor
---

Initial public surface: `Disposable` interface, `ShutdownManager` class,
`ShutdownPhaseConfig` / `ShutdownEvent` / `ShutdownResult` types.

Key design decisions:

- **Dynamic named phases, not a fixed enum.** `addPhase({ name, participants })`
  lets each app define its own shutdown topology (e.g. `http → jobs →
  modules → redis → database`). Insertion order is the run order; phases
  execute sequentially; participants within a phase execute concurrently.
- **`Disposable.name` is load-bearing** for observability — every event
  surfaces the participant name so ops can identify which resource failed
  or timed out.
- **Error policy: continue and collect.** A failing participant is captured
  in `ShutdownResult.phases[i].errors` and emitted via `participant-error`;
  later phases still run. Aborting on first error would leak resources.
- **Observer callback, not a `Logger` dependency.** Lifecycle stays Layer 0
  with zero external deps; consumers wire `onEvent` to their logger in
  `@quilla-kit/runtime`.
- **Timeout is advisory, not destructive.** When `timeoutMs` elapses,
  `shutdown()` resolves with `timedOut: true` and emits a `timeout` event.
  The caller (typically `@quilla-kit/runtime`) decides the exit code; the
  package never calls `process.exit`.
- **Signal handling is out of scope.** `SIGTERM`/`SIGINT` wiring belongs in
  `@quilla-kit/runtime` — lifecycle must remain platform-agnostic and
  testable without mocking signals.
- **Idempotent `shutdown()`.** Concurrent calls return the same in-flight
  `Promise<ShutdownResult>`; disposables run exactly once.
- **`isDraining()` as method**, not a public mutable field, so consumers
  wire readiness probes through a stable contract.
- **No separate `NoopShutdownManager`.** A `ShutdownManager` with no phases
  registered is already a no-op; shipping a second class would be ceremony.
