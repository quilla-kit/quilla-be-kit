# @quilla-be-kit/execution-context

Per-operation execution context: `ExecutionContext` type,
`ExecutionContextProvider` interface, `AsyncExecutionContextProvider`
(AsyncLocalStorage-backed), `executionContextFactory`, and
`ExecutionContextEnricher` for bridging into `@quilla-be-kit/observability`.

## Why this exists

The execution context carries the **actor** (who), **scope** (tenant /
workspace / project / whatever the consumer's isolation boundary is), **user**
(when authenticated), and **correlation id** (tracing) for a single logical
operation. Two quilla-be-kit invariants rely on it:

- **Persistence** uses it to populate audit fields (`inserted_by`,
  `updated_by`) without requiring callers to pass them.
- **Observability** uses it to enrich every log line emitted during the
  operation.

## Install

```sh
pnpm add @quilla-be-kit/execution-context
```

## Quick start

```ts
import {
  AsyncExecutionContextProvider,
  executionContextFactory,
  ExecutionContextEnricher,
} from '@quilla-be-kit/execution-context';
import { createLoggerFactory } from '@quilla-be-kit/observability';

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
- `ExecutionContext` — the base shape (`actorType`, `correlationId`,
  and an optional `session` of type `AuthSession`). `session` is present
  iff the operation ran inside an authenticated scope; anonymous, system,
  and job contexts leave it undefined.
- `AuthSession` — the authenticated-caller identity (`{ scopeId, userId }`).
  Extensible by intersection for richer session data (roles, session id,
  authenticatedAt, etc.).

### Interfaces
- `ExecutionContextProvider` — `getContext()` + `runWithContext(ctx, fn)` +
  readonly `factory` (the paired `ExecutionContextFactory`).
  `getContext()` **throws** if called outside a `runWithContext` scope.
  **`runWithContext(fn)` is async-only** — synchronous code cannot establish a
  scope; wrap it in `async () => {...}` at the boundary.
- `ExecutionContextFactory` — `createSystemContext(actorType)`, `createBaselineContext`,
  `createFromEventMetadata`. Reach it via `provider.factory` so consumers
  take only one injectable (the provider) and stay internally consistent.
  `createSystemContext` and `createBaselineContext` auto-generate
  `correlationId` via `node:crypto.randomUUID()` when not supplied — so a
  context established at process boot or at a background-job tick carries
  a traceable id without the caller minting one. Pass an explicit
  `correlationId` to propagate one inbound from HTTP/events.

  `createSystemContext` accepts `'system'` or `'job'` as `actorType`:
  - `'system'` — process-level operations with no scheduled-job framing:
    startup tasks, health-check callbacks, migration runners.
  - `'job'` — a background-job tick. `@quilla-be-kit/jobs` calls this
    automatically for each `InProcessJobRunner` tick; pass it explicitly
    when you implement a custom `JobRunner` or drive job ticks by hand.

### Classes
- `AsyncExecutionContextProvider` — Node-native `AsyncLocalStorage`-backed
  provider. Owns its own storage instance; intended one-per-process. Takes
  an optional `{ factory }` in its constructor — defaults to
  `executionContextFactory` if omitted. Pass a custom factory when you've
  extended `ExecutionContext` with new fields.
- `ExecutionContextEnricher` — `LogEntryEnricher` that reads from a provider
  and returns the current context's fields as a log contribution. Returns an
  empty contribution when the provider is outside a scope (bootstrap logs,
  pre-request logs) — never throws.

### Values
- `executionContextFactory` — default `ExecutionContextFactory` implementation.
  Stateless; import and call its methods directly, or inject via the
  `ExecutionContextFactory` interface for testable composition.

## Session presence is the auth signal

The toolkit treats `ctx.session` as the single source of truth for "this
operation is authenticated." Either session is present (authenticated) or
it isn't (anonymous / system / job) — never half-populated. Every toolkit
surface that reads auth-derived identity does this consistently:

- `@ValidateRequest` injects `scopeId` / `userId` into validated payloads
  only when `ctx.session` is defined and the schema declares those keys.
- `BaseWriteDao` reads `ctx.session?.userId` for `inserted_by` /
  `updated_by` audit columns; writes under system contexts land with
  `undefined` audit.
- `ExecutionContextEnricher` flattens `ctx.session` to `scopeId` /
  `userId` fields on log entries — log shape stays flat even though the
  context groups, so dashboards and log queries keep their field names.

Consumer code applies the same discipline: check `ctx.session` once, then
read `scopeId` / `userId` off it. Avoid reconstituting half-states
(`ctx.session?.scopeId && !ctx.session?.userId`) — they can't happen by
construction.

## Extension pattern

The base `AuthSession` is deliberately minimal (`scopeId` + `userId`). If
you need roles, permissions, a session id, an authenticated-at timestamp,
or any other product-shaped fields, **extend by intersection** in your
consumer project:

```ts
import type { AuthSession, ExecutionContext } from '@quilla-be-kit/execution-context';

// Pick whatever session shape fits your project.
type AppAuthSession = AuthSession & {
  readonly sessionId: string;
  readonly displayName: string;
  readonly roles: readonly string[];
  readonly authenticatedAt: Date;
};

type AppExecutionContext = ExecutionContext & {
  readonly session?: AppAuthSession;
};

// Auth middleware constructs the enriched context:
const ctx: AppExecutionContext = {
  ...executionContextFactory.createBaselineContext({ correlationId }),
  actorType: 'user',
  session: {
    scopeId: jwt.scope,
    userId: jwt.sub,
    sessionId: jwt.sid,
    displayName: jwt.name,
    roles: jwt.roles,
    authenticatedAt: new Date(),
  },
};

await provider.runWithContext(ctx, handler);
```

Read sites cast once:

```ts
const ctx = provider.getContext() as AppExecutionContext;
if (ctx.session?.roles.includes('admin')) { /* ... */ }
```

If your project has many read sites, wrap the provider once:

```ts
// Consumer-side helper
export function getAppContext(): AppExecutionContext {
  return provider.getContext() as AppExecutionContext;
}
```

Then the rest of the codebase uses `getAppContext()` with full typing.

**Why not ship an opinionated full session type?** Because sessions beyond
`scopeId` + `userId` vary too widely across services (displayName vs.
email vs. userType vs. tenant-role vs. scope-based permissions, etc.).
Picking a richer base nudges every consumer toward a shape most of them
don't need. The toolkit ships the minimal `AuthSession` as a contract for
its own surfaces (audit, validation, enrichment) and lets consumers own
the rest.

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
- **`ActorType` comes from `@quilla-be-kit/ddd`** — same extensible union used
  by `EventMetadata`. Consistent vocabulary across the toolkit.
