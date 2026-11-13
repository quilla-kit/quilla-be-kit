---
'@quilla-be-kit/messaging': minor
---

Subscribers become first-class: groups of handlers that share one ordered lane, a per-subscriber policy, held lanes, and the event's sequence on every handler entry.

- **`consumer.subscriber(key, policy)`** returns a builder whose `.on(...)` / `.subscribe(...)` register **members**: one key, one lane per aggregate, one policy. A member is named after its event type, or explicitly with `member` (needed for two handlers of one type). A failing member retries alone from its own delivery; members that finished never re-run; members of the same event never wait for each other; the group's later events queue behind a blocked lane. `consumer.on(type, h, { key })` stays as the one-member-per-type shorthand. `consumer.subscribers` lists them for fence tests.
- **`SubscriberPolicy`**: `retry`, `deadLetter: 'release' | 'hold'`, `isPermanentFailure` (per subscriber, with or without isolation), `stuckAfterAttempts`, `previousKeys`. Two explicit, different values for one key throw at registration.
- **Held lanes:** with `deadLetter: 'hold'` a dead delivery keeps its lane blocked until it's replayed (it keeps its place, so the queued work drains in order after it) or its hold is released. Retention never removes a held delivery. Requires isolation.
- **Alerting:** `onFailed` info gains `held`, `stuck` and `member`; `onProcessed` gains `member`. `PgDeliveryQueue.list(consumerName, { handlerKey, member, state: 'retrying' | 'held' | 'dead', minAttempts, limit })` lists deliveries and the work waiting behind each, for polling.
- **`entry.sequence`:** the event's bus sequence (decimal string), the same on every attempt, delivery and replay, on `HandlerEntry`, `EventBusEntry` and `DeliveryEntry`.
- **Renames:** `previousKeys` on a subscriber moves an earlier key's work member by member; `{ key, member }` on a member moves an exact earlier identity. Moves run under a lock, once, before dispatch; collisions are dead-lettered (`rekey: superseded`). Work of an unregistered member keeps its lane blocked and is logged at error level at start; `PgDeliveryQueue.discard(ids)` removes it.
- **`consumer.prepare()`** runs that startup preparation on demand and resolves to a `PrepareResult` (`moved`, `superseded`, `unregistered`, `staleHolds`), so an app can fail its startup or readiness on lanes blocked by an unregistered member. `start()` still prepares on its own when it isn't awaited.
- **Operator API (Pg-only):** `replay(ids)` and the new `releaseHold(ids)`, `discard(ids)`, `list(...)` resolve to `DeliveryEntry[]`.
- **`DeliveryQueue` port (custom adapters):** `DeliveryPair` and `NewDelivery` carry `member`; `rekey(consumerName, moves)` returns `{ moved, superseded }`; `backlog(consumerName)` replaces `countOrphans`; `markFailedPermanently` takes `{ holdLane }`. `PgDeliveryQueue.replay` resolves to entries instead of ids.
- **Schema:** `event_deliveries` gains `member`, `event_seq`, `holds_lane`, a member-aware unique index and a hold-aware lane index; `getPostgresSchema({ deliveries: true })` upgrades 0.15 tables in place. Stop the consumers that use deliveries before applying it (see README "Upgrading to 0.16.0").
- `MissingTableError` names a kit table that doesn't exist.
