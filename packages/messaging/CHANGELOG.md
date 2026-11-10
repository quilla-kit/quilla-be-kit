# @quilla-be-kit/messaging

## 0.12.0

### Minor Changes

- 9df1fe9: Dead-letter failures a retry cannot fix, check handler requirements per handler, hook `forEachScope` failures, and ship test builders.

  **messaging**

  - **Breaking for custom bus adapters:** `EventBusConsumer` requires `markFailedPermanently(id, reason, instanceId?)`, which dead-letters at once without redelivery. `PgEventBus` implements it.
  - Permanent failures skip in-process retries and, when every failing handler of an event failed permanently, dead-letter the event on its first attempt instead of redelivering it until `maxRetries`. Always permanent: `SchemaValidationError`, `MissingScopeError` / `MissingSessionError`, and errors rebuilding the context from event metadata. New option `isPermanentFailure(error, { entry })` classifies app errors; a throwing predicate is treated as transient.
  - `onFailed(entry, { permanent })` gains a second argument.
  - `requires` is checked per handler: an unmet requirement fails only its own handler, and the event's other handlers still run.
  - New `@quilla-be-kit/messaging/testing`: `createTestHandlerEntry(payload, { context, fields })`.

  **jobs**

  - `forEachScope(entries, fn, { onScopeFailed })`: replaces the default failure log; called with `{ aborted }`, awaited and guarded.

  **http**

  - New `@quilla-be-kit/http/testing`: `createTestHttpRequest(options)`, built by the adapters' own request factory.

  **execution-context**

  - New `@quilla-be-kit/execution-context/testing`: `testExecutionContext(overrides)` and `testContextView(overrides)`. Released as a patch so packages depending on `^0.6.0` don't have to move together.

### Patch Changes

- Updated dependencies [9df1fe9]
  - @quilla-be-kit/execution-context@0.6.1

## 0.11.0

### Minor Changes

- 599429f: Cross between scopes under an app-owned policy, and read the execution context from event handlers, jobs and routes through one `getContext()` view.

  **execution-context**

  - `provider.crossScope(scopeId, fn)` runs `fn` in the current context moved to another scope. It adds or joins a scope like `withScope`. Moving from one scope to another requires a `ScopeCrossingPolicy` (`authorize`, optional `projectContext`), passed as `scopeCrossing` on `AsyncExecutionContextProvider` (a function returning it is resolved on first use). The kit keeps `actorType`, `correlationId`, `executionAttemptId` and the session's `userId`, drops every other field by default, and records the origin scope in the new `ExecutionContext.crossedFrom`. Custom `ExecutionContextProvider` implementations must add `crossScope` (`crossExecutionContext` builds its context) and must keep `executionAttemptId` in `withScope` and `crossScope`. A custom `ExecutionContextFactory` should extend the default `createFromEventMetadata` result so `crossedFrom` keeps round-tripping.
  - `toEventMetadataSource(ctx, { actorAttributeKeys })` builds the event metadata a context should stamp, the inverse of `createFromEventMetadata`, which now also restores `crossedFrom`.
  - `ExecutionContextView` (+ scoped and session variants) and `toExecutionContextView(ctx)`.
  - `requireScopeId(ctx)` / `requireSession(ctx)` / `requireContext(ctx, 'scope' | 'session')`, throwing `MissingScopeError` / `MissingSessionError` (`InternalError`s, matched across duplicate installs with `.is(err)`). The package now depends on `@quilla-be-kit/errors`.
  - `readAttemptContext(provider, attemptId)` returns the current context only while it belongs to that execution attempt.
  - The log enricher adds `extra.crossedFrom`.

  **ddd**

  - `EventMetadata` gains an optional `crossedFrom` (requires `scopeId`, must differ from it; omitted from JSON when absent). `RESERVED_ACTOR_ATTRIBUTE_KEYS` is exported.

  **messaging**

  - `HandlerEntry.getContext()` returns the live `ExecutionContextView`. It throws when the consumer has no `executionContext`, when called outside the handler's dispatch, or when the context no longer meets the handler's requirement. Entries built by hand (test fixtures) must add it: use `createHandlerEntry(fields, view)`.
  - Handlers declare `requires: 'scope' | 'session'` (`on(..., { requires })`, `ScopedEventSubscription`, `SessionEventSubscription`) for a narrowed entry type. Every requirement is checked before an event's handlers run; if one is unmet, none runs and the row is marked failed without in-process retries. Declaring a requirement without `executionContext` throws at registration.
  - README: validation failures are redelivered until `maxRetries` like any failure, not marked `FAILED` directly.

  **jobs**

  - `BackgroundJob.execute(signal, execution)`: `execution.getContext()` and `execution.forEachScope(entries, fn)`, which runs `fn` once per scope in `withScope`, isolates and logs failures, and skips the remaining scopes once aborted. Jobs implementing `execute(signal)` still type-check; calls through the `BackgroundJob` type pass both arguments. Custom runners build the argument with `createJobExecution(...)`.

  **http**

  - `HttpRequest.getContext()` returns the live `ExecutionContextView`. Custom `HttpRequest` implementations must add it. `getExecutionContext()` is deprecated in its favour.

  **persistence**

  - README example reads the scope with `req.getContext()`.

