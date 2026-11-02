---
'@quilla-be-kit/messaging': minor
---

Claims are leases: the claiming replica writes a per-row deadline, renews it while a row is being handled, and completes only rows it still owns. A live claim is never reset under a running handler, and a crashed replica's rows come back after one lease (60 s by default) instead of 5 min.

**Migration**

- Add the nullable `lease_expires_at TIMESTAMPTZ` column to the events and outbox tables **before** starting any 0.8.0 process. No backfill, no index change. `getPostgresSchema()` now adds the column when it is missing (checking the catalog first, so migrated tables aren't locked), so running it at boot upgrades existing tables. Without the column, Postgres adapters throw `MissingLeaseColumnError`. The README has plain SQL for migration tools and the rolling-upgrade order.
- Older versions keep working on the migrated table. Rows they claim are recovered with the existing `staleClaimAfterMs` rule.
- Custom `EventBusConsumer` / `LocalOutboxReader` implementations compile unchanged: the new members are optional.

**Behaviour changes**

- Claim renewal is on by default for adapters that expose a lease (both Postgres adapters do): every `leaseMs / 3`, for the row being handled only. The unprocessed tail of a long batch expires and redistributes to idle replicas. Before dispatching a row, the replica confirms it still holds the claim (only when the claim is older than one renewal interval) and skips it otherwise.
- `resetStale` resets rows whose lease has expired, plus rows without a lease that are older than the cutoff. Each consumer's `leaseMs` holds whichever consumer runs the sweep.
- `EventConsumer` and `OutboxForwarder` pass their `instanceId` to `markDone` / `markFailed` / `markSent`. The Postgres adapters then act only on rows this instance owns or that were reset and not re-claimed, and throw `ClaimLostError` otherwise.
- `staleClaimAfterMs` now only applies to claims without a lease.

**New**

- `PgEventBus` / `PgLocalOutbox` option `leaseMs` (default `DEFAULT_LEASE_MS`, 60 s) and a `lease` property.
- `EventConsumer` / `OutboxForwarder` options `renewIntervalMs` (default a third of the lease; `0` disables renewal and logs a warning at start) and `onLeaseLost({ id, eventType, stage })`. When a claim turns out to be lost, the component logs a warning and calls the hook once per row.
- Optional `lease?: ClaimLease` and `instanceId` parameters on `EventBusConsumer` / `LocalOutboxReader`. Adapters for brokers that can extend a claim (SQS, Pub/Sub, JetStream) can implement renewal; any adapter can throw `ClaimLostError` when an ack didn't count.
- `leaseExpiresAt` on `EventBusEntry` / `LocalOutboxEntry`.
- Exports: `ClaimLease`, `LeaseLostInfo`, `LeaseLostStage`, `ClaimLostError`, `DEFAULT_LEASE_MS`; `MissingLeaseColumnError` from `/postgres`.
