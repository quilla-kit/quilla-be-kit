# @quilla-be-kit/execution-context

Per-operation execution context: `ExecutionContext` type,
`ExecutionContextProvider` interface, `AsyncExecutionContextProvider`
(AsyncLocalStorage-backed), `executionContextFactory`, `resolveScopeId`,
policy-governed `crossScope`, the `ExecutionContextView` that handlers, jobs
and routes read, `toEventMetadataSource`, and `ExecutionContextEnricher` for
bridging into `@quilla-be-kit/observability`.

## Why this exists

The execution context carries the **actor** (who), **scope** (tenant /
workspace / project / whatever the consumer's isolation boundary is), **user**
(when authenticated), and **correlation id** (tracing) for a single logical
operation. Two quilla-be-kit invariants rely on it:

- **Persistence** uses it to populate audit fields (`inserted_by`,
  `updated_by`) without requiring callers to pass them.
- **Observability** uses it to enrich every log line emitted during the
  operation.

Event handlers (`@quilla-be-kit/messaging`), jobs (`@quilla-be-kit/jobs`) and
routes (`@quilla-be-kit/http`) read it through `getContext()`, which returns
an `ExecutionContextView`, without injecting the provider.

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
  `executionAttemptId`, an optional `session` of type `AuthSession`, and an
  optional `scopeId`). `session` is present iff the operation ran inside an
  authenticated scope; anonymous, system, and job contexts leave it
  undefined. `scopeId` is the scope affected by work that has no session
  (see [Scope without a session](#scope-without-a-session)); it never sits
  beside a `session`.
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
- `crossedFrom` — on a context moved by `crossScope`, the scope it came from
  (the outermost one across nested crossings). For attribution in logs and
  event metadata only; never authorize on it, since a consumer rebuilds it
  from event metadata.
- `ExecutionContextView` — the read-only props handlers, jobs and routes
  receive from `getContext()` in `@quilla-be-kit/messaging`, `jobs` and
  `http`: `actorType`, `correlationId`, `executionAttemptId`, the resolved
  `scopeId`, `userId` and `session` (authenticated only), and `crossedFrom`.
  `ScopedExecutionContextView` guarantees `scopeId`;
  `SessionExecutionContextView` also guarantees `userId` and `session`.

### Interfaces
- `ExecutionContextProvider` — `getContext()` + `runWithContext(ctx, fn)` +
  `withScope(scopeId, fn)` + `crossScope(scopeId, fn)` + readonly `factory`
  (the paired `ExecutionContextFactory`).
  `getContext()` **throws** if called outside a `runWithContext` scope.
  `withScope` runs `fn` in the current context scoped to `scopeId` (see
  [Scope without a session](#scope-without-a-session)); `crossScope` also
  moves between scopes (see [Crossing scopes](#crossing-scopes)). A custom
  provider implements all four methods; `crossExecutionContext` builds the
  context for `crossScope`.
  **`runWithContext(fn)` is async-only** — synchronous code cannot establish a
  scope; wrap it in `async () => {...}` at the boundary.
- `ExecutionContextFactory` — `createSystemContext(actorType)`, `createBaselineContext`,
  `createFromEventMetadata`. `createFromEventMetadata` accepts an
  `EventMetadata` instance or its parsed `toJSON()` form (`EventMetadataSource`):
  it rebuilds a session only when both `scopeId` and `userId` are strings, and
  adds the metadata's `actorAttributes` to it. A `scopeId` without a `userId`
  comes back as the context's session-less `scopeId`. Reach it via `provider.factory` so consumers
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
- `ScopeCrossingPolicy` — `authorize(context, targetScopeId)` and an optional
  `projectContext(context, targetScopeId)`. See
  [Crossing scopes](#crossing-scopes).

### Classes
- `AsyncExecutionContextProvider` — Node-native `AsyncLocalStorage`-backed
  provider. Owns its own storage instance; intended one-per-process. Takes
  an optional `{ factory, scopeCrossing }` in its constructor. `factory`
  defaults to `executionContextFactory`; pass a custom one when you've
  extended `ExecutionContext` with new fields. `scopeCrossing` is the
  `ScopeCrossingPolicy` (or a function returning it, resolved on first use)
  that `crossScope` needs to move between scopes.
- `MissingScopeError` / `MissingSessionError` — thrown by `requireScopeId` /
  `requireSession` / `requireContext`. Match them with
  `MissingScopeError.is(err)`, which compares the error code and so still
  works when two copies of the package are installed.
- `ExecutionContextEnricher` — `LogEntryEnricher` that reads from a provider
  and returns the current context's fields as a log contribution. Contributes
  `scopeId` (from `ctx.session`, or the session-less `ctx.scopeId`), `userId`
  (from `ctx.session` only), plus `actorType`, `correlationId`, and
  `executionAttemptId`. All land in the
  log entry's `context` field, flat. Takes an optional
  `{ sessionKeys }`: listed extended session fields are added under
  `extra.session`. A crossed context also logs `extra.crossedFrom`.
  Returns an empty contribution when the
  provider is outside a scope (bootstrap logs, pre-request logs) — never
  throws.

### Functions
- `resolveScopeId(ctx)` — the operation's scope: `ctx.session.scopeId` when
  authenticated, otherwise `ctx.scopeId`, otherwise `undefined`. Throws when
  both are set. Read scope through it rather than from either field.
- `requireScopeId(ctx)` / `requireSession(ctx)` — the scope or the session
  for work that needs one by contract. Throw `MissingScopeError` (code
  `MISSING_SCOPE`) / `MissingSessionError` (code `MISSING_SESSION`), both
  `InternalError`s from `@quilla-be-kit/errors`: a missing scope is a wiring
  defect, not a caller error.
- `requireContext(ctx, requirement)` — the same checks for a
  `ContextRequirement` (`'scope' | 'session'`; a session always carries a
  scope).
- `toExecutionContextView(ctx)` — the `ExecutionContextView` of a context.
- `readAttemptContext(provider, attemptId)` — the current context while it
  still belongs to that execution attempt (`withScope` and `crossScope` keep
  the attempt id), otherwise `undefined`. Lets a handle given to a handler or
  job detect it outlived its run.
- `crossExecutionContext(current, targetScopeId, policy)` — the context
  `crossScope` runs in; for custom providers.
- `toEventMetadataSource(ctx, { actorAttributeKeys })` — the event metadata a
  context should stamp; the inverse of `createFromEventMetadata`. See
  [Emitting event metadata](#emitting-event-metadata).

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
  when the event metadata carries both `scopeId` and `userId`. A lone
  `scopeId` becomes the context's session-less `scopeId`, never a session.

The session-less `ctx.scopeId` never authenticates anyone, grants a
permission, or reaches `@ValidateRequest` injection or audit columns. It
only says which scope the work affects.

Consumer code applies the same discipline: check `ctx.session` once, then
read `scopeId` / `userId` off it. Avoid reconstituting half-states
(`ctx.session?.scopeId && !ctx.session?.userId`) — they can't happen by
construction.

## Scope without a session

Work with no authenticated caller — a background job, a public flow such as
account activation, a system task — can still affect one scope. It states
that scope on its context with `withScope`, which merges into the current
context instead of building a new one by hand:

```ts
class ExpireInvitationsJob implements BackgroundJob {
  // ...
  async execute(): Promise<void> {
    for (const { scopeId } of await this.invitations.findExpired()) {
      await this.provider.withScope(scopeId, () =>
        this.uow.transaction(async (ctx) => {
          // your serializer and the log enricher read the scope here
        }),
      );
    }
  }
}
```

A job gets this loop from `@quilla-be-kit/jobs`:
`execution.forEachScope(byScope, fn)` runs each scope in its own `withScope`
and keeps going when one fails.

| Current context | `withScope(X, fn)` |
| --- | --- |
| no scope | runs `fn` in the current context plus `scopeId: X` |
| scope is already `X` (session or session-less) | runs `fn` in the current context — no new one |
| scope is `Y` (session or session-less) | rejects; no silent choice between the two |

`correlationId`, `executionAttemptId`, `actorType` and `session` are always
kept. It rejects outside a context; establish one first with
`createSystemContext(...)` or `createBaselineContext()`.

Read the scope with `resolveScopeId(ctx)`, which covers both the session and
the session-less case. A context must never carry both: `resolveScopeId`
throws when it does.

Moving into a *different* scope is `crossScope`, below.

## Crossing scopes

`provider.crossScope(scopeId, fn)` runs `fn` in the current context moved to
`scopeId` — for example a platform operator acting on a tenant. Like
`withScope`, it adds a scope to an unscoped context and joins the scope the
context already has. Moving from one scope to another is an authorization
decision, so it needs a `ScopeCrossingPolicy` on the provider; without one it
rejects.

```ts
const provider = new AsyncExecutionContextProvider({
  scopeCrossing: {
    authorize: (ctx, targetScopeId) => {
      if (ctx.session?.scopeId !== PLATFORM_SCOPE_ID) {
        throw new ForbiddenError({ message: 'Only platform operators act on other scopes.' });
      }
    },
  },
});

await provider.crossScope(tenantId, () =>
  uow.transaction(async (ctx) => {
    // DAOs, the outbox serializer and the logger see tenantId here,
    // and the context records crossedFrom: PLATFORM_SCOPE_ID.
  }),
);
```

**What the kit enforces** — the policy cannot change these:

- `actorType`, `correlationId`, `executionAttemptId` and the session's
  `userId` are kept; changing the user would be impersonation.
- The new context is scoped to the target, and never carries both a session
  and a session-less `scopeId`. A session-less context stays session-less.
- `crossedFrom` is set by the kit to the outermost origin, and cleared when
  you cross back to it.
- By default only `actorType`, `correlationId`, `executionAttemptId` and the
  scope (with the session's `userId`) survive. Every other field — extended
  session fields such as a `projectId` bound to the source scope, or fields
  you added to the context — is dropped.

**What your policy decides:**

- `authorize(context, targetScopeId)` — throw to deny, with your own error
  (a `ForbiddenError` answers 403 over HTTP). It runs in the **source**
  context: a scoped repository it calls filters by the source scope. It is
  only called for scope-to-scope moves; adding a scope to unscoped work is
  `withScope`'s rule and needs no policy.
- `projectContext(context, targetScopeId)` — optional; builds the context in
  the target, for example to rebuild roles for it. The kit validates the
  result against the rules above.

A policy that needs repositories can't exist before the provider those
repositories use. Pass a function instead; it is resolved on the first
crossing:

```ts
const provider = new AsyncExecutionContextProvider({
  scopeCrossing: () => new MembershipPolicy(memberships, roles),
});

class MembershipPolicy implements ScopeCrossingPolicy {
  constructor(private memberships: Memberships, private roles: Roles) {}

  async authorize(ctx: ExecutionContext, targetScopeId: string) {
    await this.memberships.assertMember(requireSession(ctx).userId, targetScopeId);
  }

  async projectContext(ctx: ExecutionContext, targetScopeId: string) {
    const session = requireSession(ctx);
    return {
      ...ctx,
      session: { ...session, scopeId: targetScopeId, roles: await this.roles.of(session.userId, targetScopeId) },
    } as ExecutionContext;
  }
}
```

A third shape lets internal workers cross freely and users never:

```ts
const systemOnly: ScopeCrossingPolicy = {
  authorize: (ctx) => {
    if (ctx.session) throw new ForbiddenError({ message: 'Users cannot cross scopes.' });
  },
};
```

None of these read `crossedFrom`: it is attribution, rebuilt from event
metadata on the consumer side, so it must never grant anything. To go back to
where you were, return from `fn` rather than crossing back.

## Custom providers and factories

A custom `ExecutionContextProvider` implements `getContext`,
`runWithContext`, `withScope` and `crossScope`, and exposes its `factory`.
Two rules keep it compatible with the rest of the kit:

- **`withScope` and `crossScope` keep `executionAttemptId`.** Handler entries
  and job executions compare it to tell their own run from a context they
  escaped into; a provider that mints a new one there makes their
  `getContext()` throw inside valid scopes.
- **`crossScope` uses `crossExecutionContext`**, so it enforces the same rules
  and calls the same `ScopeCrossingPolicy`:

```ts
class MyProvider implements ExecutionContextProvider {
  // ...
  async crossScope<T>(scopeId: string, fn: () => Promise<T>): Promise<T> {
    const current = this.getContext();
    const next = await crossExecutionContext(current, scopeId, this.policy);
    return next === current ? fn() : this.runWithContext(next, fn);
  }
}
```

A custom `ExecutionContextFactory` extends the default
`createFromEventMetadata` instead of rewriting it, so fields the kit adds to
event metadata (such as `crossedFrom`) keep round-tripping:

```ts
const appFactory: ExecutionContextFactory = {
  ...executionContextFactory,
  createFromEventMetadata(metadata) {
    const ctx = executionContextFactory.createFromEventMetadata(metadata);
    return { ...ctx, region: lookupRegion(ctx.correlationId) } as ExecutionContext;
  },
};
```

A new surface that hands work a context handle (a command bus, a WebSocket
handler) can give it the same guard handlers and jobs have: keep the
`executionAttemptId` it ran with and read through `readAttemptContext`, which
returns `undefined` once the handle is used outside that run.

```ts
const attemptId = provider.getContext().executionAttemptId;
const getContext = () => {
  const ctx = readAttemptContext(provider, attemptId);
  if (!ctx) throw new Error('used outside its run');
  return toExecutionContextView(ctx);
};
```

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

**5. Carry it through events.** List it in `actorAttributeKeys` when you
build the event metadata (see [Emitting event metadata](#emitting-event-metadata)).
Consumers wired with `executionContext: { provider }` receive it back on
`ctx.session`.

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

## Emitting event metadata

Your `UnitOfWork` `serialize` decides what each event carries. Build its
metadata with `toEventMetadataSource`, the inverse of
`createFromEventMetadata`, so a consumer rebuilds the same context:

```ts
serialize: (event) => {
  const source = toEventMetadataSource(provider.getContext(), {
    actorAttributeKeys: ['projectId'],
  });
  const metadata = EventMetadata.create({ kind: EventKind.DOMAIN, ...source });
  return {
    // ...
    payload: { payload: event.payload, metadata: metadata.toJSON() },
  };
},
```

It writes:

- `actorType` and `correlationId`;
- `scopeId` from `resolveScopeId`, so session-less scoped work carries its
  scope too;
- `userId` from the session only;
- `actorAttributes`: the listed session fields that hold a string, number or
  boolean (reserved keys such as `scopeId` are never picked), only for an
  authenticated context;
- `crossedFrom`, unless it is stale (no scope, or the same as the scope).

## Testing

`@quilla-be-kit/execution-context/testing` builds contexts for tests. Ids
are random unless you pass them.

```ts
import { testContextView, testExecutionContext } from '@quilla-be-kit/execution-context/testing';

testExecutionContext();                                  // actorType 'system', fresh ids
testExecutionContext({ scopeId: 'tenant-1' });           // an ExecutionContext to run code in

testContextView({ scopeId: 'tenant-1' });                // ScopedExecutionContextView
testContextView({ actorType: 'user', session: { scopeId: 'tenant-1', userId: 'u-1' } });
                                                         // SessionExecutionContextView
```

`testContextView` builds the view with `toExecutionContextView`, so
`scopeId` and `userId` always follow the session, and passing both a
`session` and a session-less `scopeId` is a type error. An extended session
is typed back as `AuthSession`, as in every view. The messaging and http
test builders take these as their `context`.

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
