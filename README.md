# quilla-kit

**A TypeScript toolkit for building production backend services with explicit domain logic, principled persistence and messaging, and zero framework lock-in.**

*Quilla* is Spanish for *keel* — the structural backbone a ship is built around. Every other timber attaches to it. That's the role this toolkit plays in a service: the load-bearing spine the rest of the code is fastened to.

**Status:** pre-1.0. APIs are allowed to break on minor bumps. Independent versioning per package — adapters evolve out-of-lockstep with interfaces.

---

## Why quilla-kit

- **Extracted from real production code**, not invented at a framework-design whiteboard. Every primitive earned its seat by repeatedly appearing across production services before being lifted into reusable packages.
- **Interface/adapter split is non-negotiable.** Interface packages have zero external runtime deps. Concrete drivers (Postgres, Hono) live under sub-path exports and opt-in as peer deps. You own your persistence, your HTTP transport, your auth.
- **Scope isolation is first-class.** Multi-tenancy, workspaces, orgs — the toolkit carries `scopeId` through repositories, event metadata, and execution context without ever renaming it. Consumers decide what "scope" means in their domain.
- **DDD vocabulary without framework ceremony.** `AggregateRoot`, `UnitOfWork`, `DomainEvent`, `EventMetadata` — minimal, strict, and composable. No decorators to learn that aren't load-bearing.
- **Substrate, not scaffold.** There's no CLI, no code generation, no "magic container." Composition roots are hand-wired TypeScript. Refactors stay honest.

## Who this is for

Senior backend engineers building production Node services — especially multi-tenant, event-driven, or DDD-aligned — who want to own their architecture without inheriting a framework's opinions on everything from auth to caching.

If you've built on NestJS and wished it stopped a layer earlier, or hand-rolled your own Unit-of-Work / outbox / logger abstraction because the opinions in available frameworks didn't fit, quilla-kit is the shape you're probably already converging on.

## 30-second example

A command handler that emits a domain event, atomically commits aggregate state + outbox row, and gets processed by a consumer — with correlation id flowing through every hop:

```ts
// HTTP boundary: UserController.register() (decorated; omitted for brevity)
// wired via @quilla-kit/http + @quilla-kit/security

await uow.transaction(async (ctx) => {
  const user = User.create({ email, passwordHash });   // emits UserCreated domain event
  await userRepo.save(user, ctx);
  // Aggregate row + outbox_events row commit in the SAME transaction.
});

// Background: OutboxForwarder drains PENDING outbox rows, publishes to EventBus.

// Another module: consumer handles UserCreated with reconstructed ExecutionContext.
export class OnUserCreatedHandler implements EventSubscription<UserCreatedPayload> {
  readonly descriptor = UserCreatedEvent;
  constructor(private readonly logger: Logger) {}

  async handle(entry: HandlerEntry<UserCreatedPayload>): Promise<void> {
    const log = this.logger.forMethod('onUserCreated').withMeta({
      subjectUserId: entry.payload.userId,
      subjectScopeId: entry.payload.tenantId,
    });
    log.info('user created event');
    // Handler runs inside runWithContext() — the correlationId from the
    // originating HTTP request is the same one logged here.
  }
}
```

End-to-end observability, atomic durability, per-aggregate ordering, graceful shutdown — wired from primitives, not inherited from a framework.

## How the packages fit together

Think of quilla-kit as five concentric layers. You reach for the inner layers first.

**Foundation — the vocabulary**
- [`@quilla-kit/ddd`](packages/ddd) — `AggregateRoot`, `Entity`, `DomainEvent`, `EventMetadata`, `ActorType`
- [`@quilla-kit/errors`](packages/errors) — `QuillaError` base + category classes with cross-realm-safe classification
- [`@quilla-kit/execution-context`](packages/execution-context) — AsyncLocalStorage-backed context carrying `scopeId`, `userId`, `actorType`, `correlationId`

**Runtime — process lifecycle**
- [`@quilla-kit/runtime`](packages/runtime) — `Runtime` (signal trap), `ShutdownManager` (phased teardown), `ComponentRegistry`
- [`@quilla-kit/jobs`](packages/jobs) — `BackgroundJob`, `InProcessJobRunner` with per-tick system `ExecutionContext`

**HTTP tier — adapter-agnostic**
- [`@quilla-kit/http`](packages/http) — decorated controllers, specificity-sorted router, Hono adapter under `/adapter/hono`
- [`@quilla-kit/security`](packages/security) — `TokenService` / `SessionStore` / `PasswordHasher` interfaces plus composable `bearerTokenMiddleware` and `authenticatedSessionMiddleware`

**Durability — where your invariants live**
- [`@quilla-kit/persistence`](packages/persistence) — `UnitOfWork`, `BaseWriteDao`/`BaseReadDao` (CQRS-isolated), scoped repositories, `BasePersistenceMapper` with prototype reflection
- [`@quilla-kit/messaging`](packages/messaging) — atomic-claim outbox + worker-queue event bus, Standard Schema v1 payload validation, per-aggregate ordering