### Patch Changes

- Updated dependencies [599429f]
  - @quilla-be-kit/execution-context@0.6.0

## 0.10.0

### Minor Changes

- 913f8f0: Batches hand back the rows they haven't started instead of letting them expire, and every failed attempt is observable through a new `onFailed` hook.

  **Hand-back**

  - A batch still running after one renewal interval (a third of the lease by default) returns its unstarted rows to PENDING, owner-checked, so idle replicas can take them. Before, those rows kept their claim-time lease and expired behind a slow handler (or behind `batchSize` × handler time), and the replica then reported them as lost claims.
  - When a batch ends, rows it skipped are handed back too: the rest of an aggregate after a failure or a lost claim, and rows left by shutdown. A retry within one aggregate now comes back within one poll interval instead of up to one lease. Any delay between attempts comes from `retryDelaysMs`.
  - A row whose claim is gone before it was dispatched is skipped with a `debug` log. It no longer triggers the `claim lease lost` warning or `onLeaseLost`, since it never ran on this replica.
  - `ClaimLease` gains an optional `release(instanceId, ids)`, which `PgEventBus` and `PgLocalOutbox` implement. A custom lease without it renews unstarted rows instead of handing them back.

  **Failures**

  - New `onFailed(entry)` on `EventConsumer` and `OutboxForwarder`. It runs after each failed attempt is recorded, with the updated entry. `entry.status === 'FAILED'` means the row was dead-lettered, with `retryCount`, `lastError` and `failedAt`. It isn't called when the claim was lost (`onLeaseLost` reports that). `onProcessed` still runs only on success.
  - `onProcessed` and `onFailed` errors are logged and no longer abandon the batch. Before, a throwing `onProcessed` left the event CLAIMED, and it was dispatched again after the lease.
  - **Breaking for custom adapters:** `EventBusConsumer.markFailed` and `LocalOutboxReader.markFailed` now resolve to the updated entry (`EventBusEntry | undefined` / `LocalOutboxEntry | undefined`) instead of `void`. Resolve to `undefined` when the broker can't report it; `onFailed` is then skipped.
  - The schema-validation log now reads `skipping in-process retries`: the row still counts toward the bus's `maxRetries`.

  No schema change or migration.

## 0.9.0

### Minor Changes

