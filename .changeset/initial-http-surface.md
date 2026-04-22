---
"@quilla-kit/http": minor
---

Initial HTTP surface. Ships framework-agnostic types, decorators, router, and a Hono adapter.

- **Decorators** — `@Controller`, `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` + `*Public` variants, `@AuthorizeScope` (scope-based auth against `AuthenticatedToken`), `@ValidateRequest` (library-agnostic schema validation via injected `RequestValidator`).
- **Router** — walks decorated controllers, composes prefixes (module + registration + controller + route), sorts by specificity, throws on duplicates. Bridges to `@quilla-kit/runtime`'s `ComponentRegistry<HttpModuleMeta>` for modular-monolith composition.
- **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes` constants.
- **Validator contract** — `RequestValidator` returns `{ success, data }` | `{ success, error: unknown[] }`; library throws `ValidationError` on failure with `context.issues` preserved.
- **`executionContextMiddleware`** — parses correlation-id header, creates baseline `ExecutionContext`, runs downstream in its scope.
- **Hono adapter** sub-path (`@quilla-kit/http/adapter/hono`) — `HonoServer implements WebServer`; takes a `serve` callback so consumers pick their Node runtime (`@hono/node-server`, Bun, Deno, test stubs). `hono` pinned to `4.x.x` as optional peer dep.
- **Internal error resolver** — `resolveHttpError` maps QuillaError subclasses to HTTP codes (400/401/403/404/409/502/500). Used by the Hono adapter's `onError` hook; not exposed to consumers.

Stage-3 decorators require a `Symbol.metadata` well-known symbol; since Node 22 doesn't expose it natively, the package installs a shared identity (`Symbol.for('Symbol.metadata')`) at module load. `sideEffects` field narrows this to the single polyfill file so bundlers don't over-prune.
