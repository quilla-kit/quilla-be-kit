# @quilla-be-kit/http

## 0.5.0

### Minor Changes

- 4155cc3: Add API versioning to route composition.

  A version segment can now be declared at three levels and is inserted
  **resource-first** into the composed path, so each module stays a clean future
  service boundary:

  ```
  [module prefix] + [effective version] + [registration prefix] + [@Controller prefix] + [@Route path]
  ```

  The effective version resolves `route option ?? @Controller version ?? HttpModuleMeta.version ?? ''`:

  - `HttpModuleMeta.version?` — module-wide default.
  - `@Controller(prefix, { version })` — controller-level default.
  - `@Get('/x', { version })` (and every other method + `*Public` decorator via the
    new optional `RouteOptions` argument) — per-route override.

  Version lives on the method/controller decorators rather than a standalone
  decorator because it is a pure path-composition fact (like `path` and the
  `*Public` flag), with no runtime behavior — keeping it orthogonal to
  `@AuthorizeScope` / `@ValidateRequest`.

  Purely additive: when no version is set anywhere, composed paths are
  byte-identical to before. Version segments go through the existing
  leading-slash / no-trailing-slash normalization, and specificity sorting plus
  duplicate-route detection run on the composed path unchanged.

## 0.4.0

### Minor Changes

- 42a9ec0: Add `cors` option to `HonoServer` for built-in CORS support. Pass `cors: { origins: string[] }` and `HonoServer` registers Hono's built-in `cors()` middleware before routes so both preflight `OPTIONS` requests and actual cross-origin requests are handled automatically. Requests from unlisted origins receive no CORS headers; requests without an `Origin` header are unaffected. No additional dependency — `hono/cors` ships with Hono.

## 0.3.1

### Patch Changes

- 77153bc: Document `HttpRequest.getFile(name)` and `getFormFields()` for multipart/form-data handling. Both methods existed in the interface and Hono adapter but had no README coverage — consumers doing file uploads had no documented path.
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
- Updated dependencies [77153bc]
  - @quilla-be-kit/execution-context@0.2.2
  - @quilla-be-kit/observability@0.2.2
  - @quilla-be-kit/runtime@0.2.2

## 0.3.0

### Minor Changes

- aec0823: feat(http): binary and stream responses

  `HttpResponse` becomes a discriminated union: `HttpJsonResponse |
HttpBinaryResponse | HttpStreamResponse`. JSON handlers keep the existing
  shape (`{ httpCode, payload, error?, metadata?, headers? }`) and continue
  to be wrapped in the standard envelope. Binary handlers return
  `{ httpCode, data: Uint8Array, headers? }`; stream handlers return
  `{ httpCode, stream: ReadableStream<Uint8Array>, headers? }`. The adapter
  discriminates by field presence (`'stream' in r` / `'data' in r`) and
  writes the bytes/stream directly — no JSON envelope, no `kind` tag to set.

  `content-type` lives in `headers` like every other header — the response
  shape does not invent a separate field for it.

  Tradeoff: binary responses lose the envelope convention. There's no
  `payload` / `metadata` wrapper around the bytes, and middleware can't
  introspect stream contents post-hoc. Errors thrown before the response
  starts still go through `resolveHttpError` and emit a normal JSON error;
  errors thrown mid-stream abort the connection.

  Existing handlers returning `{ httpCode, payload }` still satisfy
  `HttpJsonResponse` and therefore `HttpResponse` — no breaking change.
  `ResolvedHttpError.body` is narrowed from `Omit<HttpResponse, 'httpCode'>`
  to `Omit<HttpJsonResponse, 'httpCode'>`; error envelopes are always JSON.

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

