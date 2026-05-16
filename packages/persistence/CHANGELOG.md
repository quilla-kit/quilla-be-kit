# @quilla-be-kit/persistence

## 1.0.0

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

- 0c27b63: Initial public surface: transport-agnostic core + Postgres reference
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
    - type casts, no transactions, no `FOR UPDATE`.

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

- 74b8f6a: `PgDatabase` now accepts either a `PoolConfig` (the adapter creates and
  owns the pool — existing behavior) or `{ pool }` (the caller owns the
  pool and can share it with `PgLocalOutbox` / `PgEventBus` /
  `@quilla-be-kit/messaging` adapters). When the pool is caller-owned,
  `disconnect()` is a no-op; the composition root registers `pool.end()`
  on its `ShutdownManager` directly.

  Removes the need for the quick-start pattern that created two separate
  `pg.Pool` instances against the same `DATABASE_URL` — one pool now
  backs the database adapter and the messaging adapters together.

- b0de0ba: Refactor `BaseReadDao` around a fluent `SqlQueryBuilder` plus a new
  `/query-schema` sub-path for HTTP-query parsing. The old
  `BaseReadDao<TReadModel>` with a fixed `tableName` forced one DAO per
  read model — real read DAOs project over joins, views, and aggregates
  and expose multiple query methods against different shapes.

  **Breaking:** `BaseReadDao` is no longer generic over `TReadModel` and no
  longer declares `tableName`. Constructor now takes an options object:
  `{ adapter, builderFactory, columnResolver? }`. Query methods build SQL
  through `this.qb<T>()` and hand the resulting `QueryProduct` to the
  method-generic `findOne<T>(q)` / `findMany<T>(q)` / `findPaginated<T>(q,
page)`. A single subclass exposes any number of query methods over any
  number of tables.

  **New — core (`@quilla-be-kit/persistence`):**

  - `SqlQueryBuilder<T>` interface: `.select / .from / .join / .groupBy /
.where / .filters / .orderBy / .paginate / .build`. Immutable — each
    fluent call returns a new instance, so reuse is safe.
  - Suffix-operator filter DSL with double-underscore delimiter:
    `__contains`, `__in`, `__notIn`, `__gt`, `__gte`, `__lt`, `__lte`,
    `__isNull`, `__isNotNull`. `undefined` values are skipped; unknown
    operators throw at build time.
  - `ColumnResolver` interface + `DefaultColumnResolver` (camelCase →
    snake_case plus explicit overrides). Select-list columns are
    auto-aliased (`created_at AS "createdAt"`) so read models get domain
    vocabulary back from the DB without hand-written alias strings.
  - `QueryProduct`, `PaginatedResult<T>`, `StandardListQuery<TFilters>`,
    `PaginationOptions`, `SortOption`, `FieldDescriptor` /
    `FieldDescriptorMap` / `OPERATORS_BY_KIND`.
  - `ReadDbAdapter.raw<T>(sql, params)` — low-level escape hatch used by
    `BaseReadDao` to execute `QueryProduct`.

  **New — postgres (`@quilla-be-kit/persistence/postgres`):**

  - `PgSqlQueryBuilder` — Postgres implementation. `$N` placeholder
    rebasing, `DISTINCT ON`, `COUNT(*)` with GROUP BY subquery wrapping,
    identifier validation against `[a-zA-Z_][a-zA-Z0-9_]*` (plus `.` and
    optional `AS alias`) as defense-in-depth against SQL injection.

  **New — query-schema (`@quilla-be-kit/persistence/query-schema`):**

  - `createQueryParametersSchema(filterShape, { defaultPageSize?, maxPageSize?, strict?, extraFields? })`
    — Zod helper that takes a base filter shape and returns a full
    validation + transform schema producing `StandardListQuery<TFilters>`.
    Auto-expands the suffix DSL based on Zod field kinds; parses
    `?name__contains=...&sort=field:dir&page=2&pageSize=50` into the
    canonical form. Defaults to tolerant parsing (unknown keys stripped,
    bad sort entries dropped, invalid pagination falls back to defaults);
    pass `{ strict: true }` to surface unknown keys, unknown sort fields,
    bad sort directions, and invalid page/pageSize as `ZodError` issues.
    `maxPageSize` stays a clamp in both modes.
    Pass `extraFields` (a Zod object) to weave additional top-level fields
    into the generated schema — for auth-derived identifiers (`scopeId`,
    `userId`, etc.) or any other envelope-level data. Extra fields are
    declared at the top level (accepted by strict mode), skipped by the
    suffix-operator expansion (no scope-crossing filters exposed to
    clients), and passed through to the transform output alongside
    `filters` / `sort` / `pagination`. `StandardListQuery` itself stays
    minimal — consumers compose their query shape via intersection.
  - `fieldDescriptorsFromZod(schema)` exposed for consumers building
    alternative validator adapters (Valibot, ArkType) against the same
    `FieldDescriptorMap` contract.
  - `zod` added as an **optional** peer dep — required only when importing
    from this sub-path.

  Divergences from the emigraly reference: immutable builder (emigraly
  mutates `this`), output column auto-aliasing via the same resolver used
  on input (emigraly hand-aliases per-select), `__` delimiter on the
  filter DSL (emigraly uses single `_` which collides with field names
  containing underscores), `__isNull` / `__isNotNull` operators added,
  validator-agnostic output shape (`StandardListQuery<TFilters>`), and
  identifier validation in every structured seam.

### Patch Changes

- Updated dependencies [8c8e6af]
- Updated dependencies [5ab4cd4]
- Updated dependencies [6ce0a43]
- Updated dependencies [f1dfa83]
  - @quilla-be-kit/execution-context@0.2.0
  - @quilla-be-kit/ddd@0.2.0
  - @quilla-be-kit/errors@0.2.0
