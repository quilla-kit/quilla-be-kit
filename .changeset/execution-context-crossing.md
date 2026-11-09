---
'@quilla-be-kit/execution-context': minor
'@quilla-be-kit/ddd': minor
'@quilla-be-kit/messaging': minor
'@quilla-be-kit/jobs': minor
'@quilla-be-kit/http': minor
'@quilla-be-kit/persistence': patch
---

Cross between scopes under an app-owned policy, and read the execution context from event handlers, jobs and routes through one `getContext()` view.

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
