# @quilla-be-kit/execution-context

## 0.6.2

### Patch Changes

- 9ded995: README: the "Emitting event metadata" example puts the event's own payload in the envelope (`event.payload`, not `event.toJSON()`), matching what `@quilla-be-kit/messaging` handlers and descriptor schemas receive.

## 0.6.1

### Patch Changes

- 9df1fe9: Dead-letter failures a retry cannot fix, check handler requirements per handler, hook `forEachScope` failures, and ship test builders.

  **messaging**

  - **Breaking for custom bus adapters:** `EventBusConsumer` requires `markFailedPermanently(id, reason, instanceId?)`, which dead-letters at once without redelivery. `PgEventBus` implements it.
  - Permanent failures skip in-process retries and, when every failing handler of an event failed permanently, dead-letter the event on its first attempt instead of redelivering it until `maxRetries`. Always permanent: `SchemaValidationError`, `MissingScopeError` / `MissingSessionError`, and errors rebuilding the context from event metadata. New option `isPermanentFailure(error, { entry })` classifies app errors; a throwing predicate is treated as transient.
  - `onFailed(entry, { permanent })` gains a second argument.
  - `requires` is checked per handler: an unmet requirement fails only its own handler, and the event's other handlers still run.
  - New `@quilla-be-kit/messaging/testing`: `createTestHandlerEntry(payload, { context, fields })`.

  **jobs**

  - `forEachScope(entries, fn, { onScopeFailed })`: replaces the default failure log; called with `{ aborted }`, awaited and guarded.

  **http**

  - New `@quilla-be-kit/http/testing`: `createTestHttpRequest(options)`, built by the adapters' own request factory.

  **execution-context**

  - New `@quilla-be-kit/execution-context/testing`: `testExecutionContext(overrides)` and `testContextView(overrides)`. Released as a patch so packages depending on `^0.6.0` don't have to move together.

## 0.6.0

### Minor Changes

- 599429f: Cross between scopes under an app-owned policy, and read the execution context from event handlers, jobs and routes through one `getContext()` view.

  **execution-context**

  - `provider.crossScope(scopeId, fn)` runs `fn` in the current context moved to another scope. It adds or joins a scope like `withScope`. Moving from one scope to another requires a `ScopeCrossingPolicy` (`authorize`, optional `projectContext`), passed as `scopeCrossing` on `AsyncExecutionContextProvider` (a function returning it is resolved on first use). The kit keeps `actorType`, `correlationId`, `executionAttemptId` and the session's `userId`, drops every other field by default, and records the origin scope in the new `ExecutionContext.crossedFrom`. Custom `ExecutionContextProvider` implementations must add `crossScope` (`crossExecutionContext` builds its context) and must keep `executionAttemptId` in `withScope` and `crossScope`. A custom `ExecutionContextFactory` should extend the default `createFromEventMetadata` result so `crossedFrom` keeps round-tripping.
  - `toEventMetadataSource(ctx, { actorAttributeKeys })` builds the event metadata a context should stamp, the inverse of `createFromEventMetadata`, which now also restores `crossedFrom`.
  - `ExecutionContextView` (+ scoped and session variants) and `toExecutionContextView(ctx)`.
  - `requireScopeId(ctx)` / `requireSession(ctx)` / `requireContext(ctx, 'scope' | 'session')`, throwing `MissingScopeError` / `MissingSessionError` (`InternalError`s, matched across duplicate installs with `.is(err)`). The package now depends on `@quilla-be-kit/errors`.
  - `readAttemptContext(provider, attemptId)` returns the current context only while it belongs to that execution attempt.
  - The log enricher adds `extra.crossedFrom`.

  **ddd**

  - `EventMetadata` gains an optional `crossedFrom` (requires `scopeId`, must differ from it; omitted from JSON when absent). `RESERVED_ACTOR_ATTRIBUTE_KEYS` is exported.

  **messaging**

  - `HandlerEntry.getContext()` returns the live `ExecutionContextView`. It throws when the consumer has no `executionContext`, when called outside the handler's dispatch, or when the context no longer meets the handler's requirement. Entries built by hand (test fixtures) must add it: use `createHandlerEntry(fields, view)`.
  - Handlers declare `requires: 'scope' | 'session'` (`on(..., { requires })`, `ScopedEventSubscription`, `SessionEventSubscription`) for a narrowed entry type. Every requirement is checked before an event's handlers run; if one is unmet, none runs and the row is marked failed without in-process retries. Declaring a requirement without `executionContext` throws at registration.
  - README: validation failures are redelivered until `maxRetries` like any failure, not marked `FAILED` directly.

  **jobs**

  - `BackgroundJob.execute(signal, execution)`: `execution.getContext()` and `execution.forEachScope(entries, fn)`, which runs `fn` once per scope in `withScope`, isolates and logs failures, and skips the remaining scopes once aborted. Jobs implementing `execute(signal)` still type-check; calls through the `BackgroundJob` type pass both arguments. Custom runners build the argument with `createJobExecution(...)`.

  **http**

  - `HttpRequest.getContext()` returns the live `ExecutionContextView`. Custom `HttpRequest` implementations must add it. `getExecutionContext()` is deprecated in its favour.

  **persistence**

  - README example reads the scope with `req.getContext()`.

