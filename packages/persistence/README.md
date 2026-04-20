# @quilla-kit/persistence

Persistence primitives for quilla-kit.

**Interfaces:** `IUnitOfWork`, `IUnitOfWorkContext`, `IWriteDao`,
`IWriteDbAdapter`, `IDatabaseTransaction`.

**Bases:** `BaseReadDao`, `BaseWriteDao` (auto-SQL: `insertOne`, `insertMany`,
`update`, `updateMany`, `delete`, `deleteMany`, `findOne`, `findMany`,
`findOneForUpdate`, `findManyForUpdate`, `existsBy`, `buildWhere`),
`BaseBasicRepository`, `BaseAggregateRepository`, `BaseScopedAggregateRepository`,
`BaseUnscopedAggregateRepository`.

**Outbox:** `OutboxRepository`, `UnitOfWorkWithOutbox`.

## Architectural invariants

- **Scope isolation is repo-layer explicit.** `BaseScopedAggregateRepository`
  accepts `scopeId` as a parameter and raises `CrossScopeAccessError` on
  mismatch. DAOs never inject `scope_id` implicitly. Consumers choose what
  `scopeId` represents (tenant, workspace, organization, project, etc.).
- **Audit fields are DAO-layer implicit.** `inserted_by` and `updated_by` are
  resolved from `IExecutionContextProvider` (via `@quilla-kit/execution-context`).
  Callers never pass them.
- **Outbox iff UoW iff durable domain state.** `UnitOfWorkWithOutbox` commits
  the outbox entry in the same transaction as the aggregate write, or not at
  all.

Database drivers (Postgres, etc.) are out of scope for this package; concrete
adapters implement `IWriteDbAdapter`.

## Install

```sh
pnpm add @quilla-kit/persistence
```

## Status

Interface surface not yet implemented — scaffolded only.
