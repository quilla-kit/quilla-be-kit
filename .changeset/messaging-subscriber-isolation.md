---
'@quilla-be-kit/messaging': minor
---

Subscriber isolation: a failing handler no longer holds up its siblings, and each subscriber retries on its own schedule.

- **`EventConsumer({ isolation: true })`.** Each handler runs once per event. A handler that fails gets a delivery of its own: a copy of the event in `event_deliveries`, for that subscriber only. The event row is settled straight away. A subscriber's deliveries run one at a time per aggregate (a lane), in order; while its lane holds work, the subscriber's part of a later event is queued behind it, and the other handlers run as usual. A handler that finished never runs again because a sibling failed. Needs a `key` on every handler (the subscriber's durable identity, shared across its event types), a bus with `deliveries`, and no `handlerOutcomes`.
- **Per-subscriber retry policy:** `retry: { delaysMs, maxAttempts, maxAgeMs }` on `on()` options and `EventSubscription`, with new consumer defaults `maxAttempts` and `deliveryBatchSize`. `maxAgeMs` counts from queueing and guarantees one attempt at the deadline, so retries can ride out an outage of a day. `PgEventBus` `maxRetries` doesn't apply to deliveries.
- **Renames:** `previousKeys` moves a renamed subscriber's queued deliveries to its new key at start, before dispatching. The consumer warns about queued deliveries no registration claims.
- Deliveries run on their own loop, so a slow subscriber never holds up the event path, and they drain whenever the bus offers them, even with isolation off.
- **Postgres:** `PgEventBus({ deliveries: true, deliveriesTableName })` exposes `bus.deliveries` (`PgDeliveryQueue`: `replay`, `cleanupFailed`, ...). `getPostgresSchema({ deliveries: true | { table } })` emits the table. Delivery claims reuse leases, the failover window and the retry schedule, and never run while the subscriber may be handling an event of the same aggregate.
- **New types:** `DeliveryQueue`, `DeliveryEntry`, `NewDelivery`, `DeliveryPair`, `DeliveryLane`, `RetryPolicy`, `EventProcessedInfo`. `EventBusConsumer.deliveries` is optional.
- **Hooks:** `onProcessed(entry, info)` gains a second argument, and `onFailed`'s info gains `source: 'event' | 'delivery'` plus `handlerKey` for deliveries.
