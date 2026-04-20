---
"@quilla-kit/persistence": minor
---

Initial public surface (core): `Database` / `DatabaseTransaction` /
`DatabaseResult` types, `FilterQuery` / `SqlStatement` / `ReadQueryBuilder` /
`WriteQueryBuilder` for CQRS-isolated query building, `BaseReadDao` /
`BaseWriteDao` abstract base classes, `BaseBasicRepository` /
`BaseAggregateRepository` / `BaseScopedAggregateRepository` /
`BaseUnscopedAggregateRepository`, `UnitOfWork` with AsyncLocalStorage
nesting + optional `OutboxWriter` injection, `UnitOfWorkContext`,
`PersistenceMapper`, `CrossScopeAccessError`, `OptimisticLockError`.

Key design decisions:

- **Transport-agnostic core.** No SQL strings in the package. `Database`
  and `QueryBuilder` are interfaces; the package ships the orchestration
  (audit injection, optimistic-lock enforcement, excluded-keys filtering,
  aggregate registration, event draining) while dialect-specific SQL
  generation lives in a concrete `QueryBuilder` supplied by the consumer.
  A Postgres reference implementation ships in a follow-up PR under the
  `@quilla-kit/persistence/postgres` sub-path.
- **CQRS isolation at the type level.** `ReadQueryBuilder` has only
  `select`; `WriteQueryBuilder` has `insert`/`update`/`delete`/
  `selectForUpdate` (write-side locked reads). `BaseReadDao` injects only
  `ReadQueryBuilder` — read-side code cannot mutate. A concrete class
  may implement both interfaces for wiring convenience.
- **DAO vs repository verbs signal the layer.** DAOs use `find*`
  (DB-neutral, returns `TRow`); repositories use `load*` (DDD, returns
  `TAggregate`). Different verbs, different layer contracts.
- **Audit fields baked into DAO layer.** `inserted_by` / `updated_by`
  resolved from `ExecutionContextProvider` on every write — callers
  cannot bypass. `created_at` / `updated_at` stripped from input on
  insert (DB generates). `id` / `inserted_by` / `created_at` stripped
  on update (immutable post-insert).
- **Optimistic lock via `updated_at` opt-in.** If present on an update
  input, the DAO passes it as `optimisticLock` to the query builder and
  asserts `rowCount === 1` — mismatch throws `OptimisticLockError`.
  Omit `updated_at` for an unconditional update.
- **Scope isolation at the repo layer, explicit.** `BaseScopedAggregate-
  Repository` accepts `scopeId` on every load and throws `CrossScope-
  AccessError` (extends `@quilla-kit/errors` `NotFoundError`) on miss
  or mismatch. The toolkit stays scope-agnostic — consumers choose what
  `scopeId` represents (tenant, workspace, organization, project).
- **Outbox is pluggable, not built-in.** `UnitOfWork` accepts an
  optional `OutboxWriter`; when wired, it drains registered aggregates'
  domain events plus explicitly registered integration events in the
  same transaction. When absent, the UoW just commits. Concrete
  `OutboxWriter` implementations live in `@quilla-kit/messaging`.
- **`UnitOfWork.transaction` is idempotent under nesting.** Nested calls
  detect an active UoW via AsyncLocalStorage and JOIN the outer trx —
  inner call receives the outer `UnitOfWorkContext`, no new trx is
  started. Only the outermost commits/rolls back.
- **Repositories receive a `UnitOfWorkContext`**, not a bare trx — they
  register aggregates for event draining as a side effect of write
  operations. `loadForUpdate*` variants register on successful load.
- **Errors extend `@quilla-kit/errors`** with fixed codes per class
  (`CROSS_SCOPE_ACCESS`, `OPTIMISTIC_LOCK`) — consumers classify via
  `instanceof` against the category base.
- **Peer dependencies** on `@quilla-kit/ddd`, `@quilla-kit/execution-
  context`, `@quilla-kit/errors` to avoid duplicate copies across the
  workspace and keep `instanceof` reliable.
