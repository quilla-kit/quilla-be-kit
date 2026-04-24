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

## Construction patterns

Aggregates are constructed through **two static factory methods**, never directly. The constructor is private — nothing outside the class can `new Role(...)`. The two factories separate flows that both end at a valid aggregate instance but have very different guarantees:

- **`create(props)`** — public factory for *new* aggregates. Business operation. Runs invariant validation, emits creation-time domain events, `id` is auto-minted by `Entity`'s constructor (no id argument).
- **`reconstitute(props, id)`** — public factory for *rehydration from persistence*. Technical operation. No validation (the DB wrote it; invariants already held), no domain events. Always takes the existing `id`.

Neither is enforced by a base class. They're conventions the rest of the toolkit assumes — `BasePersistenceMapper.createDomain(props, id)` calls `reconstitute`; command handlers call `create`. Skipping the split turns into subtle bugs (rehydrated aggregates emitting duplicate creation events; validation re-running against already-valid data and failing on legacy rows that would no longer pass current rules).

```ts
export class Role extends AggregateRoot<RoleProps> {
  // No one outside the class calls `new Role(...)`.
  private constructor(props: RoleProps, id?: string) {
    super(props, id);
  }

  // Business intent: a brand-new Role. Validates, could emit events.
  static create(props: RoleProps): Role {
    const role = new Role(props);
    role.validate();
    // role.addDomainEvent(new RoleCreatedEvent(role.id, { ... }));
    return role;
  }

  // Technical intent: rebuild from a row. No validation, no events.
  static reconstitute(props: RoleProps, id: string): Role {
    return new Role(props, id);
  }

  private validate(): void {
    if (!this.props.name.trim()) {
      throw new Error('Role name cannot be empty');
    }
    if (!this.props.permissions || this.props.permissions.length === 0) {
      throw new Error('Role must have at least one permission');
    }
  }
}
```

### Why `reconstitute` skips validation

The DB wrote the aggregate successfully at some point in the past, which means invariants held *at that time*. Running `create`'s validation on every `reconstitute` call breaks in two ways:

1. **Legacy rows.** Rules evolve. A `Role` written when the "at least one permission" rule didn't yet exist can still be a legitimate row the system needs to load, update, and migrate. Rehydration has to succeed; only newly-created aggregates need to meet current rules.
2. **Round-trip cost.** Rehydration happens on every read. Structural invariants (non-empty strings, non-null fields) are already enforced by the setters the mapper fires during reconstruction — that's enough for rehydration. Business invariants (permission-count, status combinations) belong in `validate`, which runs on creation only.

### `create` often trims or expands the input type

New-aggregate flows usually don't accept every field on `TProps` from the caller — some fields are derived or fixed at creation:

```ts
static create(
  props: Omit<UserProps, 'activationToken' | 'status' | 'password' | 'securityStamp'>,
): User {
  const newUserProps: UserProps = {
    ...props,
    activationToken: crypto.randomUUID(),
    activationTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    password: Password.none(),
    status: UserStatus.PROVISIONED,
    // ...
  };
  return new User(newUserProps);
}
```

`reconstitute` always takes the full `TProps` — the DB has all the fields already.

### Naming — use these two names

The toolkit's conventions (`BasePersistenceMapper.createDomain` calling `reconstitute`, command handlers calling `create`) assume these exact names. Variants (`rebuild`, `fromRow`, `restore`, `make`, `of`) technically work but break the conventions and make cross-module code grep less useful. Pick these two and stay consistent.

## Mutation patterns

Aggregates have two complementary shapes of mutation, and rich aggregates use both in the same class. Neither is enforced by a base class — they're conventions. The toolkit provides `AggregateRoot<TProps>` with private props, private setters, and `addDomainEvent`; the patterns below are how to use those primitives well.

### Pattern A: domain methods — one method per business intent

Use these for operations that have **semantic weight**: status transitions, side effects, domain events, or multi-field invariants. Name them after the business intent (`activate`, `cancel`, `markShipped`), not the state change (`setStatus`).