- 7927c84: Retention and claim ordering now run on values the kit owns. Dead-letter retention no longer depends on the publisher's `createdAt`, and per-aggregate ordering holds across concurrent claims, multiple forwarders and retries.

  **Migration**

  - Before starting any 0.9.0 process, add `failed_at TIMESTAMPTZ` and a database-generated `seq BIGINT` (a per-table sequence plus `SET DEFAULT nextval(…)`, added in that order to avoid a table rewrite) to the events and outbox tables, then build the new claim and verification indexes with `CREATE INDEX CONCURRENTLY`. The README "Upgrading to 0.9.0" section has the SQL split into a transactional changeset and a non-transactional index changeset.
  - `getPostgresSchema()` adds all of this too, but builds indexes without `CONCURRENTLY`, so it scans and blocks the table. Use it for new installs, not as the production upgrade path.
  - After the last pre-0.9.0 process stops, run the README's `failed_at` backfill to start the retention window of rows dead-lettered earlier. Until then, `cleanupFailed` keeps them.
  - The old `created_at` claim indexes are unused and can be dropped.
  - `MissingLeaseColumnError` is now `MissingColumnError` and also covers `seq` and `failed_at`. The old name stays exported as an alias, so imports and `instanceof` keep working, but the error `code` changes from `MISSING_LEASE_COLUMN` to `MISSING_COLUMN`: update any code that matches on it.

  **Behaviour changes**

  - `PgEventBus.cleanupFailed` cuts off on `failed_at`, which is stamped when a row is dead-lettered, instead of `created_at`. Rows with no `failed_at` are kept.
  - Claims order by `seq`, then `created_at` for rows written before 0.9.0, and batches are dispatched in that order. `createdAt` is informational.
  - Each claim runs in one transaction with a verify step. It hands back any claimed row whose aggregate has, outside the batch, a CLAIMED row or an earlier PENDING row (for consumers, only of the event types they subscribe to). This closes two races: one let two replicas hold the same aggregate at once, the other let a later event of an aggregate be claimed while an earlier one was skipped by a concurrent scan.
  - The outbox claim gets the bus's per-aggregate guard, so one aggregate's entries are forwarded by one replica at a time and reach the bus in outbox order.
  - When an event fails or loses its claim, `EventConsumer` and `OutboxForwarder` skip the rest of its aggregate in that batch. The skipped rows come back behind the retried event after one lease.

  **New**

  - `PgLocalOutbox.cleanupFailed(olderThan, { limit })`, and a `(failed_at) WHERE status = 'FAILED'` index on both tables for cleanup.
  - `failedAt` on `EventBusEntry` / `LocalOutboxEntry`.
  - An env-gated real-Postgres test suite: `MESSAGING_PG_URL=… pnpm --filter @quilla-be-kit/messaging test:pg`.

## 0.8.0

### Minor Changes

