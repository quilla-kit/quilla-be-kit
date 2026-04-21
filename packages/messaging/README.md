# @quilla-kit/messaging

Broker-agnostic messaging for substrate-grade TypeScript services. Ships the
durable-event flow you reach for in production — **local outbox → event bus →
consumer with retries** — using an atomic claim pattern so multi-replica
deployments scale without coordination or configuration.

```sh
pnpm add @quilla-kit/messaging
# For the Postgres reference:
pnpm add pg
```

Node 22+, ESM-only.

---

## Single-subscriber constraint

The bus is a **worker queue**: each event is claimed and handled by **exactly
one consumer-replica across the entire deployment**. After a successful
handler chain, the row is deleted.

**In-process fan-out works normally.** A single consumer can register
multiple handlers for the same event type via `consumer.on(...)` — all of
them run when that replica claims the event.

**What this rules out**: two *independent* services subscribing to the same
event on the same bus. If service A consumes `order.placed`, service B does
not see it. If you need that, use a dedicated broker:

| Use case | Use this broker |
|---|---|
| Fan-out across services | Apache Kafka (consumer groups) |
| Topic subscriptions, exchanges | RabbitMQ |
| AWS-native fan-out | SNS → SQS |
| Simple single-service durable queue | This package |

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
import { getPostgresSchema } from '@quilla-kit/messaging/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await pool.query(getPostgresSchema());
```

Or pipe the string into drizzle-kit / knex / your migration tool.

### 2. Wire the outbox into your UnitOfWork

```ts
import { UnitOfWork } from '@quilla-kit/persistence';
import { PgDatabase } from '@quilla-kit/persistence/postgres';
import { PgLocalOutbox } from '@quilla-kit/messaging/postgres';

const db = new PgDatabase({ connectionString: process.env.DATABASE_URL });
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
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
import { OutboxForwarder } from '@quilla-kit/messaging';
import { PgEventBus } from '@quilla-kit/messaging/postgres';

const bus = new PgEventBus({ pool });
const forwarder = new OutboxForwarder({
  reader: outbox,
  publisher: bus,
  sourceService: 'orders',
  logger,
});
forwarder.start();

// On shutdown (via @quilla-kit/lifecycle ShutdownManager):
await forwarder.dispose();
```

Deploy multiple replicas of your service — all of them running the
forwarder — and they automatically coordinate via atomic claim. Each
PENDING row is claimed by exactly one replica. No partitioning, no
configuration.

### 4. Consume events

```ts
import { EventConsumer, defineEvent } from '@quilla-kit/messaging';

const OrderPlaced = defineEvent<{ orderId: string; total: number }>('order.placed');

const consumer = new EventConsumer({
  bus,
  consumerName: 'notifications',
  sourceService: 'notifications',
  logger,
  skipOwnEventKinds: ['integration'], // skip self-emitted integration events
});

consumer.on(OrderPlaced, async ({ payload, correlationId }) => {
  // payload is typed as { orderId: string; total: number }
  await sendReceiptEmail(payload.orderId);
});

consumer.start();

// On shutdown:
await consumer.dispose();
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
    AND NOT EXISTS (...)                       -- aggregate-ordering guard (bus only)
    AND pg_try_advisory_xact_lock(...)         -- concurrent-claim guard (bus only)
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
} from '@quilla-kit/messaging';

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
  executionContext: { factory, provider }, // optional: reconstruct + scope per handler
  onProcessed: (entry) => bumpMetric(entry),
});
```

---

## Schema

`getPostgresSchema()` returns DDL for the two tables:

```ts
import { getPostgresSchema } from '@quilla-kit/messaging/postgres';

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

- Partial index on `(status, created_at) WHERE status = 'PENDING'` — hot
  path for claim queries.
- Partial index on `(aggregate_id, status) WHERE aggregate_id IS NOT NULL
  AND status = 'CLAIMED'` — supports the `NOT EXISTS` aggregate guard.
- Partial index on `(claimed_at) WHERE status = 'CLAIMED'` — supports
  `resetStale` scans.

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
import { ShutdownManager } from '@quilla-kit/lifecycle';

const shutdown = new ShutdownManager({ logger });
shutdown.registerPhase('consumers', [consumer]);
shutdown.registerPhase('forwarders', [forwarder]);

// Each dispose() awaits in-flight tick — no partial batches, no
// stranded CLAIMED rows (the next replica's sweep recovers them).
```

---

## Writing a custom broker adapter

Implement `EventBusPublisher` + `EventBusConsumer`:

```ts
import type {
  EventBusPublisher,
  EventBusConsumer,
  EventBusEntry,
} from '@quilla-kit/messaging';

class KafkaBus implements EventBusPublisher, EventBusConsumer {
  async publish(event) { /* produce to topic */ }
  async claim(instanceId, batchSize) { /* pull + transition */ }
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