### Patch Changes

- Updated dependencies [599429f]
  - @quilla-be-kit/ddd@0.4.0

## 0.5.0

### Minor Changes

- 5054ac1: Scope for work without a session. `ExecutionContext` gains an optional `scopeId`: the scope affected by work that has no authenticated caller (a job, a public flow, a system task). It never sits beside a `session` and never authenticates anyone.

  - `provider.withScope(scopeId, fn)` runs `fn` in the current context scoped to `scopeId`: it adds the scope when there is none, joins when the context already has that scope, and rejects on a different one (from the session or an earlier call). Correlation id, execution attempt id, actor type and session are kept.
  - `resolveScopeId(ctx)` returns the session's scope, otherwise the session-less `scopeId`, and throws when both are set.
  - `createFromEventMetadata` restores a `scopeId` that arrives without a `userId` as the context's `scopeId` (it was discarded). **Event handlers** for such events now run scoped: a `withScope` to a different scope rejects, and a serializer reading `resolveScopeId` stamps that scope on the events they emit.
  - `ExecutionContextEnricher` logs `scopeId` for session-less scoped contexts. `userId` still comes only from the session.
  - **Custom `ExecutionContextProvider` implementations** must add `withScope`.

## 0.4.0

### Minor Changes

- c073429: Carry app-defined session fields through validated input, logs and events.

  `http`: `AuthMiddlewareStack` gains `sessionKeys`. On that stack's routes, `@ValidateRequest` injects the listed `ExecutionContext.session` fields when the schema declares them, alongside `scopeId`/`userId`. A client-sent value for those keys is always discarded, even when the validator has no `describeSchema`, and a key the session can't supply fails the request with a generic 500.

  New construction errors:

  - `sessionKeys` without `sessionLoad`.
  - An empty or prototype-named session key.
  - A route that sources a session key from a header on a stack with `sessionLoad`. This also covers `scopeId`/`userId`, so a route mapping them to a header on such a stack now throws.

  Behavior changes:

  - Session fields are injected after header fields, so the session wins over a header mapped to the same key.
  - A session without a `scopeId`/`userId` value the schema declares now fails with a 500 instead of injecting `undefined`.

  `ddd`: `EventMetadata` gains optional `actorAttributes`, app-defined facts about the actor beyond `scopeId`/`userId`. Values are strings, numbers or booleans; both ids are required and their names can't be reused. `toJSON` omits the key when absent, so existing event JSON is unchanged. New type export: `ActorAttributes`.

  `execution-context`:

  - `createFromEventMetadata` accepts parsed JSON metadata (`EventMetadataSource`) and restores `actorAttributes` onto the session.
  - `ExecutionContextEnricher` takes an optional `{ sessionKeys }` to log the listed session fields under `extra.session`.
  - **Fix:** a system event read back from the bus (`scopeId: null`, `userId: null`) was rebuilt as an authenticated context with `null` ids; it now has no session.

  `messaging`, `security`: README updates for the above.