- e0ec947: Claims are leases: the claiming replica writes a per-row deadline, renews it while a row is being handled, and completes only rows it still owns. A live claim is never reset under a running handler, and a crashed replica's rows come back after one lease (60 s by default) instead of 5 min.

  **Migration**

  - Add the nullable `lease_expires_at TIMESTAMPTZ` column to the events and outbox tables **before** starting any 0.8.0 process. No backfill, no index change. `getPostgresSchema()` now adds the column when it is missing (checking the catalog first, so migrated tables aren't locked), so running it at boot upgrades existing tables. Without the column, Postgres adapters throw `MissingLeaseColumnError`. The README has plain SQL for migration tools and the rolling-upgrade order.
  - Older versions keep working on the migrated table. Rows they claim are recovered with the existing `staleClaimAfterMs` rule.
  - Custom `EventBusConsumer` / `LocalOutboxReader` implementations compile unchanged: the new members are optional.

  **Behaviour changes**

  - Claim renewal is on by default for adapters that expose a lease (both Postgres adapters do): every `leaseMs / 3`, for the row being handled only. The unprocessed tail of a long batch expires and redistributes to idle replicas. Before dispatching a row, the replica confirms it still holds the claim (only when the claim is older than one renewal interval) and skips it otherwise.
  - `resetStale` resets rows whose lease has expired, plus rows without a lease that are older than the cutoff. Each consumer's `leaseMs` holds whichever consumer runs the sweep.
  - `EventConsumer` and `OutboxForwarder` pass their `instanceId` to `markDone` / `markFailed` / `markSent`. The Postgres adapters then act only on rows this instance owns or that were reset and not re-claimed, and throw `ClaimLostError` otherwise.
  - `staleClaimAfterMs` now only applies to claims without a lease.

  **New**

  - `PgEventBus` / `PgLocalOutbox` option `leaseMs` (default `DEFAULT_LEASE_MS`, 60 s) and a `lease` property.
  - `EventConsumer` / `OutboxForwarder` options `renewIntervalMs` (default a third of the lease; `0` disables renewal and logs a warning at start) and `onLeaseLost({ id, eventType, stage })`. When a claim turns out to be lost, the component logs a warning and calls the hook once per row.
  - Optional `lease?: ClaimLease` and `instanceId` parameters on `EventBusConsumer` / `LocalOutboxReader`. Adapters for brokers that can extend a claim (SQS, Pub/Sub, JetStream) can implement renewal; any adapter can throw `ClaimLostError` when an ack didn't count.
  - `leaseExpiresAt` on `EventBusEntry` / `LocalOutboxEntry`.
  - Exports: `ClaimLease`, `LeaseLostInfo`, `LeaseLostStage`, `ClaimLostError`, `DEFAULT_LEASE_MS`; `MissingLeaseColumnError` from `/postgres`.

## 0.7.1

### Patch Changes

- 3413b56: README: the outbox wiring example imports the DDD-typed `UnitOfWork` from `@quilla-be-kit/persistence/aggregate`.

## 0.7.0

### Minor Changes

- 3a4e233: `TransactionHandle` asks only for what the outbox uses: `query(sql, params?) => Promise<unknown>`. Any transaction object with that method — a driver client, or another library's transaction type — can now be passed to `LocalOutboxWriter.insert` without a cast. Implementations written against the previous generic signature still satisfy it.

  **Breaking:** code that called `query<Row>()` or read `.rows` through a value typed as `TransactionHandle` no longer compiles; type that value as your driver's own transaction type instead.

  The README's `UnitOfWork` wiring example now type-checks: it passes an inline `sink` that calls `outbox.insert(entries, trx)`.

## 0.6.5

### Patch Changes

- 450841f: `PgLocalOutbox.insert` accepts any number of entries. It bound 15 parameters per entry in one statement, so a commit with more than 4,369 events exceeded Postgres' 65,535-parameter limit and rolled back the whole unit of work. Larger batches are now written in several statements on the caller's transaction; a batch of 4,369 entries or fewer emits the same SQL as before. `LocalOutboxWriter.insert` now documents that implementations accept any batch size and that `trx` must be an open transaction.

## 0.6.4

### Patch Changes

- 5054ac1: README: event metadata with only a `scopeId` now comes back as a context with a session-less `scopeId`.
- Updated dependencies [5054ac1]
  - @quilla-be-kit/execution-context@0.5.0

## 0.6.3

### Patch Changes

- c073429: Carry app-defined session fields through validated input, logs and events.

  `http`: `AuthMiddlewareStack` gains `sessionKeys`. On that stack's routes, `@ValidateRequest` injects the listed `ExecutionContext.session` fields when the schema declares them, alongside `scopeId`/`userId`. A client-sent value for those keys is always discarded, even when the validator has no `describeSchema`, and a key the session can't supply fails the request with a generic 500.

  New construction errors:

  - `sessionKeys` without `sessionLoad`.
  - An empty or prototype-named session key.
  - A route that sources a session key from a header on a stack with `sessionLoad`. This also covers `scopeId`/`userId`, so a route mapping them to a header on such a stack now throws.

  Behavior changes:

  - Session fields are injected after header fields, so the session wins over a header mapped to the same key.
  - A session without a `scopeId`/`userId` value the schema declares now fails with a 500 instead of injecting `undefined`.

  `ddd`: `EventMetadata` gains optional `actorAttributes`, app-defined facts about the actor beyond `scopeId`/`userId`. Values are strings, numbers or booleans; both ids are required and their names can't be reused. `toJSON` omits the key when absent, so existing event JSON is unchanged. New type export: `ActorAttributes`.

  `execution-context`:

  - `createFromEventMetadata` accepts parsed JSON metadata (`EventMetadataSource`) and restores `actorAttributes` onto the session.
  - `ExecutionContextEnricher` takes an optional `{ sessionKeys }` to log the listed session fields under `extra.session`.
  - **Fix:** a system event read back from the bus (`scopeId: null`, `userId: null`) was rebuilt as an authenticated context with `null` ids; it now has no session.

  `messaging`, `security`: README updates for the above.

- Updated dependencies [c073429]
  - @quilla-be-kit/execution-context@0.4.0

## 0.6.2

### Patch Changes

- Updated dependencies [603c3af]
  - @quilla-be-kit/execution-context@0.3.0
  - @quilla-be-kit/observability@0.3.0

## 0.6.1

### Patch Changes

- Updated dependencies [af8e523]
  - @quilla-be-kit/errors@0.3.0

## 0.6.0

### Minor Changes

- ffd752a: Surface event `occurredAt` as a first-class transported field.

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

## 0.5.1

### Patch Changes

- 77153bc: Document `EventConsumer.on(string, handler)` bare-string overload. The descriptor form was the only documented usage; the string form (for untyped forwarding / bridging) was silently available but invisible to consumers.
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
  - @quilla-be-kit/execution-context@0.2.2
  - @quilla-be-kit/observability@0.2.2
  - @quilla-be-kit/runtime@0.2.2

## 0.5.0

### Minor Changes

- 16a5595: feat(messaging)!: publisher-side dedup via `origin_event_id`

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

## 0.4.0

### Minor Changes

- c73c5f6: **Breaking:** `EventBusPublisher.publish` no longer accepts a caller-supplied
  `id`; the bus owns event identity and returns the generated id.

  The previous shape exposed `id: string` as a required input. Combined with the
  explicit at-least-once retry loop, this created a contract trap: any caller
  that reused an id across publish attempts (intentionally — content-addressed
  ids — or accidentally — wrapping `publish` in a retry block) collided on
  `events_pkey` and silently wedged the bus.

  The new shape closes the trap by removing the parameter entirely:

  ```ts
  // before
  await publisher.publish({ id: myId, eventType, ..., createdAt });

  // after
  const busEventId: string = await publisher.publish({ eventType, ..., createdAt });
  ```

  `PgEventBus.publish` now generates a UUID v4 internally per call. `OutboxForwarder`
  no longer preserves a 1:1 correspondence between outbox row id and bus event id —
  each forwarder publish generates a fresh bus id. The outbox row id and bus
  event id are now logged together at `debug` level for tracing.

  ### Delivery-semantics implication

  With toolkit-owned ids, the forwarder's "publish then markSent" pattern can
  produce **duplicate bus rows for the same logical event** if `markSent` fails
  after `publish` commits (next tick re-claims the outbox row → publishes
  again with a fresh id → consumer dispatches twice). This is at-least-once
  delivery working as documented — but the README previously did not spell out
  the consequences for consumer handlers.

  The README now has a `### At-least-once delivery — handlers must be idempotent`
  section in Core concepts with the standard `processed_events`-table recipe.
  Handlers whose side effects are not naturally idempotent must dedup themselves
  until a first-class `IdempotencyStore` lands.

  ### Migration

  - Drop the `id` field from any `publish({...})` call site.
  - If you were relying on `id` correspondence between outbox rows and bus rows
    for tracing, switch to the `outboxId` + `busEventId` pair in the forwarder's
    `debug`-level "forwarded outbox entry" log line.
  - Audit consumer handlers for replay-safety and add a `processed_events` table
    for any non-idempotent side effects.

## 0.3.1

### Patch Changes

- cc2b476: improve `PgEventBus.claim()` query planning and trim consumer hot-path allocation

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

## 0.3.0

### Minor Changes

- 9e0fe31: scope event-bus claims to the consumer's registered topics

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

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages
- Updated dependencies [30c8333]
  - @quilla-be-kit/errors@0.2.1
  - @quilla-be-kit/execution-context@0.2.1
  - @quilla-be-kit/observability@0.2.1
  - @quilla-be-kit/runtime@0.2.1

## 0.2.0

### Minor Changes

- 8f55864: `EventConsumer.start()` splits its one info entry into two: the info
  log carries scalar fields (`pollIntervalMs`, `batchSize`,
  `registeredTypeCount`, `instanceId`) and the full `registeredTypes`
  list moves to debug. Keeps info-stream meta payloads bounded even when
  a consumer has many handler registrations.

  `EventConsumer.registeredEventTypes` (readonly getter) exposes the
  registered event-type names for health checks and tests without
  parsing logs.

  `OutboxForwarder.tick()` emits `forwarding N event(s)` at debug
  instead of info — it fires on every tick with pending events and was
  flooding info streams in services with continuous outbox traffic.
  Info remains reserved for lifecycle transitions (`starting`,
  `stopped`) and errors/warnings for anomalies.

- 59f4bd0: `EventConsumerOptions.executionContext` takes `{ provider }` only.
  `EventConsumer` reads the factory from `provider.factory`, matching the
  provider-carried-factory convention already used by http and security.
- 7c86c48: `EventSubscription` is an `interface`. Consumers can `class Foo implements
EventSubscription<Payload>` with a plain `async handle(entry)` method —
  no constructor property-assignment workaround needed. File renamed to
  `event-subscription.interface.ts` to match the repo's naming convention.

  Exports `HandlerEntry<TPayload>` — the shape a handler receives
  (`{ payload, eventType, eventVersion, aggregateId?, correlationId? }`).
  Consumers can type their `handle` parameter explicitly when it helps
  readability, and `EventHandler<TPayload>` + `EventSubscription.handle`
  share this single definition instead of duplicating it inline.

- 74b8f6a: Add `EventSubscription<TPayload>` + bulk wiring on `EventConsumer`
  (`options.subscriptions` and `consumer.subscribe()`) so module factories
  can return `(descriptor, handle)` pairs and the composition root just
  passes the combined array to the consumer.

  `defineEvent` now accepts a [Standard Schema v1](https://standardschema.dev)
  instance (Zod, Valibot, ArkType, etc.) as its second argument. When a
  descriptor carries a schema, `EventConsumer.on` validates
  `entry.payload` before dispatching to the handler — failures mark the
  event `FAILED` immediately (no retries; validation is deterministic) and
  surface the issue summary in the row's `last_error`. `EventDescriptor`'s
  `schema` field is now typed as `StandardSchemaV1<unknown, TPayload>`
  instead of the previous opaque URI string (which was never read).

  Exports `SchemaValidationError` so operators can `instanceof`-check in
  metrics and alerting.

- 45b7c58: Initial runtime surface. Absorbs the deleted `@quilla-be-kit/lifecycle` package and adds:

  - `Runtime` — OS signal + uncaught-error bridge that owns `process.exit`. Takes a startup callback; drives the process from start to drain to exit.
  - `ComponentRegistry<TMeta>` — transport-agnostic registry with contract validation on construction (`{ contracts }`). Bridges to `ShutdownManager` via `toShutdownPhase(name)`.
  - `ShutdownManager`, `Disposable`, shutdown types — moved verbatim from the deleted lifecycle package.

  Messaging re-points `Disposable` import at `@quilla-be-kit/runtime` (no API change).

- 7c86c48: `LoggerConfig.service` identifies the emitting service (microservice,
  backend, worker) on every log entry. Surfaces as a first-class top-level
  field in JSON output and as a `[service]` bracket in pretty output,
  preceding the module label. Propagates through `forMethod` and
  `withMeta` child loggers.

  Pretty format goes from `[module::location]` to
  `[service] [module::location]`.

  Messaging adapters no longer double-stamp their class name on the
  caller-provided logger: `OutboxForwarder` takes the logger as-is, and
  `EventConsumer` places its per-instance `consumerName` into the `meta`
  bucket (via `withMeta`) rather than in the location label — keeping
  `module` cleanly owned by the caller.

### Patch Changes

- Updated dependencies [8c8e6af]
- Updated dependencies [6ce0a43]
- Updated dependencies [f1dfa83]
- Updated dependencies [2bd37fe]
- Updated dependencies [45b7c58]
- Updated dependencies [7c86c48]
- Updated dependencies [7c86c48]
  - @quilla-be-kit/execution-context@0.2.0
  - @quilla-be-kit/errors@0.2.0
  - @quilla-be-kit/observability@0.2.0
  - @quilla-be-kit/runtime@0.2.0
