---
'@quilla-be-kit/messaging': patch
---

improve `PgEventBus.claim()` query planning and trim consumer hot-path allocation

The claim SQL is now built conditionally: the topic predicate (`AND
e.event_type = ANY($4)`) is inlined only when the consumer passes a non-empty
`allowedTopics`. The previous `($4::text[] IS NULL OR e.event_type = ANY($4))`
form risked generic prepared-statement plans that didn't lean on the
`events_event_type_created_at_idx` partial index — splitting the SQL by call
shape gives Postgres a clean target for each variant.

`EventConsumer` caches its registered-type list in a private field, refreshed
only when `on()` registers a new event type. `tick()` reads the cached array
directly, removing a `[...handlers.keys()]` allocation on every poll.

No interface or behavior change — same rows returned for the same input.
`EventConsumer.registeredEventTypes` now returns a stable reference instead of
a fresh array per call; type stays `readonly string[]`.
