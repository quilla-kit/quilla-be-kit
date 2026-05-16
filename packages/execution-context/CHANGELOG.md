# @quilla-be-kit/execution-context

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
