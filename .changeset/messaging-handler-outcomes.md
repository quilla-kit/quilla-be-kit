---
'@quilla-be-kit/messaging': minor
---

Per-handler outcomes: pass `handlerOutcomes: new PgHandlerOutcomeStore({ pool })` to `EventConsumer` and a redelivery runs only the handlers that haven't finished. Handlers that succeeded, and handlers that failed permanently, are skipped until their outcome is cleared, while `retry_count`, `maxRetries` and dead-lettering still count per row. Event types with several handlers need a `key` on each (`on(descriptor, handler, { key })` or `key` on an `EventSubscription`), checked as each handler is registered. `getPostgresSchema({ handlerOutcomes: true })` emits the `event_handler_outcomes` table, whose rows cascade with their bus row. `HandlerOutcomeStore` (`load` / `record` / `clear`) is a new port, and `InMemoryHandlerOutcomeStore` is exported from `/testing`. Without a store, behaviour is unchanged.

New `PgEventBus.replay(ids, { handlerOutcomes, includeDone })`: returns FAILED rows to PENDING with a fresh retry budget and, given a store, first clears their handler outcomes (only failed handlers re-run unless `includeDone`). It replaces the hand-written replay SQL.
