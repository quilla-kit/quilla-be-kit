---
'@quilla-be-kit/messaging': minor
---

Retries move onto the row, and a failed row goes to another replica first.

- **One attempt per claim.** `EventConsumer` no longer sleeps and retries in process while holding the claim. A failed attempt hands the row straight back with `next_attempt_at` (now plus the retry delay), so nothing is held while it waits. `retryDelaysMs` now spaces those attempts: the n-th retry waits `retryDelaysMs[n - 1]`, and the last value repeats. `maxRetries` counts every attempt; the `PgEventBus` default moves from 3 to 4, so the default 1 s / 5 s / 15 s schedule runs in full.
- **Failover.** `markFailed` records `last_failed_by`. The failing instance waits a further `failoverWindowMs` (default twice `pollIntervalMs`, `0` disables) on `EventConsumer` and `OutboxForwarder`, so a fault confined to one replica no longer uses up the retry budget there.
- **No churn behind a waiting row.** Claims skip an aggregate whose earlier row is waiting for its retry, through a new partial index, so they don't claim its later rows only to hand them back.
- `OutboxForwarder` takes `retryDelaysMs` too (default `[]`: retry on the next poll).
- `EventBusConsumer.claim` / `LocalOutboxReader.claim` take optional `ClaimOptions`, and `markFailed` takes optional `MarkFailedOptions` (`retryAfterMs`). Entries expose `lastFailedBy` and `nextAttemptAt`. `PgEventBus.replay` clears both columns. `DEFAULT_FAILOVER_WINDOW_POLLS` is exported.
- An event already in dispatch now finishes when shutdown starts, rather than failing its remaining handlers with "shutdown in progress".
- Schema: two nullable columns and one partial index per table. See README "Upgrading to 0.14.0".
