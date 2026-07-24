---
"@quilla-be-kit/messaging": minor
---

Surface event `occurredAt` as a first-class transported field.

The event occurrence time (`DomainEvent`/`IntegrationEvent.occurredAt`) is now threaded
through the whole pipeline — outbox insert → claim → forward → bus publish → consumer
handler — instead of being stripped at the consumer boundary. It is promoted alongside
`aggregateId`/`correlationId` rather than buried in the payload JSON, and is distinct
from `createdAt` (outbox-row write time) and `publishedAt` (bus-forward time).

- `HandlerEntry`, `EventBusEntry`, `EventBusPublisher.publish(...)`, `LocalOutboxEntry`,
  and `LocalOutboxInsertInput` all gain a required `occurredAt: Date`.
- The Postgres adapters read/write an `occurred_at TIMESTAMPTZ NOT NULL` column on both
  `outbox_events` and `events`, and `getPostgresSchema()` emits it on both tables (no DB
  default — the value always comes from application code, per the dumb-DB principle).

`occurredAt` means one thing — when the event occurred. A consumer needing any other
business date should put it in payload metadata. Existing consumers add the column with
`ALTER TABLE ... ADD COLUMN occurred_at TIMESTAMPTZ NOT NULL` (backfilling as appropriate)
and supply `occurredAt` when mapping events into the outbox.

Also add the bus row `id` to `HandlerEntry`, so handlers receive the stable bus event id.
This makes the documented processed-events idempotency pattern (dedup keyed on `entry.id`)
usable — previously the id was referenced in the docs but never passed to handlers.
