# @quilla-kit/execution-context

Per-operation execution context: `ExecutionContext` type,
`ExecutionContextProvider` interface, `AsyncExecutionContextProvider`
(AsyncLocalStorage-backed), `executionContextFactory`, and
`ExecutionContextEnricher` for bridging into `@quilla-kit/observability`.

## Why this exists

The execution context carries the **actor** (who), **scope** (tenant /
workspace / project / whatever the consumer's isolation boundary is), **user**
(when authenticated), and **correlation id** (tracing) for a single logical
operation. Two quilla-kit invariants rely on it:

- **Persistence** uses it to populate audit fields (`inserted_by`,
  `updated_by`) without requiring callers to pass them.
- **Observability** uses it to enrich every log line emitted during the
  operation.

## Install

```sh
pnpm add @quilla-kit/execution-context
```

## Quick start

```ts
import {
  AsyncExecutionContextProvider,
  executionContextFactory,
  ExecutionContextEnricher,
} from '@quilla-kit/execution-context';
import { createLoggerFactory } from '@quilla-kit/observability';

// Composition root — one instance per process.
const provider = new AsyncExecutionContextProvider();

const loggerFactory = createLoggerFactory({
  config: { level: 'info', mode: 'json' },
  enrichers: [new ExecutionContextEnricher(provider)],
});

// Any code path that wants a log with context goes through runWithContext:
const ctx = executionContextFactory.createSystemContext('system');
await provider.runWithContext(ctx, async () => {
  const logger = loggerFactory.create('startup');
  logger.info('server booting');
});
```

## API

### Types
- `ExecutionContext` — the base shape (`scopeId?`, `actorType`, `userId?`,
  `correlationId`).

### Interfaces
- `ExecutionContextProvider` — `getContext()` + `runWithContext(ctx, fn)`.
  `getContext()` **throws** if called outside a `runWithContext` scope.
- `ExecutionContextFactory` — `createSystemContext`, `createBaselineContext`,
  `createFromEventMetadata`.

### Classes
- `AsyncExecutionContextProvider` — Node-native `AsyncLocalStorage`-backed
  provider. Owns its own storage instance; intended one-per-process.
- `ExecutionContextEnricher` — `LogEntryEnricher` that reads from a provider
  and returns the current context's fields as a log contribution. Returns an
  empty contribution when the provider is outside a scope (bootstrap logs,
  pre-request logs) — never throws.

### Values
- `executionContextFactory` — default `ExecutionContextFactory` implementation.
  Stateless; import and call its methods directly, or inject via the
  `ExecutionContextFactory` interface for testable composition.

## Extension pattern

The base `ExecutionContext` is deliberately minimal. If you need session
data, roles, permissions, or any other product-shaped fields, **extend by
intersection** in your consumer project:

```ts
import type { ExecutionContext } from '@quilla-kit/execution-context';

// Pick whatever session shape fits your project.
type MySession = {
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly authenticatedAt: Date;
};

type MyExecutionContext = ExecutionContext & {
  readonly session?: MySession;
};

// Auth middleware constructs the enriched context:
const ctx: MyExecutionContext = {
  ...executionContextFactory.createBaselineContext({ correlationId }),
  actorType: 'user',
  userId: jwt.sub,
  session: { displayName: jwt.name, roles: jwt.roles, authenticatedAt: new Date() },
};

await provider.runWithContext(ctx, handler);
```

Read sites cast once:

```ts
const ctx = provider.getContext() as MyExecutionContext;
if (ctx.session?.roles.includes('admin')) { /* ... */ }
```

If your project has many read sites, wrap the provider once:

```ts
// Consumer-side helper
export function getAppContext(): MyExecutionContext {
  return provider.getContext() as MyExecutionContext;
}
```

Then the rest of the codebase uses `getAppContext()` with full typing.

**Why not ship an opinionated session type?** Because session shape varies too
widely across services (displayName vs. email vs. userType vs. tenant-role vs.
scope-based permissions, etc.). Picking a base nudges every consumer toward
a shape most of them don't need. The toolkit stays neutral on authorization
and session semantics; consumers own those.

## Design notes

- **Throws on missing context, not silent fallback.** Masking "forgot to run
  inside `runWithContext`" bugs with a default anonymous context is a
  substrate-grade anti-pattern. Callers that legitimately don't have one
  establish it explicitly via `createBaselineContext()` or
  `createSystemContext(...)`.
- **No `ActorSession` / `permissions` in the base type.** See extension pattern
  above.
- **Enricher returns `{}` silently when the provider throws.** Logs emitted
  outside a scope (bootstrap, scheduler, pre-auth middleware) should still
  succeed — they just don't carry execution-context fields.
- **`ActorType` comes from `@quilla-kit/ddd`** — same extensible union used
  by `EventMetadata`. Consistent vocabulary across the toolkit.
