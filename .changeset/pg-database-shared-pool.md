---
"@quilla-be-kit/persistence": minor
---

`PgDatabase` now accepts either a `PoolConfig` (the adapter creates and
owns the pool — existing behavior) or `{ pool }` (the caller owns the
pool and can share it with `PgLocalOutbox` / `PgEventBus` /
`@quilla-be-kit/messaging` adapters). When the pool is caller-owned,
`disconnect()` is a no-op; the composition root registers `pool.end()`
on its `ShutdownManager` directly.

Removes the need for the quick-start pattern that created two separate
`pg.Pool` instances against the same `DATABASE_URL` — one pool now
backs the database adapter and the messaging adapters together.
