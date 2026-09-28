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
  config: { service: 'my-backend', level: 'info', mode: 'json' },
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
  `executionAttemptId`, and an optional `session` of type `AuthSession`).
  `session` is present iff the operation ran inside an authenticated scope;
  anonymous, system, and job contexts leave it undefined.
- `correlationId` vs. `executionAttemptId` — `correlationId` identifies the
  logical operation and can span retries (a consumer that retries a
  request may deliberately reuse it). `executionAttemptId` identifies this
  physical attempt: every `ExecutionContextFactory` method mints a fresh
  one, and it is never accepted as caller input, so a retry can't smuggle
  in a stale value. Named `executionAttemptId` rather than the shorter
  `attemptId` to stay visually distinct from the unrelated numeric
  `attempt` retry counter already logged by `@quilla-be-kit/messaging`'s
  event consumer.
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
  `createFromEventMetadata`. `createFromEventMetadata` accepts an
  `EventMetadata` instance or its parsed `toJSON()` form (`EventMetadataSource`):
  it rebuilds a session only when both `scopeId` and `userId` are strings, and
  adds the metadata's `actorAttributes` to it. Reach it via `provider.factory` so consumers
  take only one injectable (the provider) and stay internally consistent.
  `createSystemContext` and `createBaselineContext` auto-generate
  `correlationId` via `node:crypto.randomUUID()` when not supplied — so a
  context established at process boot or at a background-job tick carries
  a traceable id without the caller minting one. Pass an explicit
  `correlationId` to propagate one inbound from HTTP/events. All three
  factory methods always mint a fresh `executionAttemptId` via
  `randomUUID()` — it has no corresponding input parameter on any method,
  since accepting one would defeat its purpose of identifying a single
  physical attempt.

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
  and returns the current context's fields as a log contribution. Contributes
  `scopeId` and `userId` (from `ctx.session`, only when a session is present),
  plus `actorType`, `correlationId`, and `executionAttemptId`. All land in the
  log entry's `context` field, flat. Takes an optional
  `{ sessionKeys }`: listed extended session fields are added under
  `extra.session`. Returns an empty contribution when the
  provider is outside a scope (bootstrap logs, pre-request logs) — never
  throws.

### Values
- `executionContextFactory` — default `ExecutionContextFactory` implementation.
  Stateless; import and call its methods directly, or inject via the
  `ExecutionContextFactory` interface for testable composition.

## Session presence is the auth signal

The toolkit treats `ctx.session` as the single source of truth for "this
operation is authenticated." Either session is present (authenticated) or
it isn't (anonymous / system / job) — never half-populated. Every toolkit
surface that reads auth-derived identity does this consistently:

- `@ValidateRequest` injects `scopeId` / `userId` (and an auth stack's
  `sessionKeys`) into validated payloads only when `ctx.session` is defined
  and the schema declares those keys.
- `BaseWriteDao` reads `ctx.session?.userId` for `inserted_by` /
  `updated_by` audit columns; writes under system contexts land with
  `undefined` audit.
- `ExecutionContextEnricher` flattens `ctx.session` to `scopeId` /
  `userId` fields on log entries — log shape stays flat even though the
  context groups, so dashboards and log queries keep their field names.
- `createFromEventMetadata` rebuilds `ctx.session` in event consumers only
  when the event metadata carries both `scopeId` and `userId`.

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

### Carrying extended session fields end to end

An extended session field (say `projectId` on an API-key session bound to one
project) can be injected into validated input, logged and carried to event
consumers. Each surface opts in separately, so you list the key wherever you
want it to reach.

