# @quilla-kit/ddd

Domain-Driven Design tactical primitives — the shared vocabulary that every
other `@quilla-kit/*` package uses to talk about domain objects and the events
and actors they produce.

Zero runtime dependencies. Sits at the bottom of the toolkit's dependency
graph; imported by `execution-context`, `persistence`, `messaging`, and
`security`.

## Public surface

### Identity

- **`Entity<TProps>`** — props-based base class. `id` auto-generates via
  `node:crypto.randomUUID()` when not supplied to the constructor — so
  `new User({ email })` yields an entity with a valid id without the
  caller minting one. `equals(other)` compares by id (not structural
  equality); `createdAt` / `updatedAt` / `insertedBy` / `updatedBy` are
  exposed from props.
- **`AggregateRoot<TProps>`** — `Entity` + a private domain-event buffer.
  Call the protected `addDomainEvent(event)` from within the aggregate to
  stage events during state changes; the public `drainDomainEvents()`
  returns and clears the buffer (typically called by `UnitOfWork` before
  commit). Override `drainDomainEvents` to chain in child aggregates'
  events.
- **`EntityId`**, **`BaseEntityProps`** — supporting types.

### Events

- **`DomainEvent<TPayload>`** — id, `aggregateId`, `occurredAt`, payload, and
  a `name` getter defaulting to `constructor.name`. `id` auto-generates via
  `randomUUID()` and `occurredAt` defaults to `new Date()` when not supplied,
  so aggregates emit events with just `{ aggregateId, payload }`. `toJSON()`
  for outbox persistence.
- **`IntegrationEvent<TPayload>`** — id, `occurredAt`, payload, and the same
  `name` + `toJSON` shape. Same auto-defaults for `id` and `occurredAt` as
  `DomainEvent`. No `aggregateId` — integration events cross aggregate
  boundaries.
- **`EnvelopedEvent<TEvent>`** — a `{ event, metadata }` pair, produced when
  `UnitOfWork` drains aggregate events and stamps each with a shared
  `EventMetadata` (correlation id, actor, scope) before handing them to the
  outbox. Consumers rarely construct these directly.
- **`AnyEvent`** — `DomainEvent | IntegrationEvent`.

### Metadata and actor

- **`EventMetadata`** — `kind`, `correlationId`, `actorType`, optional
  `scopeId` / `userId`, `createdAt`. Construct via `EventMetadata.create(...)`.
- **`EventKind`** — enum (`DOMAIN`, `INTEGRATION`).
- **`ActorType`** — `'user' | 'system' | 'service' | 'anonymous' | 'job' | (string & {})`.

## Design decisions

- **Props-based `Entity`**, not field-based. Easier rehydration; consumers
  extend props without subclassing.
- **Audit fields on every `Entity`.** `insertedBy` / `updatedBy` /
  `createdAt` / `updatedAt` are part of `BaseEntityProps` — substrate-grade
  services audit universally.
- **`scopeId` instead of `tenantId`.** Naming-agnostic isolation key;
  consumers decide whether it's a tenant, workspace, organization, or project.
- **`toJSON` only; no `fromJSON`.** Deserialization is consumer-owned (they
  know their event types) — keeps this package dep-free and registry-free.
- **No extensions bag on `EventMetadata`.** Strict, minimal shape. Consumers
  who need extra metadata subclass.
- **`drainDomainEvents`** — unambiguously destructive (returns all and
  clears). Override in aggregates with child aggregates.

## Install

```sh
pnpm add @quilla-kit/ddd
```
