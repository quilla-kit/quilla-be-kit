---
'@quilla-be-kit/persistence': minor
---

Let the write side describe tables that don't match the kit's default shape. All defaults are unchanged.

- `KeyedWriteDao<TRow, TKey>` addresses rows by configurable `keyColumns` (single or composite; empty means insert-only). `BaseWriteDao` is now the `['id']` case. `UpdateManyOptions` takes an optional `keyColumns`.
- `AuditPolicy` (`'kit' | 'none' | { createdAt?, updatedAt?, insertedBy?, updatedBy? }`) per DAO via `auditPolicy`. `InsertOptions`/`UpdateOptions`/`UpdateManyOptions` gain an optional `audit` so one adapter serves many tables; the optimistic lock follows the declared `updatedAt` column.
- `PgWriteDbAdapter` accepts `{ columnTypeCache?, quoteIdentifiers? }` (the `(db, cache)` form still works). `quoteIdentifiers: true` quotes every emitted identifier and supports `schema.table`, with column types resolved per schema. Inserts with no columns emit `DEFAULT VALUES`.
- `OptimisticLockError` context carries the full `key` for composite keys.
- Exports `CountOptions`, `UpdateManyOptions`, `AuditTimestamps`, `buildWhere`, `mapPostgresType`, `NO_QUOTING`, `QUOTED` and `ColumnTypeMap` for custom `WriteDbAdapter` implementations.
- Fix `mapPostgresType`: `bigint` columns are cast as `BIGINT` (was `INTEGER`, which overflowed above 2^31) and `_int8` maps to `BIGINT[]`. The emitted SQL for bigint columns changes; 32-bit columns are unaffected.
