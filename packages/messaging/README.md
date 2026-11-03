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
// The DDD-typed UnitOfWork: `serialize` receives domain and integration events.
import { UnitOfWork } from '@quilla-be-kit/persistence/aggregate';
import { PgDatabase } from '@quilla-be-kit/persistence/postgres';
import type { LocalOutboxInsertInput } from '@quilla-be-kit/messaging';
import { PgLocalOutbox } from '@quilla-be-kit/messaging/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = new PgDatabase({ pool });
const outbox = new PgLocalOutbox({ pool });

const uow = new UnitOfWork<LocalOutboxInsertInput>({
  db,
  events: {
    sink: { sink: (entries, trx) => outbox.insert(entries, trx) },
    serialize: (event) => ({
      eventType: event.name,
      eventVersion: 1,
      eventKind: 'domain',
      occurredAt: event.occurredAt, // event occurrence time, threaded through to the handler
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

`insert` takes any transaction object with a `query(sql, params)` method; it
only runs statements on it and never reads the results.

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

consumer.on(OrderPlaced, async ({ payload, correlationId, occurredAt }) => {
  // payload is already validated by OrderPlacedSchema before this line runs
  // occurredAt is the event's occurrence time (a first-class field, not payload)
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

Both `PgLocalOutbox.claim()` and `PgEventBus.claim()` run one transaction:
a claim CTE, then a verify statement (see
[Per-aggregate ordering](#per-aggregate-ordering)).

```sql
WITH claimed AS (
  SELECT id FROM events
  WHERE status = 'PENDING'
    AND event_type = ANY($4)                          -- topic filter (bus only)
    AND NOT EXISTS (...)                              -- aggregate has no CLAIMED row
    AND pg_try_advisory_xact_lock(...)                -- one claim per aggregate at a time
  ORDER BY seq NULLS FIRST, created_at
  LIMIT $1
  FOR UPDATE SKIP LOCKED
)
UPDATE events
SET status = 'CLAIMED', claimed_by = $2, claimed_at = $3,
    lease_expires_at = $5                             -- claim time + leaseMs
FROM claimed
WHERE events.id = claimed.id
RETURNING *;
```

`FOR UPDATE SKIP LOCKED` + atomic SET makes this race-free: multiple
replicas hitting the same query get disjoint batches. No replica ever
double-claims a row.

Claim order is `seq`, a counter the database assigns on insert, so it is
strictly increasing and never tied. `UPDATE … RETURNING` has no defined
row order, so the adapter sorts the batch by `seq` before handing it
over; events are dispatched in that order. `createdAt` on `publish()` and
`insert()` is informational: it doesn't affect ordering or retention.

### Per-aggregate ordering

Events of one aggregate are handled one at a time, in `seq` order, by
the outbox forwarder and by consumers. Four mechanisms hold that
together:

1. **`NOT EXISTS`** — don't claim an event for aggregate A while another
   row of A is CLAIMED (it's being handled elsewhere).
2. **`pg_try_advisory_xact_lock`** — only one in-flight claim
   transaction can take A's rows at a time; the others skip A.
3. **Verify before commit** — a claim statement reads one snapshot and
   tests the advisory lock row by row, so it can take a later event of A
   while missing an earlier one (another claim held A's lock and then
   committed). In the same transaction, a second statement with a fresh
   snapshot gives back any claimed row whose aggregate has, outside this
   batch, a CLAIMED row or an earlier PENDING row. For consumers, "earlier
   PENDING" only counts event types the consumer subscribes to.
4. **Stop the aggregate after a failure** — when an event of A fails (or
   its claim is lost), the rest of A in the same batch is skipped. Those
   rows keep their claim-time lease and come back together, behind the
   retried event, once it expires. A retry within one aggregate therefore
   waits up to one lease (`leaseMs`) plus one poll interval, as long as
   some replica is polling. An event that reaches FAILED stops blocking
   its aggregate.

Preconditions and limits:

- **Writers of one aggregate must be serialized.** `seq` follows insert
  order, not commit order. Kit aggregates saved through the unit of work
  with optimistic locking are serialized by their row lock; two
  concurrent transactions that emit events for the same `aggregateId`
  without a shared lock can commit out of `seq` order.
- **Rows written before 0.9.0** have no `seq`. They drain first, in their
  old `created_at` order, including that order's arbitrary ties. The
  guarantee applies to rows written once every process on the table runs
  0.9.0.

Events with `aggregate_id IS NULL` are processed freely — no ordering
constraint to preserve.

### Claim leases

A claim is a lease: the claiming replica writes `lease_expires_at`
(claim time + `leaseMs`, default 60 s). Both `OutboxForwarder` and
`EventConsumer` keep their claims alive and recover everyone else's:

- **Renewal.** While a row is being handled, the replica extends its lease
  every `renewIntervalMs` (default: a third of the lease). A handler can
  run for as long as it needs; only a replica that stops renewing (crash,
  kill, partition) loses its rows.
- **In-flight only.** Only the row currently being handled is renewed.
  The rest of a claimed batch keeps its original lease, so if the batch
  runs long, the unprocessed tail expires and idle replicas take it.
  Before dispatching each row, the replica confirms it still holds the
  claim (one query, only when the claim is older than one renewal
  interval) and skips rows it lost.
- **Recovery.** Every tick runs `resetStale`, which flips CLAIMED rows
  whose lease has expired back to PENDING. Each row carries its own
  deadline, so a consumer's `leaseMs` is honoured no matter which consumer
  runs the sweep.
- **Owner-checked completion.** `markDone` / `markFailed` / `markSent`
  only act on a row this replica still owns (or that was reset and not
  re-claimed). A replica that lost a claim can't delete or reset a row
  another replica is processing.
- **Rows without a lease** (claimed by a messaging version before 0.8.0)
  are recovered by the older rule: CLAIMED longer than `staleClaimAfterMs`
  (default 5 min).

Caveats:

- Renewal runs on a timer, so it needs the event loop. A long synchronous
  CPU-bound handler blocks renewal and loses its lease — move that work to
  a worker thread or yield periodically.
- Renewal queries share the `pg.Pool` with your handlers. If handlers
  saturate the pool, renewals queue; keep the lease well above the
  renewal interval.
- `instanceId` must be unique per process (the default `randomUUID()` is).
  Two processes sharing one renew and complete each other's claims.

When a replica finds a claim is no longer its own — a renewal or
pre-dispatch check comes back empty, or an owner-checked completion
matches nothing — it logs `claim lease lost; event may run more than
once` at `warn` and calls `onLeaseLost({ id, eventType, stage })` with
`stage` set to `'renew'`, `'done'` or `'failed'`. Wire the hook to a
counter: it's the signal that a duplicate run may have happened.

### No DLQ table

FAILED rows stay in the main table with full context — `status='FAILED'`,
`retry_count`, `last_error`, `failed_at`. Query them to inspect, replay
by setting `status='PENDING'`, `retry_count=0` and `failed_at=NULL`. One
less table to reason about.

### At-least-once delivery — handlers must be idempotent

The bus delivers each event **at least once**, never exactly-once. The
forwarder-replay path is closed by publisher-side dedup (see
[Publisher dedup](#publisher-dedup-via-origin_event_id) below), but two
operational paths still cause a consumer to see the same event more than
once:

- **Handler retry:** a handler in the chain throws, the row goes back to
  PENDING with `retry_count++`, and the whole event is re-dispatched. All
  handlers for that event re-run, including ones that already succeeded.
- **Crash after handler success but before `markDone`:** the row stays
  CLAIMED, `resetStale` flips it back to PENDING once the lease expires,
  the next replica re-dispatches **the same bus row** — same `id`, same
  payload.
- **Lost lease:** a replica that can't renew in time (blocked event loop,
  database outage, long pause) loses its claim while still running;
  another replica may run the same row concurrently. Owner-checked
  completion keeps the two runs from clobbering each other, and
  `onLeaseLost` reports it.

In both cases the *same bus row* is re-dispatched: the bus row `id` is
stable across these re-dispatches. (Contrast with forwarder replay, which
the publisher dedups away — no second bus row gets created.)

**Consumer handlers must still be idempotent.** Two standard patterns:

1. **Naturally idempotent effect.** The handler's side effect tolerates
   replay — UPSERT to a row keyed by `(aggregateId, eventType)`, an
   external API that accepts an idempotency key (Stripe-style), a state
   transition that's only valid from one starting state, etc.

2. **Processed-events table keyed on bus row `id`.** Because re-dispatch
   reuses the same bus row id, a UPSERT keyed on `entry.id` deduplicates
   handler-retry and stale-claim re-dispatch in one shot. Write the dedup
   row in the same transaction as the handler's effect:

   ```sql
   CREATE TABLE processed_events (
     consumer_name text NOT NULL,
     bus_event_id  uuid NOT NULL,
     processed_at  timestamptz NOT NULL,
     PRIMARY KEY (consumer_name, bus_event_id)
   );
   ```

   ```ts
   consumer.on(OrderPlaced, async ({ payload, id }) => {
     await db.transaction(async (trx) => {
       const inserted = await trx.query(
         `INSERT INTO processed_events (consumer_name, bus_event_id, processed_at)
          VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING 1`,
         ['billing', id, new Date()],
       );
       if (inserted.rowCount === 0) return; // already processed
       await chargeCustomer(trx, payload);
     });
   });
   ```

### Publisher dedup via `origin_event_id`

The publisher contract carries an optional `originEventId: string`. When
present, the bus enforces uniqueness on it via a partial unique index, so
a second publish for the same `originEventId` becomes a no-op — the
existing bus row's id is returned to the caller along with
`inserted: false`.

`OutboxForwarder` automatically passes the outbox row id as
`originEventId`. This closes the forwarder-replay hazard: if the
forwarder crashes between `bus.publish()` succeeding and
`outbox.markSent()` committing, the next tick republishes from the same
outbox row, the bus sees the same `originEventId`, and no second row is
created. Consumers never see the duplicate.

Direct-to-bus publishers can opt in by passing any stable string —
typically an external request id, a hash of the request, or any
identifier the caller controls. The field is `TEXT`, not `UUID`, so it
accommodates non-UUID identifiers.

`publish()` returns `{ id, inserted }`:

```ts
const { id, inserted } = await bus.publish({
  eventType: 'order.placed',
  /* ... */
  originEventId: 'stripe_charge_ch_3OabcXYZ', // dedup key
  occurredAt: new Date(), // event occurrence time
  createdAt: new Date(),
});
// inserted=true  → row was created with the returned id
// inserted=false → an earlier publish with the same originEventId already wrote it;
//                  the returned id is that pre-existing bus row's id
```

Omit `originEventId` entirely for fire-and-forget publishes that don't
need dedup. The partial unique index allows unlimited NULL values, so
omitting it never produces a conflict.

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

`consumer.on` also accepts a bare event-type string when you don't need a
typed descriptor or schema — useful for forwarding, logging, or bridging
to an external system where the payload shape doesn't matter:

```ts
consumer.on('order.placed', async (entry) => {
  // entry.payload is unknown — no validation, no type inference
  await auditLog.record(entry);
});
```

Prefer the descriptor form for any handler that reads `payload` fields.
The string form is intentionally untyped.

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
produced the event, plus any extended session fields carried in
`actorAttributes` (see
[Carrying extended session fields end to end](../execution-context/README.md#carrying-extended-session-fields-end-to-end)).
A session is rebuilt only when the metadata carries both `scopeId` and
`userId`. Metadata with only a `scopeId` (from scoped work with no session,
such as a job) comes back as a context with a session-less `scopeId`; a
system event with neither comes back unscoped. The same `correlationId` that flowed through the
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
  leaseMs: 60_000,              // DEFAULT_LEASE_MS — claim lease duration
});
```

`insert` accepts any number of entries. Past Postgres' 65,535-parameter
limit (4,369 entries) it writes them in several statements, all on the
transaction you pass, so a commit's events still land or roll back together.

### `PgEventBus`

```ts
new PgEventBus({
  pool,
  eventsTableName: 'events',
  maxRetries: 3,
  leaseMs: 60_000,              // DEFAULT_LEASE_MS — claim lease duration
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
  staleClaimAfterMs: 5 * 60_000, // recovery cutoff for claims without a lease
  renewIntervalMs: 20_000,       // defaults to a third of the reader's lease; 0 disables
  instanceId: 'replica-<id>',    // defaults to randomUUID(); must be unique per process
  onLeaseLost: (info) => bumpMetric(info),
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
  staleClaimAfterMs: 5 * 60_000,     // recovery cutoff for claims without a lease
  renewIntervalMs: 20_000,           // defaults to a third of the bus's lease; 0 disables
  instanceId: 'replica-<id>',        // must be unique per process
  executionContext: { provider }, // optional: reconstruct + scope per handler (factory is reached via provider.factory)
  onProcessed: (entry) => bumpMetric(entry),
  onLeaseLost: ({ id, eventType, stage }) => bumpMetric({ id, eventType, stage }),
});
```

`renewIntervalMs` must be below the lease. With renewal disabled
(`renewIntervalMs: 0`) the component logs a warning at start: any row
handled for longer than the lease is re-dispatched.

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

It is meant for **new installs**. Running it again is safe — every step
checks the catalog first, so tables that are already up to date aren't
locked. On an existing table that lacks a later version's indexes, it
builds them without `CONCURRENTLY`, which scans the whole table and blocks
writes while it runs: for production tables, apply the upgrade SQL below
instead.

### Upgrading to 0.9.0

0.9.0 adds `failed_at` and a database-generated `seq` to both tables, plus
indexes for the new claim order. **Apply the migration before any 0.9.0
process starts**; a 0.9.0 process on an unmigrated table fails with
`MissingColumnError`. Split it into two changesets per database (adjust
the table names; the defaults are `events` and `outbox_events`).

Changeset 1 — transactional:

```sql
SET LOCAL lock_timeout = '5s';
ALTER TABLE events ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
-- Add seq without a default first: ADD COLUMN … DEFAULT nextval() rewrites the table.
ALTER TABLE events ADD COLUMN IF NOT EXISTS seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS events_seq OWNED BY events.seq;  -- keep the default CACHE 1
ALTER TABLE events ALTER COLUMN seq SET DEFAULT nextval('events_seq');
```

```sql
SET LOCAL lock_timeout = '5s';
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ;
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS outbox_events_seq OWNED BY outbox_events.seq;
ALTER TABLE outbox_events ALTER COLUMN seq SET DEFAULT nextval('outbox_events_seq');
```

Changeset 2 — outside a transaction (Liquibase `runInTransaction: false`):

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_event_type_seq_idx
  ON events (event_type, seq NULLS FIRST, created_at) WHERE status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_aggregate_id_seq_idx
  ON events (aggregate_id, seq NULLS FIRST)
  WHERE aggregate_id IS NOT NULL AND status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS events_failed_at_idx
  ON events (failed_at) WHERE status = 'FAILED';
```

```sql
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_seq_idx
  ON outbox_events (seq NULLS FIRST, created_at) WHERE status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_aggregate_id_status_idx
  ON outbox_events (aggregate_id, status)
  WHERE aggregate_id IS NOT NULL AND status = 'CLAIMED';
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_aggregate_id_seq_idx
  ON outbox_events (aggregate_id, seq NULLS FIRST)
  WHERE aggregate_id IS NOT NULL AND status = 'PENDING';
CREATE INDEX CONCURRENTLY IF NOT EXISTS outbox_events_failed_at_idx
  ON outbox_events (failed_at) WHERE status = 'FAILED';
```

A `CONCURRENTLY` build that fails leaves an INVALID index, which
`IF NOT EXISTS` then skips. Check with
`SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;`, drop
any it lists, and run the statement again.

`seq` must keep the sequence's default `CACHE 1`; a larger cache hands out
values per session, out of order. The old claim indexes
(`events_event_type_created_at_idx`, `outbox_events_status_created_at_idx`)
are no longer used and can be dropped.

Rolling out:

- Older versions keep working on the migrated table. Their inserts get a
  `seq` from the default.
- Older forwarders and consumers don't verify claims or stop an aggregate
  after a failure, so per-aggregate ordering is guaranteed once every
  process on a table runs 0.9.0.
- Rows failed by older versions have no `failed_at` and are kept by
  `cleanupFailed`. **After the last older process stops**, start their
  retention window with:

  ```sql
  UPDATE events SET failed_at = now() WHERE status = 'FAILED' AND failed_at IS NULL;
  UPDATE outbox_events SET failed_at = now() WHERE status = 'FAILED' AND failed_at IS NULL;
  ```

  It is idempotent and safe to re-run.

### Upgrading to 0.8.0

0.8.0 adds a nullable `lease_expires_at` column to both tables. **Apply
it before any 0.8.0 process starts** — a 0.8.0 process on an unmigrated
table fails every claim with `MissingColumnError` (exported as
`MissingLeaseColumnError` too, its 0.8.0 name). If you run
`getPostgresSchema()` at boot, that already does it. Otherwise, for
migration tools (one statement per table; adjust the table names):

```sql
-- events table
SET LOCAL lock_timeout = '5s';
ALTER TABLE events ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
```

```sql
-- outbox table
SET LOCAL lock_timeout = '5s';
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;
```

No backfill and no index change. Adding a nullable column without a
default doesn't rewrite the table, but it takes a brief exclusive lock;
`lock_timeout` makes the statement fail fast instead of queueing behind a
long transaction (retry it if it times out).

After migrating, upgrade processes in any order. Older versions keep
working on the migrated table: they ignore the column, and rows they
claim are recovered with the `staleClaimAfterMs` rule. Live claims held
by 0.8.0 processes are never reset by an older process's sweep, as long
as `renewIntervalMs` stays below every older consumer's
`staleClaimAfterMs` (20 s vs 5 min by default). Owner-checked completion
applies once every process on a table runs 0.8.0. To roll back, downgrade
the processes; the column can stay.

### Dumb-DB principle

No `DEFAULT` clauses, with one exception. Every value (`id`, `status`,
`retry_count`, timestamps) is written explicitly by library code.
Benefits:

- Portable — any DB with `NOT NULL` support works.
- Testable — no DB defaults to simulate in fakes.
- Errors surface in TypeScript, not SQL.
- Migrations stay simple — no `ALTER COLUMN SET DEFAULT` drift.

UUIDs generated via `node:crypto.randomUUID()`. The exception is `seq`,
the claim order: only the database can hand out a counter that increases
across every process that writes, so it comes from
`DEFAULT nextval('<table>_seq')` and library code never writes it.

### Indexes created

- **Both tables** — `(failed_at) WHERE status = 'FAILED'` for `cleanupFailed`.
- **Outbox** — partial index on `(seq NULLS FIRST, created_at) WHERE status = 'PENDING'`
  for the forwarder's claim query, `(aggregate_id, status) WHERE aggregate_id
  IS NOT NULL AND status = 'CLAIMED'` and `(aggregate_id, seq NULLS FIRST)
  WHERE aggregate_id IS NOT NULL AND status = 'PENDING'` for its aggregate
  guard and claim verification, plus
  `(claimed_at) WHERE status = 'CLAIMED'` for the lease-expiry sweep.
- **Events** — partial index on `(event_type, seq NULLS FIRST, created_at) WHERE status = 'PENDING'`
  matches `EventConsumer`'s topic-filtered claim query. Plus partial indexes on
  `(aggregate_id, status) WHERE aggregate_id IS NOT NULL AND status = 'CLAIMED'`
  for the `NOT EXISTS` aggregate guard, `(aggregate_id, seq NULLS FIRST) WHERE
  aggregate_id IS NOT NULL AND status = 'PENDING'` for claim verification,
  `(claimed_at) WHERE status = 'CLAIMED'`
  for the lease-expiry sweep in `resetStale`, and a **partial unique index** on `(origin_event_id) WHERE
  origin_event_id IS NOT NULL` that enforces the publisher dedup contract
  described in [At-least-once delivery](#at-least-once-delivery--handlers-must-be-idempotent).

---

## Multi-replica scaling

Just deploy more replicas. Each instantiates its own `OutboxForwarder` /
`EventConsumer` with a unique `instanceId` (auto-generated by default).
All replicas compete for the same PENDING rows via atomic claim.

- **Outbox side**: N forwarders drain N× as fast. No configuration. One
  aggregate's events are forwarded by one replica at a time, so they reach
  the bus in outbox order.
- **Bus side**: N consumers handle N× as fast. Per-aggregate ordering is
  preserved regardless of N (see
  [Per-aggregate ordering](#per-aggregate-ordering) for its preconditions).

Scale up: add replicas. Scale down: remove them — a removed replica's
CLAIMED rows go back to PENDING once their lease expires (default 60 s).
Long-running handlers are safe to scale out: renewal keeps a live claim
from being picked up by a second replica.

---

## Retention and cleanup

### Event bus (`events` table)

- PENDING rows are cleared when consumers claim + succeed (rows deleted).
- FAILED rows stay put for operator inspection. Clean up on your cadence:
  ```ts
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await bus.cleanupFailed(cutoff, { limit: 1000 });
  ```
  The window is measured from `failed_at`, which the kit stamps when a
  row is dead-lettered — not from `createdAt` or any other value a
  publisher supplies. Rows with no `failed_at` (dead-lettered before
  0.9.0) are kept until the backfill in
  [Upgrading to 0.9.0](#upgrading-to-090) starts their window.

### Local outbox (`outbox_events` table)

- PENDING rows move to CLAIMED → SENT on success.
- SENT rows stay for audit. Clean up on your cadence:
  ```ts
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  await outbox.cleanup(cutoff, { limit: 1000 });
  ```
- FAILED rows stay put — handled the same way as the bus side: inspect
  them, reset to PENDING to retry, and clean up on your cadence (same
  `failed_at` window):
  ```ts
  await outbox.cleanupFailed(cutoff, { limit: 1000 });
  ```

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
| `warn` | Recoverable anomalies: handler retry, stale-claim sweep hits, lost claim leases, renewal disabled at start, transient handler failures. |
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
  async publish(event) { /* produce to topic; return generated id */ }
  async claim(instanceId, batchSize, allowedTopics) { /* pull + transition; filter by allowedTopics */ }
  async markDone(id, instanceId) { /* commit offset */ }
  async markFailed(id, reason, instanceId) { /* retry or DLQ per broker semantics */ }
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

**Claim leases are optional for adapters.**

- `lease` — expose `{ durationMs, renew(instanceId, ids) }` when the
  broker can extend a single message's claim; `renew` resolves to the ids
  still held. Consumers then renew automatically. Leave it out when the
  broker manages liveness itself.
- `instanceId` on `markDone` / `markFailed` — when the broker reports that
  an ack didn't count (the claim moved elsewhere), throw `ClaimLostError`
  so the consumer reports it via `onLeaseLost` and carries on. Detect it
  with `ClaimLostError.is(err)`.

| Broker | `lease.renew` | Lost-claim signal → `ClaimLostError` |
| --- | --- | --- |
| SQS | `ChangeMessageVisibility` | stale receipt handle |
| Google Pub/Sub | `modifyAckDeadline` | ack after the deadline |
| NATS JetStream | `msg.working()` | redelivered to another consumer |
| RabbitMQ | omit (`consumer_timeout`, channel liveness) | ack on a closed channel |
| Kafka | omit (consumer-group heartbeat) | `CommitFailedException` after a rebalance |

`LocalOutboxReader` takes the same optional `lease` and `instanceId` on
`markSent` / `markFailed`.

The claim pattern decouples "persist the event atomically" from "deliver
it reliably." You can mix — Postgres outbox on the emit side, Kafka bus
on the consume side — as infra evolves.

---

## License

MIT
