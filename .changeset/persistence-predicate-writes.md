---
'@quilla-be-kit/persistence': minor
---

Layered persistence: DAOs and the unit of work no longer depend on the DDD layer, and write DAOs can address rows by a strict predicate.

**Migration**

- Depend on `^0.10.0` (the 1.x–8.x line is deprecated).
- Aggregate repositories, `PersistenceMapper` / `BasePersistenceMapper`, and the DDD `UnitOfWork` / `UnitOfWorkContext` now come from `@quilla-be-kit/persistence/aggregate`. Change the import path; `ctx.registerAggregate(...)` keeps working there. The aggregate repositories need a context from that `UnitOfWork`.
- The main entry's `UnitOfWork` / `UnitOfWorkContext` are event-agnostic (`TEvent = unknown`) and register sources with `ctx.registerEventSource(...)`; they have no `registerAggregate`.
- Hand-built `UnitOfWorkContext` objects (test doubles) need a `registerEventSource` method too.
- Implementations of `WriteDao` / `IdWriteDao` must add `findSingle`, `findSingleForUpdate`, `updateBy` and `deleteBy`.
- Implementations of `SqlQueryBuilder` must add `limit(n)`.
- `FilterOperator` / `ALL_FILTER_OPERATORS` gain `ne` and `notInStrict`; exhaustive switches over them need the new cases.
- `KeyedWriteDao`'s protected `contextProvider` is now `ActorProvider | undefined`. Subclasses that used it for more than the actor (`runWithContext`, `scopeId`) should keep their own typed reference.

**Behaviour changes**

- `field__eq` is SQL equality: `field__eq: null` binds `= NULL` (matches no row) and an array value binds array equality. Bare keys keep `IS NULL` and `= ANY` (reads and writes).
- `__contains` matches `%`, `_` and `\` literally (reads, writes and HTTP query strings).
- An `undefined` key value now throws on key-addressed reads and writes (`update`, `updateMany`, `delete`, `deleteMany`, `findOneByKey`, `findOneById`, `findManyForUpdateByKeys`) instead of matching nothing — so an aggregate repository's `loadById(undefined)` throws instead of returning `null`.

**New**

- `updateBy(where, set, trx?)`, `deleteBy(where, trx?)`, `findSingle(where, trx?)` and `findSingleForUpdate(where, trx, { onLocked?: 'wait' | 'nowait' })` on write DAOs. They work with `keyColumns = []`, stamp audit columns like `update`, and reject an `undefined` value, an empty `where` and filters that match every row; `ALL_ROWS` addresses the whole table explicitly. `findSingle*` throw `TooManyRowsError` on more than one row.
- `updateBy` / `deleteBy` on `KeyedBasicRepository` / `BaseBasicRepository`, returning the affected count.
- `__ne` (`<>`) and `__notInStrict` (SQL `NOT IN`, no `NULL` rows) filter operators, available in code only — not in HTTP query strings.
- `__gt` / `__gte` / `__lt` / `__lte` are typed for `string` and `bigint` fields too.
- `BaseReadDao.findSingle(query)` and `SqlQueryBuilder.limit(n)`.
- `WriteDbAdapter` `update` / `delete` accept `allRows: true`; without it, an empty `where` must throw.

**DAO-only consumers**

- `KeyedWriteDao` takes an optional `ActorProvider` (any `{ getContext() }` exposing `session?.userId`; an `ExecutionContextProvider` is one). A policy that records no actor needs none.
- `@quilla-be-kit/execution-context` is no longer a peer dependency; `@quilla-be-kit/ddd` is an optional peer, needed only by `/aggregate`.
- `UnitOfWork` accepts any `DomainEventSource` (anything with `drainDomainEvents()`), not only DDD aggregates, and de-duplicates registered sources by identity: two distinct objects with the same class and `id` are now both drained (previously the second replaced the first and the first one's events were lost).
- The README is reorganised by layer, with a DAO-only quickstart.
