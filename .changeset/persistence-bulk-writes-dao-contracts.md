---
'@quilla-be-kit/persistence': minor
---

Bulk writes of any size are atomic, and the repository bases depend on write-DAO contracts instead of the DAO classes.

- **Bulk writes:** `insert` and `updateMany` on `PgWriteDbAdapter` (so `createMany`, `createManyReturning` and `updateMany` on the DAOs and repositories) accept batches past Postgres' 65,535-parameter limit. A batch that would exceed it is split into statements of `floor(65535 / columns per row)` rows, run in order on the caller's `trx`, or in a transaction the adapter opens, commits and rolls back itself when no `trx` is given. Counts are summed and returned rows keep input order. A batch that fits in one statement emits the same SQL as before and opens no transaction.
- **Adapter authors:** `WriteDbAdapter.insert` and `updateMany` must now accept a batch of any size and apply it all-or-nothing. No type changes.
- **Write-DAO contracts:** new `WriteDao<TRow, TKey>` (implemented by `KeyedWriteDao`) and `IdWriteDao<TRow>` (implemented by `BaseWriteDao`). `BaseAggregateRepository`, `BaseScopedAggregateRepository`, `BaseUnscopedAggregateRepository`, `BaseBasicRepository` and `KeyedBasicRepository` take the DAO type as an optional last type parameter, defaulting to the kit's class, so existing repositories compile unchanged. Pass your own contract (e.g. `interface UserWriteDao extends IdWriteDao<UserRow>`) to type `this.writeDao` with your DAO's extra queries or to back a repository with any implementation, including a plain object. Without that type parameter the constructor still expects the class.
- `FindManyForUpdateOptions` and `FindManyForUpdateByKeysOptions` are unchanged and still exported from the main entry.
