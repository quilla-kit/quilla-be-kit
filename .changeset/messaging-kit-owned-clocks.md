---
'@quilla-be-kit/messaging': minor
---

Retention and claim ordering now run on values the kit owns. Dead-letter retention no longer depends on the publisher's `createdAt`, and per-aggregate ordering holds across concurrent claims, multiple forwarders and retries.

**Migration**

- Before starting any 0.9.0 process, add `failed_at TIMESTAMPTZ` and a database-generated `seq BIGINT` (a per-table sequence plus `SET DEFAULT nextval(…)`, added in that order to avoid a table rewrite) to the events and outbox tables, then build the new claim and verification indexes with `CREATE INDEX CONCURRENTLY`. The README "Upgrading to 0.9.0" section has the SQL split into a transactional changeset and a non-transactional index changeset.
- `getPostgresSchema()` adds all of this too, but builds indexes without `CONCURRENTLY`, so it scans and blocks the table. Use it for new installs, not as the production upgrade path.
- After the last pre-0.9.0 process stops, run the README's `failed_at` backfill to start the retention window of rows dead-lettered earlier. Until then, `cleanupFailed` keeps them.
- The old `created_at` claim indexes are unused and can be dropped.
- `MissingLeaseColumnError` is now `MissingColumnError` and also covers `seq` and `failed_at`. The old name stays exported as an alias, so imports and `instanceof` keep working, but the error `code` changes from `MISSING_LEASE_COLUMN` to `MISSING_COLUMN`: update any code that matches on it.

**Behaviour changes**

- `PgEventBus.cleanupFailed` cuts off on `failed_at`, which is stamped when a row is dead-lettered, instead of `created_at`. Rows with no `failed_at` are kept.
- Claims order by `seq`, then `created_at` for rows written before 0.9.0, and batches are dispatched in that order. `createdAt` is informational.
- Each claim runs in one transaction with a verify step. It hands back any claimed row whose aggregate has, outside the batch, a CLAIMED row or an earlier PENDING row (for consumers, only of the event types they subscribe to). This closes two races: one let two replicas hold the same aggregate at once, the other let a later event of an aggregate be claimed while an earlier one was skipped by a concurrent scan.
- The outbox claim gets the bus's per-aggregate guard, so one aggregate's entries are forwarded by one replica at a time and reach the bus in outbox order.
- When an event fails or loses its claim, `EventConsumer` and `OutboxForwarder` skip the rest of its aggregate in that batch. The skipped rows come back behind the retried event after one lease.

**New**

- `PgLocalOutbox.cleanupFailed(olderThan, { limit })`, and a `(failed_at) WHERE status = 'FAILED'` index on both tables for cleanup.
- `failedAt` on `EventBusEntry` / `LocalOutboxEntry`.
- An env-gated real-Postgres test suite: `MESSAGING_PG_URL=… pnpm --filter @quilla-be-kit/messaging test:pg`.
