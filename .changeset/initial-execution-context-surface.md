---
"@quilla-be-kit/execution-context": minor
---

Initial public surface: `ExecutionContext` type, `ExecutionContextProvider`
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
