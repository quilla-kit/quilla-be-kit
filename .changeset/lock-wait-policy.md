---
"@quilla-be-kit/persistence": minor
---

Lock wait policy on locked reads: `KeyedWriteDao.findManyForUpdate` and `findManyForUpdateByKeys` accept `onLocked?: 'wait' | 'skip' | 'nowait'` (Postgres `FOR UPDATE` / `FOR UPDATE SKIP LOCKED` / `FOR UPDATE NOWAIT`). With `'skip'`, concurrent sweepers — several replicas, or overlapping job ticks — each claim a disjoint chunk instead of blocking on each other. `'nowait'` throws the driver's lock error and aborts the transaction. Omitted, the emitted SQL is unchanged.

- **Adapter authors:** `WriteDbAdapter.findForUpdate` now takes `LockedSelectOptions`, and `KeySetSelectOptions` gains `onLocked`; implementations must honor it. An adapter written against 7.0 still compiles but ignores it, so it keeps waiting.
- New exports: `OnLocked`, `LockedSelectOptions`.
