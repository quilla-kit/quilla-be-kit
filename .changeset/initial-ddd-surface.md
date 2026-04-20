---
"@quilla-kit/ddd": minor
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

Also reflected in this change: the root README and
`@quilla-kit/persistence` / `@quilla-kit/execution-context` READMEs now talk
about `scopeId` and `CrossScopeAccessError` instead of `tenantId` and
`CrossTenantAccessError`.
