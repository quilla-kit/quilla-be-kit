---
"@quilla-be-kit/persistence": major
---

Locked reads on `KeyedWriteDao` can be bounded and ordered, so batch jobs lock a fixed-size, deterministic chunk per pass without dropping to the adapter.

**Breaking:** `findManyForUpdate(where, trx)` is now `findManyForUpdate({ where, limit?, orderBy? }, trx)`, and `findManyForUpdateByKeys(keys, trx)` is now `findManyForUpdateByKeys({ keys, limit?, orderBy? }, trx)`. Wrap the existing first argument: `findManyForUpdate({ where }, trx)`, `findManyForUpdateByKeys({ keys }, trx)`. `BaseWriteDao` inherits both. `findOneForUpdate` is unchanged.

**Breaking (adapter authors):** `WriteDbAdapter.findByKeysForUpdate` now takes `KeySetSelectOptions` (`KeySetOptions` plus optional `limit` and `orderBy`) and must honor both. An adapter written against 4.3.0 still compiles, but it would ignore the bounds and lock more rows than the caller asked for. `deleteByKeys` keeps `KeySetOptions`. `PgWriteDbAdapter` emits `ORDER BY ... LIMIT ...` before `FOR UPDATE`; without bounds its SQL is unchanged.

- When the adapter lacks `findByKeysForUpdate`, the composite-key per-key fallback stops once `limit` rows are locked, and throws on `orderBy`, since separate per-key statements can't be ordered across keys.
- A `limit` that isn't a non-negative integer throws on every path.
- New type exports: `KeySetSelectOptions`, `FindManyForUpdateOptions`, `FindManyForUpdateByKeysOptions`.
