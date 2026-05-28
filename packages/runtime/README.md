# @quilla-be-kit/runtime

Process runtime primitives for a quilla-be-kit service:

- **`ShutdownManager`** — phased, idempotent, time-bounded graceful shutdown.
- **`Runtime`** — bridges OS signals (SIGINT/SIGTERM/SIGHUP), uncaught exceptions, and unhandled rejections to `ShutdownManager`. Owns `process.exit`.
- **`ComponentRegistry<TMeta>`** — transport-agnostic registry for your app's components, with startup-time contract validation and a bridge to `ShutdownManager`.

Zero runtime dependencies on other `@quilla-be-kit/*` packages. Node stdlib only.

## Install

```sh
pnpm add @quilla-be-kit/runtime
```

Node 22+.

## Quick start

```ts
import {
  Runtime,
  RuntimeSignals,
  ShutdownManager,
  ComponentRegistry,
} from '@quilla-be-kit/runtime';

const shutdown = new ShutdownManager({
  timeoutMs: 10_000,
  onEvent: (e) => logger.info(`shutdown: ${e.type}`, { meta: e }),
});

const components = new ComponentRegistry({
  contracts: [
    { name: 'iam', provides: ['userService'], requires: [] },
    { name: 'billing', provides: [], requires: ['userService'] },
  ],
});

const runtime = new Runtime({
  shutdownManager: shutdown,
  signals: [RuntimeSignals.SIGINT, RuntimeSignals.SIGTERM],
  onEvent: (e) => logger.info(`runtime: ${e.type}`, { meta: e }),
});

await runtime.run(async () => {
  // Your composition root — start DB, workers, HTTP server, etc.
  await db.connect();
  components.register({ name: 'iam', dispose: () => iamModule.dispose() });
  components.register({ name: 'billing', dispose: () => billingModule.dispose() });

  shutdown
    .addPhase(components.toShutdownPhase('modules'))
    .addPhase({
      name: 'database',
      participants: [{ name: 'Pg', dispose: () => db.disconnect() }],
    });

  server.listen(3000);
});
// runtime.run() never returns in a real process — it exits via process.exit
```

## Runtime

The runtime owns the process from startup through exit.

```ts
type RuntimeOptions = {
  shutdownManager: ShutdownManager;
  signals?: readonly RuntimeSignal[];      // default ['SIGINT', 'SIGTERM', 'SIGHUP']
  trapUncaughtException?: boolean;         // default true
  trapUnhandledRejection?: boolean;        // default true
  onEvent?: (event: RuntimeEvent) => void;
  exit?: (code: number) => void;           // default process.exit — injectable for tests
};
```

`run(startup)` does the following, in order:

1. Registers OS signal + uncaught handlers.
2. Calls your `startup` callback. This is where you connect resources and start serving.
3. Waits for a shutdown trigger: a handled signal, an uncaught error, a startup error, or a programmatic `runtime.triggerShutdown()`.
4. Calls `shutdownManager.shutdown()` and awaits all drain phases.
5. Computes an exit code — `0` if everything drained cleanly, `1` otherwise (startup error, drain errors, or timeout).
6. Unregisters its handlers and calls `exit(code)`.

Only one `run()` per `Runtime` instance — a second call throws.

### Programmatic shutdown

Use `runtime.triggerShutdown()` to initiate shutdown from inside your app — e.g. a failed health check or a hot-reload signal that doesn't map to a POSIX signal. Do **not** call `shutdownManager.shutdown()` directly; the runtime won't observe it and its promise will dangle.

### Events

`onEvent` receives a discriminated union. Consume with exhaustive `switch`:

```ts
onEvent: (e) => {
  switch (e.type) {
    case 'startup-start':        logger.info('starting'); break;
    case 'startup-complete':     logger.info(`ready in ${e.durationMs}ms`); break;
    case 'startup-error':        logger.error('startup failed', e.error); break;
    case 'signal-received':      logger.info(`signal ${e.signal}`); break;
    case 'uncaught-exception':   logger.error('uncaught', e.error); break;
    case 'unhandled-rejection':  logger.error('rejection', e.reason); break;
    case 'shutdown-triggered':   logger.info(`shutdown: ${e.cause.type}`); break;
    case 'shutdown-complete':    logger.info(`exit ${e.exitCode} after ${e.result.durationMs}ms`); break;
  }
}
```

Errors thrown inside `onEvent` are swallowed — the observer cannot break the runtime.

Event payload shapes (all readonly):

| `type` | Payload |
| --- | --- |
| `startup-start` | — |
| `startup-complete` | `durationMs: number` |
| `startup-error` | `error: unknown` |
| `signal-received` | `signal: RuntimeSignal` (`'SIGINT' \| 'SIGTERM' \| 'SIGHUP'`) |
| `uncaught-exception` | `error: unknown` |
| `unhandled-rejection` | `reason: unknown` |
| `shutdown-triggered` | `cause: ShutdownCause` (tagged: `signal` / `uncaught` / `startup-error` / `programmatic`) |
| `shutdown-complete` | `result: ShutdownResult`, `exitCode: number` |

