# @quilla-be-kit/ddd

## 0.4.0

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

## 0.3.0

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

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages

## 0.2.0

### Minor Changes

- 5ab4cd4: Initial public surface: `Entity`, `AggregateRoot`, `DomainEvent`,
  `IntegrationEvent`, `EventMetadata`, `EnvelopedEvent`, plus the `ActorType`
  and `EventKind` supporting types.

  `Entity` is props-based and audit-field-aware (`createdAt`, `updatedAt`,
  `insertedBy`, `updatedBy` are first-class `BaseEntityProps`). `AggregateRoot`
  exposes `drainDomainEvents()` — destructive-by-name — with an override pattern
  for aggregates composed of child aggregates. Event base classes ship
  `toJSON()` only; deserialization is consumer-owned. `EventMetadata` uses
  `scopeId` (not `tenantId`) to stay naming-agnostic for consumers that scope
  by workspace / organization / project.

  `Entity` uses a **setter-driven construction** pattern for persistence-
  mapper interop: the constructor iterates `props` and mirrors each property
  onto `this` (firing any subclass setter on the prototype chain), so
  persistence mappers can discover domain properties via reflection. The
  convention: **persisted properties declare both a `private set` and a
  `get` accessor on the subclass**; **computed / derived properties declare
  `get` only** — the mapper uses this distinction to decide what to write.
  `Entity` base supplies `createdAt` / `updatedAt` / `insertedBy` / `updatedBy`
  accessors itself, so consumers never redeclare them. Accessor-less
  properties fall through to `Object.assign`-style own-property semantics,
  preserving backward-compat for simple data classes.

  Also reflected in this change: the root README and
  `@quilla-be-kit/persistence` / `@quilla-be-kit/execution-context` READMEs now talk
  about `scopeId` and `CrossScopeAccessError` instead of `tenantId` and
  `CrossTenantAccessError`.
