---
'@quilla-be-kit/execution-context': patch
'@quilla-be-kit/messaging': minor
'@quilla-be-kit/jobs': minor
'@quilla-be-kit/http': minor
---

Dead-letter failures a retry cannot fix, check handler requirements per handler, hook `forEachScope` failures, and ship test builders.

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