**1. Load it into the session.** Declare the field on your session type (see
[Extension pattern](#extension-pattern)), e.g. `readonly projectId?: string`
on `AppAuthSession`. Your stack's `sessionLoad` sets it on `ctx.session`, next
to `scopeId` and `userId`:

```ts
const machineSessionLoad: HttpMiddleware = async (request, next) => {
  const key = request.getAttribute<ApiKeyToken>(HttpAttributes.VERIFIED_TOKEN);
  const ctx = provider.getContext();
  await provider.runWithContext(
    {
      ...ctx,
      actorType: 'service',
      session: { scopeId: key.scopeId, userId: key.userId, projectId: key.projectId },
    },
    next,
  );
};
```

**2. Declare it on the stack.** See
[Session keys](../http/README.md#session-keys) in `@quilla-be-kit/http`:

```ts
authStacks: {
  bearer: { credentialVerification: bearerAuth, sessionLoad: userSessionLoad },
  apiKey: { credentialVerification: apiKeyAuth, sessionLoad: machineSessionLoad, sessionKeys: ['projectId'] },
},
```

**3. Declare it in the schema.** On `apiKey` routes the value comes from the
session; whatever the caller sent is discarded:

```ts
const ListDocuments = z.object({ projectId: z.string() });

@Get('/documents')
@ValidateRequest(ListDocuments, ['query'])
async list(req: ValidatedRequest<typeof ListDocuments>) {
  const { projectId } = req.getValidatedInput();   // always the session's projectId
}
```

**4. Log it.** Listed fields go to `extra.session` on every log entry:

```ts
new ExecutionContextEnricher(provider, { sessionKeys: ['projectId'] });
```

**5. Carry it through events.** Your `UnitOfWork` `serialize` builds the
event metadata, so you decide what an event carries. Put the extra fields in
`actorAttributes`. Consumers wired with `executionContext: { provider }`
receive them back on `ctx.session`:

```ts
serialize: (event) => {
  const ctx = provider.getContext() as AppExecutionContext;
  const metadata = EventMetadata.create({
    kind: EventKind.DOMAIN,
    correlationId: ctx.correlationId,
    actorType: ctx.actorType,
    ...(ctx.session && {
      scopeId: ctx.session.scopeId,
      userId: ctx.session.userId,
      // Bearer sessions carry no projectId, so only add it when present.
      ...(ctx.session.projectId !== undefined && {
        actorAttributes: { projectId: ctx.session.projectId },
      }),
    }),
  });
  return {
    // ...
    payload: { payload: event.toJSON(), metadata: metadata.toJSON() },
  };
},
```

**What changes for an existing app.** Nothing, until you list a key, except:

| Change | Effect |
| --- | --- |
| A route that maps `scopeId`/`userId` to a header on a stack with `sessionLoad` | Router throws at construction. Remove the mapping; the session always supplied the value. |
| Session vs. header precedence | Session fields now win over a header mapped to the same key. |
| Event metadata with `scopeId: null` / `userId: null` (a system event read back from the bus) | Now rebuilds a context without a session. It was wrongly rebuilt as authenticated with `null` ids. |

**When it fails.**

| Error | When | Fix |
| --- | --- | --- |
| `` stack "…" declares `sessionKeys` without `sessionLoad` `` | Router construction | Add the `sessionLoad` that sets the fields. |
| `stack "…" declares invalid session key` | Router construction | Use a real field name (not empty, `__proto__`, `constructor`, `prototype`). |
| `"…" sources "…" from a header, but stack "…" sources it from the session` | Router construction | Drop the header mapping for that key on routes of that stack. |
| 500: `session key "…" is declared by the auth stack but no session was loaded` | Request | The stack's `sessionLoad` must always set `ctx.session`. |
| 500: `session has no value for declared key "…"` | Request | `sessionLoad` must set the field to a non-null value. |
| `EventMetadata: reserved actorAttributes key(s)` / `actorAttributes require both scopeId and userId` | `EventMetadata.create` | Attributes can't reuse `scopeId`/`userId`, and need both ids. |

Request-time failures answer a generic 500; the specific message goes to
the server log.

**Rules for success.**

- A field is injected only where the schema declares it and the stack lists it.
- A listed field is never taken from the client, even when your
  `RequestValidator` has no `describeSchema` (the field is then stripped and
  not injected).
- `*Public` routes never receive stack-listed fields.
- `authenticatedSessionMiddleware` from `@quilla-be-kit/security` only sets
  `scopeId`/`userId`. A stack with extra fields needs its own `sessionLoad`.
- `extra` on log entries is not obfuscated. Don't log sensitive session fields.
- Only string, number and boolean fields can cross the event boundary.

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