### Patch Changes

- Updated dependencies [c073429]
  - @quilla-be-kit/ddd@0.3.0

## 0.3.1

### Patch Changes

- 19fc951: Document the logger enricher seam.

  `@quilla-be-kit/observability` gains an "Enrichers" README section (contract,
  custom-enricher example, `context` vs `extra`, merge order, per-emit timing)
  and a `src/logger/README.md` internals doc covering the full emit pipeline.
  The `LogContext` bullet now lists `executionAttemptId`.

  `@quilla-be-kit/execution-context` enumerates the fields
  `ExecutionContextEnricher` actually contributes, and its quick-start snippet
  now passes the required `service` on `LoggerConfig`.

- Updated dependencies [19fc951]
  - @quilla-be-kit/observability@0.3.1

## 0.3.0

### Minor Changes

- 603c3af: Add `executionAttemptId` to `ExecutionContext`, identifying a single physical attempt at an operation, distinct from `correlationId` (which identifies the logical operation and can span retries). All three `ExecutionContextFactory` methods now mint a fresh `executionAttemptId` per call — it is never accepted as caller input, so a retried operation reusing the same `correlationId` still gets a distinct `executionAttemptId` per attempt. `ExecutionContextEnricher` now includes `executionAttemptId` on every log line alongside `correlationId`.

  **Breaking for `@quilla-be-kit/execution-context`:** `executionAttemptId` is a required field on `ExecutionContext`. Any consumer that hand-constructs an `ExecutionContext` object literal directly (rather than via `executionContextFactory` or by spreading an existing context) must add this field.

  `@quilla-be-kit/observability`'s `LogContext` gains an optional `executionAttemptId` field to carry the new context field into log entries — additive, non-breaking.

### Patch Changes

- Updated dependencies [603c3af]
  - @quilla-be-kit/observability@0.3.0

## 0.2.2

### Patch Changes

- 77153bc: Document `createSystemContext` `actorType` parameter: distinguish `'system'` (process-level ops) from `'job'` (background-job ticks). Previously the README listed the method without the parameter or any guidance on when to use each value.
- Updated dependencies [77153bc]
  - @quilla-be-kit/observability@0.2.2

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages
- Updated dependencies [30c8333]
  - @quilla-be-kit/ddd@0.2.1
  - @quilla-be-kit/observability@0.2.1

## 0.2.0

### Minor Changes

- 8c8e6af: **Breaking (pre-1.0):** consolidate `scopeId` and `userId` on
  `ExecutionContext` into a single optional `session: AuthSession`.

  The previous shape (`scopeId?`, `userId?` as top-level optionals on
  `ExecutionContext`) encoded two correlated fields as if they were
  orthogonal. In practice they share a lifecycle — both defined once auth
  middleware runs, both undefined for anonymous / system / job contexts,
  never half-populated in well-formed code. The type didn't enforce that.

  New shape:

  ```ts
  // @quilla-be-kit/execution-context
  export type AuthSession = {
    readonly scopeId: string;
    readonly userId: string;
  };

  export type ExecutionContext = {
    readonly actorType: ActorType;
    readonly correlationId: string;
    readonly session?: AuthSession; // present iff authenticated
  };
  ```

  `AuthSession` is extensible by intersection — same pattern as before for
  consumer-specific session data (roles, session id, etc.), but now anchored
  on a canonical base. `actorType` stays at the top level: `'system'` and
  `'job'` are meaningful with no session, and `actorType` classifies the
  broader context whether or not there's a session.

  **Affected toolkit surfaces (all updated):**

  - `@quilla-be-kit/execution-context` — `ExecutionContext.session?`,
    `AuthSession` exported type, `createFromEventMetadata` reconstructs the
    session from flat `EventMetadata.scopeId` / `userId` (metadata stays
    flat on the wire), `ExecutionContextEnricher` flattens `session` into
    top-level `scopeId` / `userId` log fields so log output shape is
    unchanged.
  - `@quilla-be-kit/persistence` — `BaseWriteDao` reads audit from
    `ctx.session?.userId`. System contexts with no session persist `null`
    audit.
  - `@quilla-be-kit/http` — `@ValidateRequest` reads auth from
    `ctx.session?.{scopeId,userId}`. Injection requires both a live
    session AND a `describeSchema` impl on the `RequestValidator`.
  - `@quilla-be-kit/security` — `authenticatedSessionMiddleware` now enriches
    the context with `session: { scopeId, userId }` instead of flat
    top-level fields.

  **`EventMetadata` is unchanged on the wire.** Flat `scopeId?` / `userId?`
  fields stay — they're a serialization format, and flattening is the right
  shape for JSON-persisted outbox rows. The conversion to/from session
  happens at the `createFromEventMetadata` boundary.

  **Log output is unchanged.** `ExecutionContextEnricher` flattens
  `session` to top-level `scopeId` / `userId` on every log entry, so
  dashboards and log queries keep their existing field names.

  **Consumer migration** — mechanical find-and-replace:

  - `ctx.scopeId` / `ctx.userId` → `ctx.session?.scopeId` /
    `ctx.session?.userId`
  - When constructing contexts in middleware / tests, nest scopeId & userId
    under `session: { scopeId, userId }` instead of placing them at the top.
  - Consumer extensions move from `ExecutionContext & { session?: MySession }`
    where MySession was free-form to
    `AuthSession & { ...extras }` with `ExecutionContext & { session?: AppAuthSession }`.

