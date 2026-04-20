# @quilla-kit/lifecycle

Lifecycle primitives: `Disposable` and `ShutdownManager` — a phased,
idempotent, time-bounded shutdown coordinator with a draining flag.

Zero runtime dependencies.

## Install

```sh
pnpm add @quilla-kit/lifecycle
```

## Usage

```ts
import { ShutdownManager } from '@quilla-kit/lifecycle';

const shutdown = new ShutdownManager({
  timeoutMs: 30_000,
  onEvent: (e) => logger.info('[shutdown]', { meta: e }),
});

shutdown
  .addPhase({
    name: 'http',
    participants: [{ name: 'HonoServer', dispose: () => server.shutdown() }],
  })
  .addPhase({
    name: 'database',
    participants: [{ name: 'Postgres', dispose: () => pool.end() }],
  });

// When SIGTERM/SIGINT arrives (wired by @quilla-kit/runtime):
const result = await shutdown.shutdown();
process.exit(result.timedOut || result.totalErrors > 0 ? 1 : 0);
```

## Guarantees

- **Phased.** Phases run sequentially in insertion order; participants within
  a phase run concurrently.
- **Idempotent.** Concurrent or duplicate `shutdown()` calls coalesce to one
  in-flight run and return the same result.
- **Error-isolated.** A failing participant is captured in the result and
  emitted via `participant-error`; later phases still run.
- **Time-bounded.** Global `timeoutMs` unblocks `shutdown()` and marks the
  result `timedOut: true`. The caller decides how to exit.
- **Draining flag.** `isDraining()` flips `true` when shutdown starts, for
  readiness probes that need to deregister before connections drop.
- **Observer-only side channel.** Events are delivered to `onEvent`; the
  package has no logger, signal-handler, or exit dependencies — those live
  in `@quilla-kit/runtime`.

## Events

```ts
type ShutdownEvent =
  | { type: 'shutdown-start'; phases: readonly string[]; timeoutMs: number }
  | { type: 'phase-start'; phase: string; participants: readonly string[] }
  | { type: 'phase-end'; phase: string; durationMs: number; errorCount: number }
  | { type: 'participant-error'; phase: string; participant: string; error: unknown }
  | { type: 'timeout'; timeoutMs: number }
  | { type: 'shutdown-complete'; durationMs: number; totalErrors: number };
```
