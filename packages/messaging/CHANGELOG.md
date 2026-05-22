# @quilla-be-kit/messaging

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
