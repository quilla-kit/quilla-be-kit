---
"@quilla-kit/http": minor
---

Initial HTTP surface. Ships framework-agnostic types, decorators, router, and a Hono adapter.

- **Decorators** — `@Controller`, `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` + `*Public` variants, `@AuthorizeScope` (scope-based auth against `AuthenticatedToken`), `@ValidateRequest` (library-agnostic schema validation via injected `RequestValidator`).
- **Router** — walks decorated controllers, composes prefixes (module + registration + controller + route), sorts by specificity, throws on duplicates. Bridges to `@quilla-kit/runtime`'s `ComponentRegistry<HttpModuleMeta>` for modular-monolith composition. Owns the full middleware chain composition: each `NormalizedRoute` carries a `middlewareChain` with the complete ordered pipeline `[system? → globals → (public ? [] : auth) → module → registration]`. Adapters iterate and wrap; they don't re-compose ordering, so future adapters (Express/Fastify) can't drift.
- **System-owned execution-context bootstrap (optional).** `RouterOptions.executionContext: { provider, correlationIdHeader? }` installs an internal middleware that runs before any consumer middleware on every route. When omitted, the bootstrap is skipped (for pure-public services that never read context). Router throws at construction if `authMiddlewares` is set without `executionContext` — the known-static dependency is caught at startup. `HttpRequest.getExecutionContext()` throws a clear error if called without a wired provider.
- **Typed auth middleware stack.** `RouterOptions.authMiddlewares: AuthMiddlewareStack` has shape `{ tokenVerification, sessionLoad? }`. Router runs phases in fixed order regardless of key declaration — phase misordering is a type error, not a runtime bug. Populated by `@quilla-kit/security`'s middleware factories.
- **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes` constants.
- **Validator contract** — `RequestValidator` returns `{ success, data }` | `{ success, error: unknown[] }`; library throws `ValidationError` on failure with `context.issues` preserved.
- **Hono adapter** sub-path (`@quilla-kit/http/adapter/hono`) — `HonoServer implements WebServer`; reads the execution-context provider from the Router it wraps. Takes a `serve` callback so consumers pick their Node runtime (`@hono/node-server`, Bun, Deno, test stubs). `hono` pinned to `4.x.x` as optional peer dep. `HttpRequest` is cached on the Hono `Context` so middleware chains reuse a single wrapper per request.
- **`MiddlewareAdapter.wrap(mw)`** — single-method contract. Adapters implement one hook; Router decides where each wrapped middleware plugs in.
- **Internal error resolver** — `resolveHttpError` maps QuillaError subclasses to HTTP codes (400/401/403/404/409/502/500). Used by the Hono adapter's `onError` hook; not exposed to consumers.

Stage-3 decorators require a `Symbol.metadata` well-known symbol; since Node 22 doesn't expose it natively, the package installs a shared identity (`Symbol.for('Symbol.metadata')`) at module load. `sideEffects` field narrows this to the single polyfill file so bundlers don't over-prune.
