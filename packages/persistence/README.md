# @quilla-kit/persistence

Persistence primitives: transport-agnostic `Database` interface, DAOs with
audit injection and optimistic locking, aggregate repositories with scope
isolation, and a `UnitOfWork` with pluggable outbox.

Peer deps: `@quilla-kit/ddd`, `@quilla-kit/execution-context`,
`@quilla-kit/errors`. No concrete database driver — consumers supply their
own `Database` + `QueryBuilder` (the Postgres reference implementation
ships in a follow-up PR under `@quilla-kit/persistence/postgres`).

## Install

```sh
pnpm add @quilla-kit/persistence @quilla-kit/ddd @quilla-kit/execution-context @quilla-kit/errors
```

## Architectural invariants

- **Scope isolation is repo-layer explicit.** `BaseScopedAggregateRepository`
  takes `scopeId` on every load and throws `CrossScopeAccessError` on miss
  or mismatch. DAOs never inject `scope_id` implicitly. Consumers choose
  what `scopeId` represents (tenant, workspace, organization, project).
- **Audit fields are DAO-layer implicit.** `inserted_by` and `updated_by`
  resolve from `ExecutionContextProvider`. Callers never pass them; rows
  passed in with audit fields are stripped.
- **Optimistic locking is opt-in via `updated_at`.** Include `updated_at`
  in the row passed to `update()` and the DAO asserts `rowCount === 1` at
  commit — mismatch throws `OptimisticLockError`. Omit it to update
  unconditionally.
- **Outbox is orthogonal, not built-in.** Wire an `OutboxWriter` on
  `UnitOfWork` to drain aggregate events + registered integration events
  in the same transaction. Omit it for apps that don't use outbox.
- **Nested `transaction()` calls JOIN** — the inner call sees the outer
  `UnitOfWorkContext` (via AsyncLocalStorage) and reuses the trx. Only the
  outermost commits/rolls back.
- **CQRS isolation at the type level.** `BaseReadDao` uses `ReadQueryBuilder`
  (select only); `BaseWriteDao` uses `WriteQueryBuilder` (insert/update/
  delete/selectForUpdate). A single physical `QueryBuilder` class may
  implement both, but DAO-facing types enforce the boundary.

## Vocabulary

- **DAO** layer — verb `find*`. Returns raw `TRow` from the database.
- **Repository** layer — verb `load*`. Returns `TAggregate` mapped from
  rows. The verb split marks the layer.

## Minimal usage

```ts
import {
  BaseScopedAggregateRepository,
  BaseWriteDao,
  type PersistenceMapper,
  UnitOfWork,
} from '@quilla-kit/persistence';

// 1. Write DAO for your row shape:
class UserDao extends BaseWriteDao<UserRow> {
  protected readonly tableName = 'users';
}

// 2. Mapper between aggregate and row:
class UserMapper implements PersistenceMapper<User, UserRow> {
  toDomain(row) { /* ... */ }
  toPersistence(user) { /* ... */ }
}

// 3. Scoped repository:
class UserRepository extends BaseScopedAggregateRepository<User, UserRow> {}

// 4. Wire at composition root:
const dao = new UserDao(database, writeQueryBuilder, contextProvider);
const repo = new UserRepository(new UserMapper(), dao);
const uow = new UnitOfWork({ db: database, outboxWriter: tableOutboxWriter });

// 5. Use:
await uow.transaction(async (ctx) => {
  const user = await repo.loadForUpdateByIdAndScopeOrFail(userId, scopeId, ctx);
  user.changeName('Alice');
  await repo.update(user, ctx);
  // Domain events drained to outbox, trx committed atomically.
});
```

## Files

```
src/
├── database/     Database / DatabaseTransaction / DatabaseResult
├── query/        SqlStatement, FilterQuery, Read/Write QueryBuilder
├── dao/          BaseReadDao, BaseWriteDao
├── repository/   BaseBasic/Aggregate/Scoped/Unscoped repositories + mapper
├── unit-of-work/ UnitOfWork, UnitOfWorkContext, OutboxWriter
└── errors/       CrossScopeAccessError, OptimisticLockError
```