- f1dfa83: Initial public surface: `ExecutionContext` type, `ExecutionContextProvider`
  and `ExecutionContextFactory` interfaces, `AsyncExecutionContextProvider`
  class, `executionContextFactory` default implementation, and
  `ExecutionContextEnricher` bridging into `@quilla-be-kit/observability`.

  Key design decisions:

  - **Throws on missing context.** `getContext()` raises when called outside
    a `runWithContext(...)` scope. Callers that legitimately don't have one
    establish it explicitly via `createBaselineContext()` or
    `createSystemContext(...)`. No silent anonymous fallback that masks
    "forgot to run inside scope" bugs.
  - **Base `ExecutionContext` is minimal**: `scopeId?`, `actorType`,
    `userId?`, `correlationId`. No `permissions`, no `ActorSession` / session
    data. Consumers extend by intersection — authorization and session shape
    vary too widely across services to pre-pick.
  - **Instance-owned AsyncLocalStorage.** `AsyncExecutionContextProvider`
    holds its own storage; one instance per process, injected via
    composition root. No module-level singleton.
  - **Factory as a named const** (`executionContextFactory`), matching the
    `createLoggerFactory` function-factory pattern in observability.
    Consumers inject the `ExecutionContextFactory` interface; tests provide
    stubs.
  - **Provider carries its factory.** `ExecutionContextProvider` exposes
    `readonly factory: ExecutionContextFactory`; `AsyncExecutionContextProvider`
    defaults it to `executionContextFactory` and accepts a
    `{ factory }` override. Downstream components (http Router, outbox
    forwarders, event consumers) take a single provider instead of
    `{ provider, factory }` twice.
  - **Factory methods**: `createSystemContext('system' | 'job')`,
    `createBaselineContext({ correlationId? })`, `createFromEventMetadata(meta)`.
    JWT and HTTP-specific factories belong in `@quilla-be-kit/security` and
    `@quilla-be-kit/http` respectively.
  - **`ExecutionContextEnricher` is silent** when the provider has no active
    context — returns `{}` instead of propagating the throw. Bootstrap logs
    and pre-request logs still emit, just without context fields.
  - **`ActorType` sourced from `@quilla-be-kit/ddd`**, same extensible union used
    by `EventMetadata`. Consistent actor vocabulary across the toolkit.

### Patch Changes

- Updated dependencies [5ab4cd4]
- Updated dependencies [2bd37fe]
- Updated dependencies [7c86c48]
- Updated dependencies [7c86c48]
  - @quilla-be-kit/ddd@0.2.0
  - @quilla-be-kit/observability@0.2.0