```ts
class User extends AggregateRoot<UserProps> {
  activate(password: Password): void {
    if (this.status === UserStatus.ACTIVATED) return;   // idempotent

    this.status = UserStatus.ACTIVATED;
    this.activationToken = null;
    this.activationTokenExpiresAt = null;
    this.setPasswordInternally(password);

    this.addDomainEvent(
      new UserActivatedEvent(this.id, { email: this.email, firstName: this.firstName }),
    );
  }

  requestPasswordReset(ttl: number): void {
    if (this.status !== UserStatus.ACTIVATED) throw new UserAccountNotActive();

    this.resetPasswordToken = crypto.randomUUID();
    this.resetPasswordTokenExpiresAt = new Date(Date.now() + ttl);
    this.rotateSecurityStamp();

    this.addDomainEvent(new PasswordResetTokenGeneratedEvent(/* ... */));
  }

  // Compose — higher-level intents delegate to lower-level ones:
  completePasswordReset(newPassword: Password): void {
    this.resetPasswordToken = null;
    this.resetPasswordTokenExpiresAt = null;
    this.changePassword(newPassword);   // reuses existing intent
  }
}
```

What each method earns:
- **A name for the intent** — the command handler reads as `user.activate(password)`, not `user.update({ status: 'ACTIVATED', ... })`.
- **Its own preconditions** — `requestPasswordReset` throws if the user isn't activated; `activate` short-circuits if already activated.
- **Its own event(s)** — subscribers can react to `UserActivated` without fishing through a generic `UserUpdated` payload.

### Pattern B: `updateFromInput` — single entry point for CRUD-shaped updates

Some updates are genuinely a batch of unrelated field edits (rename, update contact info, toggle a flag) where the *combination* is the user intent, not any individual change. For those, a single `updateFromInput(input)` public method that orchestrates private per-field `changeX` methods is the right shape.

```ts
class Role extends AggregateRoot<RoleProps> {
  updateFromInput(input: {
    name: string;
    description?: string;
    permissions: Permission[];
    isActive: boolean;
    updatedAt: Date;
  }): void {
    this.changeName(input.name);
    this.changeDescription(input.description);
    this.replacePermissions(input.permissions);
    this.changeActive(input.isActive);
    this.changeUpdatedAt(input.updatedAt);
  }

  private changeName(newName: string): void {
    if (newName === this.props.name) return;              // no-op short-circuit
    if (!newName.trim()) throw new Error('Role name cannot be empty');
    this.props.name = newName;
  }

  private changeDescription(newDescription?: string): void {
    if (newDescription === this.props.description) return;
    this.props.description = newDescription ?? '';
  }

  private replacePermissions(newPermissions: Permission[]): void {
    if (!newPermissions || newPermissions.length === 0) {
      throw new Error('Role must have at least one permission');
    }
    this.props.permissions = newPermissions;
  }
}
```

Two load-bearing conventions:

1. **Each `changeX` is private and short-circuits on identity writes.** `if (newValue === current) return;` before any mutation. This matters because otherwise `updatedAt` ticks on every call — even for no-op PUTs where nothing actually changed, command handlers spray "touched this row" updates, audit trails fill with noise, and optimistic-lock conflicts erupt on genuinely concurrent but semantically-disjoint edits.
2. **`updateFromInput` takes `updatedAt` as a caller-supplied parameter.** The command handler mints one `new Date()` and passes it — so all fields touched by the same request share a single timestamp. Don't let individual `changeX` methods each stamp their own.

### Combining both in one aggregate

Real aggregates use both. [User](https://github.com/quilla-kit/quilla-kit) exposes `activate`, `changePassword`, `requestPasswordReset` (domain methods — each with its own events and invariants) alongside `updateFromInput(firstName, lastName, email, phoneNumber, roles, isActive, updatedAt)` for the "edit profile" case.

The split tracks this question: **does this change have its own domain event subscribers care about?** If yes → domain method. If no → fold it into `updateFromInput` as a `changeX`.

### Setter discipline

Whatever pattern you use, setters stay **private**. Every mutation entry point (domain method or `changeX`) is either public (on the intent) or private (on the sub-step). External code mutates through the named API; nothing ever does `user.status = 'ACTIVATED'` directly.

The setters themselves are where **structural invariants** live — the invariants that must hold after rehydration from the DB too, not just after a command:

```ts
private set name(value: string) {
  if (!value || value.trim().length === 0) {
    throw new Error('Role name cannot be empty');
  }
  this.props.name = value;
}
```

Mutation methods enforce **business invariants** (status transitions, permission counts, etc.). Setters enforce **structural invariants** (non-empty strings, non-null required fields). Both paths — command-side mutation and mapper-side rehydration — flow through the same setters, so both paths get the same structural guards for free.

## Install

```sh
pnpm add @quilla-kit/ddd
```
