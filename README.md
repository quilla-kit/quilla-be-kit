# quilla-kit

A composable TypeScript toolkit for building substrate-grade backend services:
DDD primitives, execution context, structured observability, HTTP abstractions,
persistence primitives with Unit-of-Work and outbox, messaging infrastructure,
graceful lifecycle, and runtime composition.

## Name

*Quilla* is Spanish for *keel* — the structural backbone a ship is built
around. Every other timber attaches to it. That's the role this toolkit plays
in a service: the load-bearing spine the rest of the code is fastened to.

**Status:** pre-1.0. APIs are allowed to break on minor bumps.

## Packages

All packages are published under the `@quilla-kit/*` scope on npm, MIT-licensed,
ESM-only, and target Node 22+.

| Package | Purpose |
| --- | --- |
| [`@quilla-kit/ddd`](packages/ddd) | DDD tactical primitives — `AggregateRoot`, `Entity`, `DomainEvent`, `IntegrationEvent`, `EventMetadata`, `ActorType` |
| [`@quilla-kit/observability`](packages/observability) | `Logger`, `StructuredLogger`, `NoopLogger`, formatters, enrichers |
| [`@quilla-kit/execution-context`](packages/execution-context) | `ExecutionContext`, `ExecutionContextProvider`, AsyncLocalStorage storage |
| [`@quilla-kit/http`](packages/http) | `HttpRequest`, `WebServer`, `@Controller`, `@Get`/`@Post`/..., `@AuthorizeScope`, `@ValidateRequest`, framework-agnostic `Router`, Hono adapter sub-path |
| [`@quilla-kit/persistence`](packages/persistence) | `UnitOfWork`, base DAOs, base repositories, outbox pattern |
| [`@quilla-kit/messaging`](packages/messaging) | Messaging infrastructure — `EventBus`, `EventConsumer`, `LocalOutbox`, `OutboxForwarder` |
| [`@quilla-kit/runtime`](packages/runtime) | `ShutdownManager`, `Runtime` (OS signal / uncaught-error bridge), `ComponentRegistry` |
| [`@quilla-kit/jobs`](packages/jobs) | `BackgroundJob`, `JobRunner`, `InProcessJobRunner` — scheduled jobs with per-tick system `ExecutionContext` and `Disposable` shutdown |
| [`@quilla-kit/security`](packages/security) | JWT, password hashing, authorization decorators, identity materialization — primitives, not a drop-in auth module. Also the toolkit's rule-of-three validation harness |

Mature transport and storage adapters (Postgres, Hono) ship as sub-paths of their
interface packages (`@quilla-kit/persistence/postgres`, `@quilla-kit/messaging/postgres`,
`@quilla-kit/http/adapter/hono`) with optional peer deps. The interface packages
stay agnostic; consumers opt into concrete adapters by importing from the sub-path.

## Architectural invariants

These rules are design-time contracts for quilla-kit. They are enforced at the
package boundary (interface vs. adapter split) and documented in package READMEs.

1. **Scope isolation is repo-layer explicit.** Repositories accept `scopeId` as a
   parameter and raise `CrossScopeAccessError` on mismatch. DAOs never inject
   `scope_id` implicitly. Consumers choose what `scopeId` represents (tenant,
   workspace, organization, project, etc.).
2. **Audit fields are DAO-layer implicit.** `inserted_by` and `updated_by` are
   resolved from `IExecutionContextProvider`; callers never pass them.
3. **Outbox iff UoW iff durable domain state.** The outbox entry is committed in
   the same transaction as the aggregate write, or not at all.
4. **No governance leakage.** The toolkit does not encode AI-containment rules,
   modulith topology, projection policies, or Hard Invariants. Those belong to
   consumer projects.
5. **Interface vs. adapter split is non-negotiable.** Interface packages have
   zero runtime dependencies.

## Development

```sh
pnpm install
pnpm build       # tsc -b across the workspace (typecheck + emit for src/)
pnpm typecheck   # typecheck tests/ against src/
pnpm test        # vitest
pnpm lint        # biome check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow, including changesets.

## License

[MIT](LICENSE)
