# @quilla-be-kit/messaging

Broker-agnostic messaging for substrate-grade TypeScript services. Ships the
durable-event flow you reach for in production — **local outbox → event bus →
consumer with retries** — using an atomic claim pattern so multi-replica
deployments scale without coordination or configuration.

```sh
pnpm add @quilla-be-kit/messaging
# For the Postgres reference:
pnpm add pg
```

Node 22+, ESM-only.

---

## What the bus delivers

The bus is a **worker queue**: each event is claimed and handled by **exactly
one consumer-replica across the deployment for the topic it subscribes to**.
After a successful handler chain, the row is deleted.

A consumer only receives events whose `eventType` it has registered via
`consumer.on(...)` or `consumer.subscribe(...)`. The claim query filters by
the consumer's current handler set, so independent consumer services can
share a single bus database — each one drains only its own topics.

```
Service A registers: order.placed, order.cancelled
Service B registers: shipping.dispatched, shipping.delivered

events table
├── order.placed         ── claimed by A only
├── shipping.dispatched  ── claimed by B only
└── order.cancelled      ── claimed by A only
```

**Per-aggregate ordering is preserved across services.** The `NOT EXISTS`
guard and `pg_try_advisory_xact_lock(hashtext(aggregate_id))` operate
bus-wide, so events for the same `aggregate_id` serialize naturally no
matter which service owns each topic.

**In-process fan-out works normally.** A single consumer can register
multiple handlers for the same event type via `consumer.on(...)` — all of
them run when that replica claims the event.

## Not pub-sub fan-out

Each event type is consumed by **one** process group. Two independent
services cannot both subscribe to the same event type on this bus — they
would race for the same row. For multi-subscriber broadcast, use a real
broker:

| Use case | Use this broker |
|---|---|
| Multi-subscriber fan-out (same topic, two services) | Apache Kafka (consumer groups) |
| Topic subscriptions, exchanges | RabbitMQ |
| AWS-native fan-out | SNS → SQS |
| Single-deployment durable queue with topic partitioning | This package |

`EventPublisher` / `EventBusConsumer` are broker-agnostic interfaces — you
can implement them against any of the above.

---

## Architecture

```
┌────────────────────┐         ┌────────────────────┐
│   Your service     │         │  Consumer service  │
│                    │         │                    │
│  Aggregate emits   │         │   EventConsumer    │
│   domain event     │         │   (claim, dispatch │
│        │           │         │    to handlers,    │
│        ▼           │         │    retry, markDone │
│  UnitOfWork        │         │    or markFailed)  │
│  serializes +      │         │        ▲           │
│  writes PENDING    │         │        │           │
│  to LocalOutbox    │         │        │           │
│  (SAME trx)        │         │        │  claim    │
│        │           │         │        │           │
└────────┼───────────┘         └────────┼───────────┘
         │                              │
         ▼                              │
  ┌───────────────┐    ┌─────────────────────┐
  │ outbox_events │    │       events        │
  │   PENDING     │    │   PENDING/CLAIMED   │
  │      ↓        │    │   /FAILED           │
  │   CLAIMED     │    │                     │
  │      ↓        │    └─────────▲───────────┘
  │   SENT        │              │
  └──────┬────────┘              │
         │                       │
         ▼                       │
   ┌─────────────┐               │
   │   Outbox    │───────────────┘
   │  Forwarder  │    publishes PENDING
   │   (claim    │
   │    from     │
   │   outbox)   │
   └─────────────┘
```

Both tables use the same **atomic claim lifecycle**:

```
PENDING → CLAIMED (by one replica via atomic CTE+UPDATE)
        → [terminal]
```

Where terminal means:
- **Outbox**: `SENT` (on publish success) or `FAILED` (retries exhausted).
- **Events**: *deleted* (handler success) or `FAILED` (retries exhausted).

---

## Quick start (Postgres end-to-end)

### 1. Provision the schema

```ts
import { getPostgresSchema } from '@quilla-be-kit/messaging/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(getPostgresSchema());
```

Or pipe the string into drizzle-kit / knex / your migration tool.

