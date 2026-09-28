# @quilla-be-kit/ddd

## 0.3.0

### Minor Changes

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

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages

## 0.2.0

### Minor Changes

- 5ab4cd4: Initial public surface: `Entity`, `AggregateRoot`, `DomainEvent`,
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
