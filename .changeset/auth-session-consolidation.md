---
"@quilla-be-kit/execution-context": minor
"@quilla-be-kit/persistence": minor
"@quilla-be-kit/http": minor
"@quilla-be-kit/security": minor
---

**Breaking (pre-1.0):** consolidate `scopeId` and `userId` on
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
  readonly session?: AuthSession;   // present iff authenticated
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
