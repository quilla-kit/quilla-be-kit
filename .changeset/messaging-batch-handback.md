---
'@quilla-be-kit/messaging': minor
---

Batches hand back the rows they haven't started instead of letting them expire, and every failed attempt is observable through a new `onFailed` hook.

**Hand-back**

- A batch still running after one renewal interval (a third of the lease by default) returns its unstarted rows to PENDING, owner-checked, so idle replicas can take them. Before, those rows kept their claim-time lease and expired behind a slow handler (or behind `batchSize` × handler time), and the replica then reported them as lost claims.
- When a batch ends, rows it skipped are handed back too: the rest of an aggregate after a failure or a lost claim, and rows left by shutdown. A retry within one aggregate now comes back within one poll interval instead of up to one lease. Any delay between attempts comes from `retryDelaysMs`.
- A row whose claim is gone before it was dispatched is skipped with a `debug` log. It no longer triggers the `claim lease lost` warning or `onLeaseLost`, since it never ran on this replica.
- `ClaimLease` gains an optional `release(instanceId, ids)`, which `PgEventBus` and `PgLocalOutbox` implement. A custom lease without it renews unstarted rows instead of handing them back.

**Failures**

- New `onFailed(entry)` on `EventConsumer` and `OutboxForwarder`. It runs after each failed attempt is recorded, with the updated entry. `entry.status === 'FAILED'` means the row was dead-lettered, with `retryCount`, `lastError` and `failedAt`. It isn't called when the claim was lost (`onLeaseLost` reports that). `onProcessed` still runs only on success.
- `onProcessed` and `onFailed` errors are logged and no longer abandon the batch. Before, a throwing `onProcessed` left the event CLAIMED, and it was dispatched again after the lease.
- **Breaking for custom adapters:** `EventBusConsumer.markFailed` and `LocalOutboxReader.markFailed` now resolve to the updated entry (`EventBusEntry | undefined` / `LocalOutboxEntry | undefined`) instead of `void`. Resolve to `undefined` when the broker can't report it; `onFailed` is then skipped.
- The schema-validation log now reads `skipping in-process retries`: the row still counts toward the bus's `maxRetries`.

No schema change or migration.
