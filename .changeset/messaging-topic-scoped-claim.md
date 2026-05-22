---
'@quilla-be-kit/messaging': minor
---

scope event-bus claims to the consumer's registered topics

`EventBusConsumer.claim` accepts an optional `allowedTopics` arg; the Postgres
broker filters rows by `event_type = ANY($4)`. `EventConsumer` always passes its
current handler key set, so the bus only ever delivers events a consumer can
handle.

**Why:** the previous "claim everything, ack the rest" branch was wasted work
in single-service deployments and made the bus unusable across multiple
consumer services sharing one database — replicas would race for each other's
events and silently drop them. Per-aggregate ordering still serializes
bus-wide via the existing `NOT EXISTS` + advisory-lock guards, so independent
services can now share a bus as long as each `eventType` has exactly one
subscribing service.

**Behavior change:** events whose `eventType` no `EventConsumer` has registered
will no longer be silently consumed. They remain `PENDING` until a consumer
subscribes (or an operator deletes them). Any deployment that relied on the
implicit ack must either register a handler for those types or clean them up
out-of-band.

**Schema change:** the `events_status_created_at_idx` partial index is
replaced with `events_event_type_created_at_idx` on `(event_type, created_at)
WHERE status = 'PENDING'`, matching the new claim predicate. Existing
deployments running `getPostgresSchema()` will see both indexes coexist
(`CREATE INDEX IF NOT EXISTS` is no-op for the old name); drop
`events_status_created_at_idx` manually after migrating.