- 8c8e6af: **Breaking (pre-1.0):** consolidate `scopeId` and `userId` on
  `ExecutionContext` into a single optional `session: AuthSession`.

  The previous shape (`scopeId?`, `userId?` as top-level optionals on
  `ExecutionContext`) encoded two correlated fields as if they were
  orthogonal. In practice they share a lifecycle — both defined once auth
  middleware runs, both undefined for anonymous / system / job contexts,
  never half-populated in well-formed code. The type didn't enforce that.

  New shape:

  ```ts
  // @quilla-be-kit/execution-context
  export type AuthSession = {
    readonly scopeId: string;
    readonly userId: string;
  };

  export type ExecutionContext = {
    readonly actorType: ActorType;
    readonly correlationId: string;
    readonly session?: AuthSession; // present iff authenticated
  };
  ```

  `AuthSession` is extensible by intersection — same pattern as before for
  consumer-specific session data (roles, session id, etc.), but now anchored
  on a canonical base. `actorType` stays at the top level: `'system'` and
  `'job'` are meaningful with no session, and `actorType` classifies the
  broader context whether or not there's a session.

  **Affected toolkit surfaces (all updated):**

  - `@quilla-be-kit/execution-context` — `ExecutionContext.session?`,
    `AuthSession` exported type, `createFromEventMetadata` reconstructs the
    session from flat `EventMetadata.scopeId` / `userId` (metadata stays
    flat on the wire), `ExecutionContextEnricher` flattens `session` into
    top-level `scopeId` / `userId` log fields so log output shape is
    unchanged.
  - `@quilla-be-kit/persistence` — `BaseWriteDao` reads audit from
    `ctx.session?.userId`. System contexts with no session persist `null`
    audit.
  - `@quilla-be-kit/http` — `@ValidateRequest` reads auth from
    `ctx.session?.{scopeId,userId}`. Injection requires both a live
    session AND a `describeSchema` impl on the `RequestValidator`.
  - `@quilla-be-kit/security` — `authenticatedSessionMiddleware` now enriches
    the context with `session: { scopeId, userId }` instead of flat
    top-level fields.

  **`EventMetadata` is unchanged on the wire.** Flat `scopeId?` / `userId?`
  fields stay — they're a serialization format, and flattening is the right
  shape for JSON-persisted outbox rows. The conversion to/from session
  happens at the `createFromEventMetadata` boundary.

  **Log output is unchanged.** `ExecutionContextEnricher` flattens
  `session` to top-level `scopeId` / `userId` on every log entry, so
  dashboards and log queries keep their existing field names.

  **Consumer migration** — mechanical find-and-replace:

  - `ctx.scopeId` / `ctx.userId` → `ctx.session?.scopeId` /
    `ctx.session?.userId`
  - When constructing contexts in middleware / tests, nest scopeId & userId
    under `session: { scopeId, userId }` instead of placing them at the top.
  - Consumer extensions move from `ExecutionContext & { session?: MySession }`
    where MySession was free-form to
    `AuthSession & { ...extras }` with `ExecutionContext & { session?: AppAuthSession }`.

- ba7e94d: `@ValidateRequest` now injects `scopeId` and `userId` from the active
  `ExecutionContext` **only when the schema declares those keys**. The
  previous unconditional injection wrote the fields into every validated
  payload regardless of schema shape — which worked by accident for
  tolerant schemas (Zod silently stripped the extras) and broke strict
  schemas outright (unknown keys rejected). Worse, it conflated "what
  the schema represents" with "what the server happens to add on top,"
  making the decorator's contract ambiguous.

  New behavior:

  - `RequestValidator` gains an optional `describeSchema(schema)` method
    returning `{ keys }` or `null`. When implemented, `@ValidateRequest`
    reads the top-level key list and injects only declared auth-derived
    fields.
  - When `describeSchema` is absent or returns `null`, auth-injection is
    **skipped** — fail-safe: no surprise fields written into schemas that
    didn't ask for them.

  **Consumer impact:**

  Consumers with command DTOs that declare `scopeId` / `userId` and rely
  on auto-injection now need to add `describeSchema` to their
  `RequestValidator` wrapper (a 3–5 line addition for Zod; see the
  updated README). Without it, command DTOs land with `scopeId: undefined`
  at the handler — a loud failure rather than a silent miss, which is
  the intent.

  Consumers whose schemas don't declare `scopeId` / `userId` see no
  behavior change (injection was always a silent no-op for them, and
  now is explicitly so).

  The updated Zod adapter in the README handles `ZodObject` (direct key
  enumeration) and unwraps `ZodPipe` (produced by `.transform(...)`)
  until it reaches a `ZodObject` — so schemas produced by
  `createQueryParametersSchema` (a transform over an object) are
  introspected correctly and auth-derived extras are injected when
  declared via the new `extraFields` option in
  `@quilla-be-kit/persistence/query-schema`.

  **New: out-of-the-box Zod adapter.** `@quilla-be-kit/http/validator/zod`
  exports `createZodRequestValidator({ extractIssues? })` — a drop-in
  `RequestValidator` implementation for Zod 4 with the `ZodPipe` unwrap
  logic baked in. Avoids every consumer re-writing the same ~15 lines,
  and guarantees the unwrap chain matches what
  `createQueryParametersSchema` emits. `zod` is an optional peer dep of
  `@quilla-be-kit/http` — required only when importing from the
  `/validator/zod` sub-path.