`RuntimeSignals` is a named constant map — `RuntimeSignals.SIGINT`,
`.SIGTERM`, `.SIGHUP` — and `RuntimeSignal` is the union type. Pass an
array of signals to `runtime` options to narrow the trap set (e.g. only
`[RuntimeSignals.SIGTERM]` inside a container where `SIGINT` is owned by
the orchestrator).

## ShutdownManager

Orchestrates phased teardown. Phases run sequentially in insertion order; participants inside a phase run concurrently.

```ts
const shutdown = new ShutdownManager({
  timeoutMs: 10_000,
  onEvent: (e) => logger.info(e.type, { meta: e }),
});

shutdown
  .addPhase({
    name: 'http',
    participants: [{ name: 'HonoServer', dispose: () => server.close() }],
  })
  .addPhase({
    name: 'workers',
    participants: [
      { name: 'OutboxForwarder', dispose: () => forwarder.dispose() },
      { name: 'EventConsumer', dispose: () => consumer.dispose() },
    ],
  })
  .addPhase({
    name: 'database',
    participants: [{ name: 'Pg', dispose: () => db.disconnect() }],
  });
```

`shutdown()` is idempotent — concurrent callers share the same in-flight promise. `isDraining()` returns `true` once `shutdown()` has been called and the phase sequence is running — useful for health checks that want to signal readiness=false before connections are actually closed:

```ts
app.get('/healthz', (c) => {
  if (shutdown.isDraining()) return c.json({ ok: false }, 503);
  return c.json({ ok: true });
});
``` Participant errors don't abort the phase; they're collected into `ShutdownResult.phases[n].errors` and logged via the `participant-error` event. Shutdown that exceeds `timeoutMs` sets `result.timedOut = true` and emits a `timeout` event.

## ComponentRegistry

A transport-agnostic registry for the "logical units" of your app — what a modular-monolith calls *modules*, or a microservice calls *bounded contexts*. The registry carries whatever metadata your composition root needs (`TMeta`) and produces a `ShutdownPhaseConfig` for modules that want to participate in drain.

```ts
type Component<TMeta = unknown> = {
  readonly name: string;
  readonly meta?: TMeta;
  dispose?(): Promise<void>;
};

type ComponentContract = {
  readonly name: string;
  readonly provides: readonly string[];
  readonly requires: readonly string[];
};
```

### Contract validation

Pass `contracts` at construction and invalid dependency graphs throw **before** any I/O runs:

```ts
// Throws: Component "billing" requires token "userService" but no component provides it
new ComponentRegistry({
  contracts: [
    { name: 'billing', provides: [], requires: ['userService'] },
  ],
});
```

Two components providing the same token also throws. Tokens are opaque strings — your app decides what they represent.

### Bridging to ShutdownManager

```ts
components
  .register({ name: 'iam', dispose: () => iamModule.dispose() })
  .register({ name: 'billing', dispose: () => billingModule.dispose() })
  .register({ name: 'read-only-helper' }); // no dispose — skipped in phase

shutdown.addPhase(components.toShutdownPhase('modules'));
```

`toShutdownPhase(name)` produces a phase containing only components that declared a `dispose`.

### Typing metadata

`ComponentRegistry` is generic over its metadata type. Use it to attach HTTP routes, event subscribers, background jobs, or anything else your app needs to iterate over:

```ts
type ServiceMeta = {
  readonly controllers: readonly Controller[];
  readonly subscribers: readonly EventSubscription[];
};

const components = new ComponentRegistry<ServiceMeta>();
components.register({
  name: 'iam',
  meta: { controllers: [...], subscribers: [...] },
  dispose: () => iamModule.dispose(),
});

for (const c of components.getAll()) {
  router.mount(c.meta?.controllers ?? []);
  for (const sub of c.meta?.subscribers ?? []) eventBus.subscribe(sub);
}
```

`getByName(name)` retrieves a single registered component by name, returning `undefined` if not found. Useful in composition roots that wire inter-module dependencies after registration:

```ts
const iamComponent = components.getByName('iam');
// Component<ServiceMeta> | undefined
```

The registry stays framework-agnostic; your metadata stays type-safe.

## Testing

Inject a fake `exit` and avoid real signal traps in unit tests:

```ts
const exit = vi.fn();
const shutdown = new ShutdownManager({ timeoutMs: 100 });
const runtime = new Runtime({
  shutdownManager: shutdown,
  exit,
  trapUncaughtException: false,
  trapUnhandledRejection: false,
});

await runtime.run(async () => {
  runtime.triggerShutdown();
});

expect(exit).toHaveBeenCalledWith(0);
```
