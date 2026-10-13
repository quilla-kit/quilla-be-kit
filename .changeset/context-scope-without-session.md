---
"@quilla-be-kit/execution-context": minor
---

Scope for work without a session. `ExecutionContext` gains an optional `scopeId`: the scope affected by work that has no authenticated caller (a job, a public flow, a system task). It never sits beside a `session` and never authenticates anyone.

- `provider.withScope(scopeId, fn)` runs `fn` in the current context scoped to `scopeId`: it adds the scope when there is none, joins when the context already has that scope, and rejects on a different one (from the session or an earlier call). Correlation id, execution attempt id, actor type and session are kept.
- `resolveScopeId(ctx)` returns the session's scope, otherwise the session-less `scopeId`, and throws when both are set.
- `createFromEventMetadata` restores a `scopeId` that arrives without a `userId` as the context's `scopeId` (it was discarded). **Event handlers** for such events now run scoped: a `withScope` to a different scope rejects, and a serializer reading `resolveScopeId` stamps that scope on the events they emit.
- `ExecutionContextEnricher` logs `scopeId` for session-less scoped contexts. `userId` still comes only from the session.
- **Custom `ExecutionContextProvider` implementations** must add `withScope`.
