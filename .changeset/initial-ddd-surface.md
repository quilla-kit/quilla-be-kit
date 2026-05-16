---
"@quilla-be-kit/ddd": minor
---

Initial public surface: `Entity`, `AggregateRoot`, `DomainEvent`,
`IntegrationEvent`, `EventMetadata`, `EnvelopedEvent`, plus the `ActorType`
and `EventKind` supporting types.

`Entity` is props-based and audit-field-aware (`createdAt`, `updatedAt`,
`insertedBy`, `updatedBy` are first-class `BaseEntityProps`). `AggregateRoot`
exposes `drainDomainEvents()` — destructive-by-name — with an override pattern
for aggregates composed of child aggregates. Event base classes ship
`toJSON()` only; deserialization is consumer-owned. `EventMetadata` uses
`scopeId` (not `tenantId`) to stay naming-agnostic for consumers that scope
by workspace / organization / project.

`Entity` uses a **setter-driven construction** pattern for persistence-
mapper interop: the constructor iterates `props` and mirrors each property
onto `this` (firing any subclass setter on the prototype chain), so
persistence mappers can discover domain properties via reflection. The
convention: **persisted properties declare both a `private set` and a
`get` accessor on the subclass**; **computed / derived properties declare
`get` only** — the mapper uses this distinction to decide what to write.
`Entity` base supplies `createdAt` / `updatedAt` / `insertedBy` / `updatedBy`
accessors itself, so consumers never redeclare them. Accessor-less
properties fall through to `Object.assign`-style own-property semantics,
preserving backward-compat for simple data classes.

Also reflected in this change: the root README and
`@quilla-be-kit/persistence` / `@quilla-be-kit/execution-context` READMEs now talk
about `scopeId` and `CrossScopeAccessError` instead of `tenantId` and
`CrossTenantAccessError`.