**Observability — threaded through all of them**
- [`@quilla-kit/observability`](packages/observability) — `Logger` interface, `StructuredLogger` with `service` / `module` / `location` identity, `forMethod` / `withMeta` child loggers, plug-in enrichers, optional PII obfuscation

Concrete adapters ship as sub-path exports of their interface package (`@quilla-kit/persistence/postgres`, `@quilla-kit/messaging/postgres`, `@quilla-kit/http/adapter/hono`) with `pg` / `hono` as optional peer deps.

## Architectural invariants

These are the contracts quilla-kit guarantees to code built on it:

1. **Scope isolation is repo-layer explicit.** Scoped repositories require `scopeId` on every load and raise `CrossScopeAccessError` on mismatch. DAOs never inject `scope_id` implicitly. Consumers choose what `scopeId` represents (tenant, workspace, organization, project, etc.) — the toolkit stays naming-agnostic.
2. **Audit fields are DAO-layer implicit.** `inserted_by` / `updated_by` resolve from `ExecutionContextProvider` on every write. Callers cannot pass them; audit fields in insert inputs get stripped.
3. **Outbox iff UnitOfWork iff durable domain state.** Outbox entries commit in the same transaction as aggregate writes — no partial failure modes between "state changed" and "event emitted."
4. **No governance leakage.** The toolkit does not encode AI-containment rules, modulith topology, projection policies, or domain-specific invariants. Those belong in consumer projects.
5. **Interface vs. adapter split is non-negotiable.** Interface packages have zero external runtime dependencies. Platform built-ins (`node:crypto`) are fine; transport/storage drivers belong in consumer projects or sub-path exports.

## Adopting the toolkit: build a shell

quilla-kit is deliberately naming-agnostic. `scopeId` is the generic axis; your app decides whether it's a tenant, workspace, organization, or project. To keep the generic vocabulary from leaking through your domain code, wrap the toolkit at a single **shell layer** — typically `src/infrastructure/shell/`, app-owned, one file per concern, usually a few dozen lines total.

A shell does four small jobs:

**1. Brand the scope.** Define a nominal type so the compiler rejects raw strings at the boundary:

```ts
declare const TenantIdBrand: unique symbol;
export type TenantId = string & { readonly [TenantIdBrand]: true };

export const TenantId = {
  from(value: string): TenantId {
    if (value.length === 0) throw new Error('TenantId cannot be empty');
    return value as TenantId;
  },
};
```

**2. Rename the verbs.** Extend the toolkit's scoped repository base and re-expose its methods under your domain vocabulary. Pure pass-through — no new logic:

```ts
export abstract class BaseTenantScopedRepository<
  TAggregate extends AggregateRoot<object> & { id: string },
  TRow extends { id: string; scope_id: string },
> extends BaseScopedAggregateRepository<TAggregate, TRow> {
  async loadByIdAndTenantOrFail(id: string, tenantId: TenantId): Promise<TAggregate> {
    try {
      return await this.loadByIdAndScopeOrFail(id, tenantId);
    } catch (err) {
      if (err instanceof CrossScopeAccessError) throw CrossTenantAccessError.fromScopeError(err);
      throw err;
    }
  }
}
```

**3. Rewrap errors at the boundary.** Translate `CrossScopeAccessError` into your domain-shaped error (same `NotFoundError` parent, domain `code` and `context`) inside the shell base — so application code never imports toolkit error types directly.

**4. Fix the column map once.** In your shell mapper, inject `{ tenantId: 'scope_id' }` as a shared override so aggregate mappers don't repeat it per-class.

After this, domain code imports `TenantId`, `BaseTenantScopedRepository`, `CrossTenantAccessError` — and nothing from `@quilla-kit/persistence` directly. When the toolkit evolves its generic vocabulary, only the shell moves.

The same pattern applies outside persistence: rename middleware helpers in your HTTP shell, alias `EventSubscription` verbs in your messaging shell, wrap `Logger` factories to bake in your service identity. The shell is cross-package discipline, not a persistence-only idea.

## Install

All packages are published under `@quilla-kit/*` on npm, MIT-licensed, ESM-only, Node 22+.

```sh
# Foundation + runtime
pnpm add @quilla-kit/ddd @quilla-kit/errors @quilla-kit/execution-context @quilla-kit/runtime

# HTTP service
pnpm add @quilla-kit/http @quilla-kit/security hono @hono/node-server

# Durability
pnpm add @quilla-kit/persistence @quilla-kit/messaging pg

# Observability
pnpm add @quilla-kit/observability
```

Every package has its own README with full API, design notes, and examples — start there once you've picked which layers you need.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including the changeset policy.

Quick commands:

```sh
pnpm install
pnpm build       # tsc -b across the workspace
pnpm typecheck   # typecheck tests/ against src/
pnpm test        # vitest
pnpm lint        # biome check
```

## License

[MIT](LICENSE)