### 2. Wire the outbox into your UnitOfWork

```ts
import { UnitOfWork } from '@quilla-be-kit/persistence';
import { PgDatabase } from '@quilla-be-kit/persistence/postgres';
import { PgLocalOutbox } from '@quilla-be-kit/messaging/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PgDatabase({ pool });
const outbox = new PgLocalOutbox({ pool });

const uow = new UnitOfWork({
  db,
  events: {
    sink: outbox,
    serialize: (event) => ({
      eventType: event.name,
      eventVersion: 1,
      eventKind: 'domain',
      payload: { payload: event.toJSON(), metadata: { /* correlationId, ... */ } },
      aggregateId: 'aggregateId' in event ? event.aggregateId : undefined,
    }),
  },
});

// In a command handler:
await uow.transaction(async (ctx) => {
  const order = Order.create(/* ... */);
  ctx.registerAggregate(order);
  await repo.save(order, ctx.trx);
  // Aggregate rows + outbox_events rows commit atomically.
});
```

### 3. Run the forwarder in the background

```ts
import { OutboxForwarder } from '@quilla-be-kit/messaging';
import { PgEventBus } from '@quilla-be-kit/messaging/postgres';

const bus = new PgEventBus({ pool });
const forwarder = new OutboxForwarder({
  reader: outbox,
  publisher: bus,
  sourceService: 'orders',
  logger,
});
forwarder.start();

// On shutdown (via @quilla-be-kit/runtime ShutdownManager):
await forwarder.dispose();
```

Deploy multiple replicas of your service — all of them running the
forwarder — and they automatically coordinate via atomic claim. Each
PENDING row is claimed by exactly one replica. No partitioning, no
configuration.

### 4. Consume events

```ts
import { z } from 'zod';
import { EventConsumer, defineEvent } from '@quilla-be-kit/messaging';

const OrderPlacedSchema = z.object({
  orderId: z.string().uuid(),
  total: z.number().positive(),
});
const OrderPlaced = defineEvent('order.placed', OrderPlacedSchema);
// payload is inferred as z.infer<typeof OrderPlacedSchema>

const consumer = new EventConsumer({
  bus,
  consumerName: 'notifications',
  sourceService: 'notifications',
  logger,
  skipOwnEventKinds: ['integration'], // skip self-emitted integration events
});

consumer.on(OrderPlaced, async ({ payload, correlationId }) => {
  // payload is already validated by OrderPlacedSchema before this line runs
  await sendReceiptEmail(payload.orderId);
});

consumer.start();

// On shutdown:
await consumer.dispose();
```

Schema-less descriptors still work when you don't need runtime validation:

```ts
const OrderPlaced = defineEvent<{ orderId: string; total: number }>('order.placed');
// payload is typed but not validated
```

Same story: deploy multiple consumer replicas, each claims disjoint
batches, no partition config, per-aggregate ordering preserved.

---

## Core concepts

### Atomic claim

Both `PgLocalOutbox.claim()` and `PgEventBus.claim()` run a single CTE:

```sql
WITH claimed AS (
  SELECT id FROM events
  WHERE status = 'PENDING'
    AND ($4::text[] IS NULL OR event_type = ANY($4))  -- topic filter (bus only)
    AND NOT EXISTS (...)                              -- aggregate-ordering guard (bus only)
    AND pg_try_advisory_xact_lock(...)                -- concurrent-claim guard (bus only)
  ORDER BY created_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE events
SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3
FROM claimed
WHERE events.id = claimed.id
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` + atomic SET makes this race-free: multiple
replicas hitting the same query get disjoint batches. No replica ever
double-claims a row.

### Per-aggregate ordering (bus side)

Two guards together preserve "events for aggregate A go to the same
replica in order":

1. **`NOT EXISTS`** — don't claim an event for aggregate A if another
   CLAIMED row for A exists (handler is still running elsewhere).
2. **`pg_try_advisory_xact_lock(hashtext(aggregate_id))`** — closes the
   race window where two replicas read "no CLAIMED for A" concurrently.
   Only one of the concurrent transactions acquires the advisory lock;
   the other skips events for A.

