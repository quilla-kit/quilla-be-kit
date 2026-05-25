---
'@quilla-be-kit/messaging': minor
---

feat(messaging)!: publisher-side dedup via `origin_event_id`

`EventBusPublisher.publish` accepts an optional `originEventId: string` and
returns `{ id: string; inserted: boolean }`. The Postgres adapter enforces
uniqueness on `origin_event_id` via a partial unique index — a second publish
for the same `originEventId` is a no-op; the existing bus row's id is returned
with `inserted: false`. NULL `originEventId` never conflicts.

`OutboxForwarder` automatically threads the outbox row id as `originEventId`,
closing the forwarder-replay hazard the toolkit's `id`-ownership change opened
(c73c5f6). If the forwarder crashes between `bus.publish()` and
`outbox.markSent()`, the next tick re-publishes the same outbox row, the bus
deduplicates, and no second row is created. Consumers no longer see that flavor
of duplicate.

Direct-to-bus publishers can opt in by passing any stable identifier (Stripe
charge id, request hash, etc.). The column is `TEXT`, not `UUID`, so non-UUID
keys are fine. Omit `originEventId` entirely to keep fire-and-forget semantics.

Stale-claim re-dispatch (handler crashed before `markDone`) still hands the
same logical event to a consumer more than once — but with the **same bus row
`id`**, so a consumer-side UPSERT keyed on `entry.id` suffices. The README
section "At-least-once delivery" is rewritten with that recipe.

**Breaking changes:**

- `EventBusPublisher.publish` return shape: `Promise<string>` →
  `Promise<{ id: string; inserted: boolean }>`. Custom adapters and any test
  fakes need updating.
- `events` table gains an `origin_event_id TEXT` column and a partial unique
  index. Existing deployments must migrate:

  ```sql
  ALTER TABLE events ADD COLUMN origin_event_id TEXT;
  CREATE UNIQUE INDEX events_origin_event_id_uq
    ON events (origin_event_id)
    WHERE origin_event_id IS NOT NULL;
  ```

  Fresh schemas via `getPostgresSchema()` include both automatically.
