---
"@quilla-be-kit/persistence": minor
---

Initial public surface: transport-agnostic core + Postgres reference
implementation under the `/postgres` sub-path.

**Core (`@quilla-be-kit/persistence`):**

- `Database` / `DatabaseTransaction` / `DatabaseResult` / `DatabaseHealth`
  types — the transport abstraction.
- `FilterQuery<T>` — typed WHERE shape; value or readonly-array per field
  → emits `=` or `IN`.
- `ReadDbAdapter` / `WriteDbAdapter` interfaces — CQRS-split adapter
  contracts. Read side exposes `select` only (never accepts `trx`). Write
  side exposes `insert` / `update` / `delete` / `find` / `findForUpdate` /
  `exists`. A single concrete class may implement both for wiring
  convenience, but DAO types enforce the boundary.
- `BaseReadDao<TReadModel>` — projections-only, no `trx` parameter anywhere.
- `BaseWriteDao<TRow>` — writes with audit-field injection, excluded-keys
  filtering, and optimistic-lock enforcement. Unlocked reads (`findOne` /
  `findMany` / `existsBy`) for pre-create validation; locked reads
  (`findOneForUpdate` / `findManyForUpdate`) for read-before-update.
- `BaseBasicRepository` / `BaseAggregateRepository` /
  `BaseScopedAggregateRepository` / `BaseUnscopedAggregateRepository`.
- `UnitOfWork` — AsyncLocalStorage-scoped nested `transaction()`
  JOIN semantics + optional `OutboxWriter` injection for domain +
  integration event draining in the same transaction.
- `UnitOfWorkContext`, `OutboxWriter`, `PersistenceMapper` types.
- `BasePersistenceMapper<TAggregate, TProps, TRow>` — abstract base that
  auto-converts row↔aggregate via prototype reflection: enumerates every
  `get`+`set` accessor pair on the aggregate's prototype chain to discover
  persisted properties, then maps names via camelCase↔snake_case. Consumer
  declares only `createDomain` (required, reconstructs the aggregate) plus
  optional `columnOverrides` (sparse map for non-conventional column names)
  and `createPersistence` (for value-object serialization / derived
  columns). Inherits the `Entity` base accessors automatically, so
  `createdAt` / `updatedAt` / `insertedBy` / `updatedBy` map to
  `created_at` / `updated_at` / `inserted_by` / `updated_by` without any
  consumer declaration. Getter-only accessors (computed / derived) are
  excluded — no opt-out needed.
- `CrossScopeAccessError` (extends `NotFoundError`, code
  `CROSS_SCOPE_ACCESS`), `OptimisticLockError` (extends `ConflictError`,
  code `OPTIMISTIC_LOCK`).

**Postgres (`@quilla-be-kit/persistence/postgres`):**

- `PgDatabase` — owns a `pg.Pool`; constructor takes `PoolConfig`. Wire
  `disconnect()` into `ShutdownManager` for graceful drain. `healthCheck()`
  runs `SELECT version()` and returns `{ version }`.
- `PgTransaction` — wraps a `PoolClient`, explicit `start` →
  `commit`/`rollback` → `release` lifecycle.
- `PgWriteDbAdapter` — implements `WriteDbAdapter`. Queries
  `information_schema.columns` once per table (per-process cache), maps
  types via `mapPostgresType` for explicit `::UUID` / `::JSONB` /
  `::TIMESTAMPTZ` / `::INTEGER` etc. casts. JSONB values get
  `JSON.stringify`'d. `created_at` / `updated_at` emitted as
  `date_trunc('milliseconds', CURRENT_TIMESTAMP)` for round-trip
  consistency with JS `Date`. Optimistic lock clause appended as
  `AND col = date_trunc('milliseconds', $n::timestamptz)`. Array values
  rendered as `= ANY($n::TYPE[])`.
- `PgReadDbAdapter` — implements `ReadDbAdapter`. Same info-schema cache
  + type casts, no transactions, no `FOR UPDATE`.

**Key design decisions:**

- **Transport-agnostic core, dialect-specific sub-path.** Consumers who
  target Postgres import from `@quilla-be-kit/persistence/postgres`.
  Consumers targeting another dialect implement `Database` +
  `WriteDbAdapter` + `ReadDbAdapter` themselves. Invariants (audit,
  optimistic-lock check, scope isolation, excluded-keys filtering, event
  draining, UoW JOIN) live in the core and are tested once.
- **`pg` as optional peer dependency** — `>=8.0` range, `peerDepend-
  enciesMeta.optional: true`. Consumers who don't use the Postgres
  sub-path don't need `pg` installed.
- **Adapter owns `Database` internally.** DAO constructors take only
  `(WriteDbAdapter, ExecutionContextProvider)` or `(ReadDbAdapter)` —
  no direct `Database` reference. Composition root passes `Database`
  to the adapters + UoW; DAOs are insulated.
- **CQRS at the type level.** Read DAOs/adapters have no `trx`
  parameter anywhere — a compile-time guarantee that read projections
  cannot participate in write transactions. The write side's unlocked
  `findOne` / `existsBy` are the sanctioned path for pre-create checks;
  `findOneForUpdate` is exclusively for read-before-update (its `trx`
  argument is required, not optional).
- **`code` is class-fixed** on every toolkit error — no constructor
  parameter varies it. `CrossScopeAccessError.code === 'CROSS_SCOPE_
  ACCESS'`, `OptimisticLockError.code === 'OPTIMISTIC_LOCK'`.
- **Peer dependencies on toolkit packages** (`@quilla-be-kit/ddd`,
  `@quilla-be-kit/execution-context`, `@quilla-be-kit/errors`) — avoid
  duplicate copies across consumer graphs; keeps `instanceof` reliable.

**Tests:** 64 abstract-level unit tests — audit injection, optimistic-
lock enforcement, scope mismatch, null-on-miss semantics, UoW commit /
rollback / release lifecycle, nested JOIN, outbox drain, CQRS boundary
enforcement, and Postgres SQL-string assertions against a stub
`Database`. No live-Postgres integration tests (consumer concern).