Events with `aggregate_id IS NULL` are processed freely — no ordering
constraint to preserve.

### Stale-claim recovery

A replica that crashes mid-batch leaves rows stuck in CLAIMED. Both
`OutboxForwarder` and `EventConsumer` run a periodic `resetStale(cutoff)`
sweep (default: rows CLAIMED longer than 5 minutes). The stale rows flip
back to PENDING and any replica picks them up on the next tick.

### No DLQ table

FAILED rows stay in the main table with full context — `status='FAILED'`,
`retry_count`, `last_error`, `claimed_by`. Query them to inspect, replay
by flipping `status='PENDING'` and `retry_count=0`. One less table to
reason about.

### `EventDescriptor` — typed event identity

```ts
const OrderPlaced = defineEvent<{ orderId: string; total: number }>('order.placed');

consumer.on(OrderPlaced, async ({ payload }) => {
  // payload typed as { orderId: string; total: number }
});
```

A `{ name, schema? }` shape with a phantom payload type. Use at module
scope to keep event identity and payload type in one declaration.

When you pass a [Standard Schema v1][standard-schema] instance as the
second argument, the payload type is inferred from the schema and
`EventConsumer` validates it before dispatch (see below):

```ts
import { z } from 'zod';
const OrderPlaced = defineEvent('order.placed', z.object({ orderId: z.string() }));
// payload is inferred — no generic needed
```

[standard-schema]: https://standardschema.dev/

### `EventSubscription` — `(descriptor, handle)` pairs for composition

Module factories can return an array of subscriptions instead of wiring
handlers themselves. The composition root passes the combined array to
`EventConsumer`:

```ts
import type { EventSubscription } from '@quilla-be-kit/messaging';

// orders/subscriptions.ts
export const orderSubscriptions = (): EventSubscription[] => [
  { descriptor: OrderPlaced, handle: onOrderPlaced },
  { descriptor: OrderCancelled, handle: onOrderCancelled },
];

// composition-root.ts
const consumer = new EventConsumer({
  bus,
  consumerName: 'notifications',
  sourceService: 'notifications',
  logger,
  subscriptions: [
    ...userSubscriptions(),
    ...orderSubscriptions(),
  ],
});
```

`consumer.subscribe(subscriptions)` does the same thing post-construction,
for DI containers that resolve handlers after the consumer is built.
`consumer.on(descriptor, handler)` remains for ad-hoc wiring.

### Automatic payload validation (Standard Schema v1)

When an `EventDescriptor` carries a schema, `EventConsumer.on` wraps the
handler so `entry.payload` is validated before dispatch. Any Standard
Schema v1 vendor works — Zod (≥ 4), Valibot, ArkType — without a hard
dependency in `@quilla-be-kit/messaging`:

```ts
import { z } from 'zod';
import { defineEvent, SchemaValidationError } from '@quilla-be-kit/messaging';

const UserCreated = defineEvent(
  'user.created',
  z.object({
    userId: z.string().uuid(),
    email: z.string().email(),
  }),
);

consumer.on(UserCreated, async ({ payload }) => {
  // payload has already been validated
  await sendWelcomeEmail(payload.email);
});
```

Validation failures are **not** retried — the schema result is
deterministic. The event is marked `FAILED` directly, with the issue
summary in the row's `last_error` column. Log/metrics pipelines can
`instanceof`-check the exported `SchemaValidationError` to alert on
contract drift between producer and consumer.

### Automatic ExecutionContext reconstruction

When `EventConsumer` is wired with an `executionContext.provider`, each
handler dispatch is wrapped in `provider.runWithContext(...)` using a
context **reconstructed from the event's `EventMetadata`** — same
`correlationId`, `actorType`, `scopeId`, `userId` as the operation that
produced the event. The same `correlationId` that flowed through the
originating HTTP request surfaces on log lines emitted by the handler,
and `ExecutionContextProvider.getContext()` returns a valid context
inside handler code without the consumer wiring any middleware.