- 0614b24: Initial HTTP surface. Ships framework-agnostic types, decorators, router, and a Hono adapter.

  - **Decorators** — `@Controller`, `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete` + `*Public` variants, `@AuthorizeScope` (scope-based auth against `AuthenticatedToken`), `@ValidateRequest` (library-agnostic schema validation via injected `RequestValidator`).
  - **Router** — walks decorated controllers, composes prefixes (module + registration + controller + route), sorts by specificity, throws on duplicates. Bridges to `@quilla-be-kit/runtime`'s `ComponentRegistry<HttpModuleMeta>` for modular-monolith composition. Owns the full middleware chain composition: each `NormalizedRoute` carries a `middlewareChain` with the complete ordered pipeline `[system? → globals → (public ? [] : auth) → module → registration]`. Adapters iterate and wrap; they don't re-compose ordering, so future adapters (Express/Fastify) can't drift.
  - **System-owned execution-context bootstrap (optional).** `RouterOptions.executionContext: { provider, correlationIdHeader? }` installs an internal middleware that runs before any consumer middleware on every route. When omitted, the bootstrap is skipped (for pure-public services that never read context). Router throws at construction if `authMiddlewares` is set without `executionContext` — the known-static dependency is caught at startup. `HttpRequest.getExecutionContext()` throws a clear error if called without a wired provider.
  - **Typed auth middleware stack.** `RouterOptions.authMiddlewares: AuthMiddlewareStack` has shape `{ tokenVerification, sessionLoad? }`. Router runs phases in fixed order regardless of key declaration — phase misordering is a type error, not a runtime bug. Populated by `@quilla-be-kit/security`'s middleware factories.
  - **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes` constants.
  - **Validator contract** — `RequestValidator` returns `{ success, data }` | `{ success, error: unknown[] }`; library throws `ValidationError` on failure with `context.issues` preserved.
  - **Hono adapter** sub-path (`@quilla-be-kit/http/adapter/hono`) — `HonoServer implements WebServer`; reads the execution-context provider from the Router it wraps. Takes a `serve` callback so consumers pick their Node runtime (`@hono/node-server`, Bun, Deno, test stubs). `hono` pinned to `4.x.x` as optional peer dep. `HttpRequest` is cached on the Hono `Context` so middleware chains reuse a single wrapper per request.
  - **`MiddlewareAdapter.wrap(mw)`** — single-method contract. Adapters implement one hook; Router decides where each wrapped middleware plugs in.
  - **Internal error resolver** — `resolveHttpError` maps QuillaError subclasses to HTTP codes (400/401/403/404/409/502/500). Used by the Hono adapter's `onError` hook; not exposed to consumers.

  Stage-3 decorators require a `Symbol.metadata` well-known symbol; since Node 22 doesn't expose it natively, the package installs a shared identity (`Symbol.for('Symbol.metadata')`) at module load. `sideEffects` field narrows this to the single polyfill file so bundlers don't over-prune.

- ee7f1dc: Add `TokenClaims` (security) and rename `scope` → `scopes` on token-shaped types.

  **`TokenClaims` — canonical short-key wire-format type for JWT payloads.**
  `SignTokenPayload` and `Token` keep their readable developer-facing
  fields (`userId`, `scopeId`, `securityStamp`, `scopes`). `TokenClaims`
  gives `TokenService` implementers a typed target for the compact
  on-the-wire shape:

  ```ts
  type TokenClaims = {
    readonly u: string; // userId
    readonly si: string; // scopeId
    readonly st: string; // securityStamp
    readonly s?: readonly string[]; // scopes
  };
  ```

  Short keys exist for **payload size**, not security — JWTs travel in
  every authenticated request header, so claim names are a real
  bandwidth cost. Renaming developer-facing fields would not have helped
  (JWTs are signed, not encrypted, and the type definitions are public
  in OSS), so the split keeps ergonomics readable while making the wire
  contract explicit. Implementers map between the two at the sign/parse
  boundary — see the package README for a `jose` example.

  **Breaking (pre-1.0): `scope` → `scopes` on token-shaped types.** The
  field is a list, so the plural form matches the shape. Affects:

  - `@quilla-be-kit/http` — `AuthenticatedToken.scope?` → `scopes?`,
    `RouteDefinition.scope?` → `scopes?` (the `@AuthorizeScope` decorator
    name is unchanged — it describes the action; only the underlying
    field is plural).
  - `@quilla-be-kit/security` — `SignTokenPayload.scope?` → `scopes?`,
    `Token.scopes?` (inherited from `AuthenticatedToken`).

  `TokenClaims.s?` (the wire short key) is unchanged.

  **Consumer migration** — mechanical:

  - `token.scope` → `token.scopes`
  - `payload.scope` → `payload.scopes` when constructing a
    `SignTokenPayload`
  - Route metadata readers: `route.scope` → `route.scopes`

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
