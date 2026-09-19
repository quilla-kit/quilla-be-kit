---
'@quilla-be-kit/persistence': minor
---

Address batches of composite keys in one statement, and let non-aggregate repositories use keyed tables. Additive; existing DAOs, repositories and custom adapters need no changes.

- `WriteDbAdapter` gains two optional methods, `deleteByKeys` and `findByKeysForUpdate`, taking a `KeySet` (`{ keyColumns, keys }`). `PgWriteDbAdapter` implements them as a single `unnest`-based statement (quoting-aware).
- `KeyedWriteDao.deleteMany` uses `deleteByKeys` for composite keys when the adapter has it (per-key deletes otherwise); new `KeyedWriteDao.findManyForUpdateByKeys` locks a batch of composite keys the same way. Single-key behaviour and SQL are unchanged.
- New `KeyedBasicRepository`, the repository twin of `KeyedWriteDao` (any key, lock column follows the DAO's `auditPolicy`). `BaseBasicRepository` is now its `id`-keyed case with unchanged signatures.
- Exports `buildKeySet`, `keyPredicate`, `KeySet` and `KeySetOptions` for custom adapters.
- README: reorganised guide to keyed tables, audit policy, quoting, key sets and adapter authoring.