```ts
new EventConsumer({
  bus,
  consumerName: 'notifications',
  sourceService: 'notifications',
  logger,
  executionContext: { provider }, // reconstruct per-handler context from event metadata
});
```

Reconstruction uses `provider.factory.createFromEventMetadata(...)`;
override the provider's factory to reconstruct into an extended context
shape (see
[`@quilla-be-kit/execution-context` extension pattern](../execution-context/README.md#extension-pattern)).
Without an `executionContext` option, handlers still run — they just
don't have a context scope, and `getContext()` will throw if called.

---

## Customization

All knobs with sensible defaults. Defaults are exported for composition.

### `PgLocalOutbox`

```ts
new PgLocalOutbox({
  pool,
  tableName: 'outbox_events',   // override if you prefix tables per-service
  maxRetries: 3,                // flips status to FAILED after N failed markFailed calls
});
```

### `PgEventBus`

```ts
new PgEventBus({
  pool,
  eventsTableName: 'events',
  maxRetries: 3,
});
```

### `OutboxForwarder`

```ts
new OutboxForwarder({
  reader,
  publisher,
  sourceService: 'orders',
  logger,
  pollIntervalMs: 1000,          // DEFAULT_POLL_INTERVAL_MS
  batchSize: 100,                // DEFAULT_BATCH_SIZE
  staleClaimAfterMs: 5 * 60_000, // reset CLAIMED rows older than this
  instanceId: 'replica-<id>',    // defaults to randomUUID()
});
```

### `EventConsumer`

```ts
import {
  DEFAULT_RETRY_DELAYS_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_BATCH_SIZE,
} from '@quilla-be-kit/messaging';

new EventConsumer({
  bus,
  consumerName: 'notifications',
  sourceService: 'notifications',
  logger,
  pollIntervalMs: 1000,
  batchSize: 100,
  retryDelaysMs: [1000, 5000, 15000], // length = max retry attempts
  skipOwnEventKinds: ['integration'],
  staleClaimAfterMs: 5 * 60_000,
  instanceId: 'replica-<id>',
  executionContext: { provider }, // optional: reconstruct + scope per handler (factory is reached via provider.factory)
  onProcessed: (entry) => bumpMetric(entry),
});
```

---

## Schema

`getPostgresSchema()` returns DDL for the two tables:

```ts
import { getPostgresSchema } from '@quilla-be-kit/messaging/postgres';

const sql = getPostgresSchema({
  outboxTable: 'orders_outbox',   // defaults: 'outbox_events'
  eventsTable: 'svc_events',      // defaults: 'events'
});
await pool.query(sql);
```

### Dumb-DB principle

No `DEFAULT` clauses. Every value (`id`, `status`, `retry_count`,
timestamps) is written explicitly by library code. Benefits:

- Portable — any DB with `NOT NULL` support works.
- Testable — no DB defaults to simulate in fakes.
- Errors surface in TypeScript, not SQL.
- Migrations stay simple — no `ALTER COLUMN SET DEFAULT` drift.

UUIDs generated via `node:crypto.randomUUID()`. Monotonic sequence IDs
would normally need `BIGSERIAL`, but in the claim model there's no
ordering cursor — events are FIFO-drained by `created_at`.

### Indexes created

- **Outbox** — partial index on `(status, created_at) WHERE status = 'PENDING'`
  for the forwarder's claim query, plus `(claimed_at) WHERE status = 'CLAIMED'`
  for stale-claim scans.
- **Events** — partial index on `(event_type, created_at) WHERE status = 'PENDING'`
  matches `EventConsumer`'s topic-filtered claim query. Plus partial indexes on
  `(aggregate_id, status) WHERE aggregate_id IS NOT NULL AND status = 'CLAIMED'`
  for the `NOT EXISTS` aggregate guard, and `(claimed_at) WHERE status = 'CLAIMED'`
  for `resetStale`.

---

## Multi-replica scaling

Just deploy more replicas. Each instantiates its own `OutboxForwarder` /
`EventConsumer` with a unique `instanceId` (auto-generated by default).
All replicas compete for the same PENDING rows via atomic claim.

- **Outbox side**: N forwarders drain N× as fast. No configuration.
- **Bus side**: N consumers handle N× as fast. Per-aggregate ordering is
  preserved regardless of N — any given aggregate's events serialize
  naturally through the advisory-lock guard.

Scale up: add replicas. Scale down: remove them — in-flight CLAIMED rows
get reset to PENDING on the next `resetStale` sweep (default 5 min
cutoff).

---

## Retention and cleanup

### Event bus (`events` table)

- PENDING rows are cleared when consumers claim + succeed (rows deleted).
- FAILED rows stay put for operator inspection. Clean up on your cadence:
  ```ts
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await bus.cleanupFailed(cutoff, { limit: 1000 });
  ```

### Local outbox (`outbox_events` table)

- PENDING rows move to CLAIMED → SENT on success.
- SENT rows stay for audit. Clean up on your cadence:
  ```ts
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await outbox.cleanup(cutoff, { limit: 1000 });
  ```
- FAILED rows (outbox) stay put — handled the same way as the bus side:
  inspect manually, reset to PENDING to retry.

---

## Lifecycle integration

Both `OutboxForwarder` and `EventConsumer` implement `Disposable`:

```ts
import { ShutdownManager } from '@quilla-be-kit/runtime';

const shutdown = new ShutdownManager({ logger });
shutdown.registerPhase('consumers', [consumer]);
shutdown.registerPhase('forwarders', [forwarder]);

// Each dispose() awaits in-flight tick — no partial batches, no
// stranded CLAIMED rows (the next replica's sweep recovers them).
```

---

## Observability

`OutboxForwarder` and `EventConsumer` follow a consistent log-level
convention so production aggregators aren't flooded with routine
processing chatter:

| Level | When it fires |
| --- | --- |
| `info` | Lifecycle transitions: `starting`, `stopped`. One-shot per component per replica. |
| `debug` | Per-tick / per-batch processing: `forwarding N event(s)`, `registered event types`. High frequency. |
| `warn` | Recoverable anomalies: handler retry, stale-claim sweep hits, transient handler failures. |
| `error` | Terminal failures: handler exhausted retries, schema validation failed, tick crashed. |

`EventConsumer` splits its startup log to avoid unbounded `meta`
payloads in the info stream: the info entry carries
`registeredTypeCount` (a scalar); the full list is emitted separately at
debug. Programmatic callers can inspect registrations via the
`consumer.registeredEventTypes` accessor instead of log scraping:

```ts
const consumer = new EventConsumer({ bus, consumerName, sourceService, logger });
consumer.subscribe([
  ...userSubscriptions(),
  ...orderSubscriptions(),
]);
// Health check / test assertion:
expect(consumer.registeredEventTypes).toContain('user.created');
```

In production, set the logger level to `info` (default in most
deployments). For debugging event flow, bump a specific replica to
`debug` to see per-tick detail without changing code.

---

## Writing a custom broker adapter

Implement `EventBusPublisher` + `EventBusConsumer`:

```ts
import type {
  EventBusPublisher,
  EventBusConsumer,
  EventBusEntry,
} from '@quilla-be-kit/messaging';

class KafkaBus implements EventBusPublisher, EventBusConsumer {
  async publish(event) { /* produce to topic */ }
  async claim(instanceId, batchSize, allowedTopics) { /* pull + transition; filter by allowedTopics */ }
  async markDone(id) { /* commit offset */ }
  async markFailed(id, reason) { /* retry or DLQ per broker semantics */ }
  async resetStale(olderThan) { /* broker-specific recovery */ }
}

// Pair with the outbox forwarder:
const forwarder = new OutboxForwarder({
  reader: pgLocalOutbox,         // keep the Postgres outbox
  publisher: kafkaBus,           // swap the bus
  sourceService: 'orders',
  logger,
});
```

The claim pattern decouples "persist the event atomically" from "deliver
it reliably." You can mix — Postgres outbox on the emit side, Kafka bus
on the consume side — as infra evolves.

---

## License

MIT
