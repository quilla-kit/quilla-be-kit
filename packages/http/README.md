# @quilla-be-kit/http

Framework-agnostic HTTP layer for a quilla-be-kit service:

- **Controller decorators** — `@Controller`, `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete` + `*Public` variants, `@AuthorizeScope`, `@ValidateRequest`.
- **Router** — walks decorated controller instances, composes prefixes, sorts routes by specificity, bridges to `ComponentRegistry<HttpModuleMeta>` from `@quilla-be-kit/runtime`, and (when `executionContext` is configured) installs a **system-owned execution-context bootstrap** so every handler can rely on `provider.getContext()`.
- **Typed auth middleware stack** — `AuthMiddlewareStack` enforces phase ordering (`tokenVerification` → `sessionLoad?`) so consumers can't misorder security middlewares. Compose it directly from `@quilla-be-kit/security`'s middleware factories.
- **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes`.
- **Validator contract** — `RequestValidator` interface; wire Zod / Joi / Valibot / ArkType with a ~5-line adapter.
- **Hono adapter** — `@quilla-be-kit/http/adapter/hono` sub-path ships a `HonoServer` that implements `WebServer`. `hono` is an optional peer dep.

Runtime deps: `@quilla-be-kit/errors`, `@quilla-be-kit/execution-context`, `@quilla-be-kit/observability`, `@quilla-be-kit/runtime`.

## Install

```sh
# Core:
pnpm add @quilla-be-kit/http @quilla-be-kit/errors @quilla-be-kit/execution-context \
         @quilla-be-kit/observability @quilla-be-kit/runtime

# Plus Hono adapter:
pnpm add hono
```

Node 22+.

## TypeScript configuration

Controllers rely on **stage-3 decorators** (not the legacy `experimentalDecorators`). Your `tsconfig.json` needs:

```json
{
  "compilerOptions": {
    "target": "ES2022",                     // or higher
    "module": "NodeNext",
    "moduleResolution": "NodeNext"
    // experimentalDecorators — must be false or omitted
    // emitDecoratorMetadata   — must be false or omitted
  }
}
```

- **TypeScript 5.0+** (5.2+ recommended).
- **`experimentalDecorators` must be `false` (or absent).** If you have it on for legacy reasons, `@Controller`/`@Get`/etc. will compile under the old decorator protocol and route metadata won't register. TS 5.x defaults to stage-3 when this flag is absent.
- **`target` ≥ `"ES2022"`.** Stage-3 decorators compile on top of ES2022 class semantics.

Consumers do **not** need to polyfill `Symbol.metadata` themselves — the library installs a shared identity (`Symbol.for('Symbol.metadata')`) at module load. You also do not need `emitDecoratorMetadata`; that's a legacy-decorator flag and does nothing for stage-3.

## Quick start

```ts
import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import {
  Controller,
  Get,
  Post,
  GetPublic,
  AuthorizeScope,
  ValidateRequest,
  Router,
  type HttpRequest,
  type HttpResponse,
  type RequestValidator,
} from '@quilla-be-kit/http';
import { HonoServer } from '@quilla-be-kit/http/adapter/hono';
import { Runtime, ShutdownManager, ComponentRegistry } from '@quilla-be-kit/runtime';
import {
  authenticatedSessionMiddleware,
  bearerTokenMiddleware,
} from '@quilla-be-kit/security';
import { serve } from '@hono/node-server';

@Controller('/users')
class UsersController {
  @GetPublic('/healthz')
  async health(_req: HttpRequest): Promise<HttpResponse> {
    return { httpCode: 200, payload: { ok: true } };
  }

  @Get('/:id')
  @AuthorizeScope('user:read')
  async show(req: HttpRequest): Promise<HttpResponse> {
    const id = req.getParams()['id'];
    return { httpCode: 200, payload: { id } };
  }

  @Post('/')
  @AuthorizeScope('user:write')
  @ValidateRequest(CreateUserRequestDto, ['body'])
  async create(req: HttpRequest): Promise<HttpResponse> {
    const input = req.getValidatedInput<CreateUserCommand>();
    // ... application logic
    return { httpCode: 201, payload: { id: 'new-id' } };
  }
}

const provider = new AsyncExecutionContextProvider();

const components = new ComponentRegistry<{
  readonly controllers?: readonly object[];
}>();

components.register({
  name: 'users',
  meta: { controllers: [new UsersController()] },
});

const router = new Router({
  modules: components.getAll(),
  executionContext: { provider },
  globalMiddlewares: [/* your custom globals (cors, rate-limit, request-logger, ...) */],
  authMiddlewares: {
    tokenVerification: bearerTokenMiddleware({ tokenService }),
    sessionLoad: authenticatedSessionMiddleware({
      sessionStore,
      executionContextProvider: provider,
    }),
  },
});

const server = new HonoServer({
  port: 3000,
  router,
  requestValidator: zodRequestValidator, // see below
  serve: (app, port) => {
    const handle = serve({ fetch: app.fetch, port });
    return {
      close: () =>
        new Promise<void>((resolve, reject) =>
          handle.close((err) => (err ? reject(err) : resolve())),
        ),
    };
  },
});

const shutdown = new ShutdownManager({ timeoutMs: 10_000 });
shutdown.addPhase({
  name: 'http',
  participants: [{ name: 'HonoServer', dispose: () => server.close() }],
});

const runtime = new Runtime({ shutdownManager: shutdown });
await runtime.run(async () => {
  await server.listen();
});
```

## Decorators

### `@Controller(prefix)`

Class decorator. Every route on the class gets `prefix` prepended.

```ts
@Controller('/users')
class UsersController { ... }
```

### HTTP method decorators

```ts
@Get(path)          @GetPublic(path)
@Post(path)         @PostPublic(path)
@Put(path)          @PutPublic(path)
@Patch(path)        @PatchPublic(path)
@Delete(path)       @DeletePublic(path)
```

The `*Public` variants mark the route as public — **auth middlewares are skipped** for these routes. The non-public variants run every registered `authMiddleware` before the handler.

### `@AuthorizeScope(scope, mode?)`

Scope-based authorization. Reads an `AuthenticatedToken` from `request.getAttribute(HttpAttributes.VERIFIED_TOKEN)` and checks the token's `scopes` against the required scope(s).

```ts
@AuthorizeScope('user:read')              // default: 'any' — passes if token has user:read
@AuthorizeScope(['user:read', 'admin'])   // passes if token has any of these
@AuthorizeScope(['user:write', 'admin'], 'all')  // requires both
```

Throws `ForbiddenError` on missing token or mismatch. An auth middleware (from `@quilla-be-kit/security` or consumer code) must have populated the `VERIFIED_TOKEN` attribute.

### `@ValidateRequest(schema, sources)`

Merges data from the configured sources (`'body'`, `'params'`, `'query'`), injects `scopeId` and `userId` from `ExecutionContext.session` **only when the schema declares those keys and a session is active**, validates against `schema` using the server's `RequestValidator`, and attaches the validated value to the request. Retrieve with `request.getValidatedInput<T>()`.

Auth-injection requires two things:
- A live `session` on the request's `ExecutionContext` (i.e. the route ran through auth middleware that established one — anonymous and system contexts get no injection).
- The `RequestValidator` implements the optional `describeSchema(schema)` method (see [`RequestValidator` adapter](#requestvalidator-adapter) below). Without it, auth-injection is skipped entirely — a fail-safe default that keeps surprise fields out of schemas that didn't ask for them.

```ts
@Post('/')
@ValidateRequest(CreateUserRequestDto, ['body'])
async create(req: HttpRequest): Promise<HttpResponse> {
  const input = req.getValidatedInput<CreateUserCommand>();
  // input is typed as CreateUserCommand — consumer asserts the runtime shape
}
```

On validation failure, throws `ValidationError` with `context.issues` containing the validator's raw error array (e.g. Zod issues, Joi details). `resolveHttpError` surfaces this as a 400 response with `body.error.details.issues`.

## `RequestValidator` adapter

### Zod — use the out-of-the-box helper

The toolkit ships a ready-made Zod 4 adapter under `@quilla-be-kit/http/validator/zod`. It implements both `validate` and the optional `describeSchema` — the latter unwraps `ZodPipe` (produced by `.transform(...)`) so schemas from `@quilla-be-kit/persistence/query-schema` interoperate without any extra wiring.

```ts
import { createZodRequestValidator } from '@quilla-be-kit/http/validator/zod';

const server = new HonoServer({
  requestValidator: createZodRequestValidator(),
  // ...
});
```

Accepts an `extractIssues(error)` hook if you want to reshape Zod's raw issue array before it lands in `ValidationError.context.issues`:

```ts
createZodRequestValidator({
  extractIssues: (err) => err.issues.map((i) => ({ path: i.path, message: i.message })),
});
```

`zod` is an **optional** peer dep of `@quilla-be-kit/http` — required only when importing from this sub-path.

### Other validators — ~5 lines

If you use Joi, Valibot, ArkType, or anything else, implement `RequestValidator` directly:

```ts
// Joi
import type { Schema } from 'joi';

const joiRequestValidator: RequestValidator = {
  validate: (schema, input) => {
    const result = (schema as Schema).validate(input, { abortEarly: false });
    return result.error
      ? { success: false, error: result.error.details }
      : { success: true, data: result.value };
  },
  // Optional: implement describeSchema to enable conditional auth-injection
  // in @ValidateRequest. Return { keys } for schemas whose top-level keys
  // are enumerable, null otherwise.
};
```

Pass to `new HonoServer({ requestValidator, ... })`. The library handles conversion from the `{ success, error }` tuple to a thrown `ValidationError` — consumers never construct quilla-be-kit errors directly.

## Router

```ts
const router = new Router({
  controllers: [new UsersController()],   // plain controller instances
  // OR via modules from ComponentRegistry<HttpModuleMeta>:
  modules: registry.getAll(),

  // Optional — when provided, Router installs a system execution-context
  // bootstrap before any consumer middleware. Every route (public and
  // non-public) gets a baseline anonymous context with a correlation id
  // read from `correlationIdHeader` (default `'x-correlation-id'`) or a
  // generated UUID if absent.
  // **Required iff `authMiddlewares` is set** — Router throws at construction
  // otherwise. Skip it for pure-public services that never call
  // `request.getExecutionContext()`. The provider carries its own factory
  // (default `executionContextFactory`); pass a custom factory via
  // `new AsyncExecutionContextProvider({ factory })` if you've extended the
  // ExecutionContext shape.
  executionContext: {
    provider,
    correlationIdHeader: 'x-request-id', // optional, defaults to 'x-correlation-id'
  },

  globalMiddlewares: [...],               // custom — run on every route after system bootstrap
  authMiddlewares: { tokenVerification, sessionLoad? },  // typed stack — non-public routes only
});
```

- Controllers can be registered as plain instances (no extra metadata) or wrapped in `{ controller, prefix?, middlewares? }` for per-controller prefix + middlewares.
- Routes are sorted by **specificity** (static segments > parametric > wildcard) so `/users/healthz` matches before `/users/:id`.
- Path composition: `[module prefix] + [registration prefix] + [@Controller prefix] + [@Route path]`, normalized to a single leading slash and no trailing slash.
- Duplicate routes (same method + path) throw at construction time — you catch double-registrations at startup, not under load.

### Middleware chain order

On a **non-public** route:

```
system executionContext bootstrap  →  globalMiddlewares[]  →  tokenVerification  →  sessionLoad?  →  route middlewares  →  handler
```

On a **`*Public` route**, the entire `authMiddlewares` stack is skipped:

```
system executionContext bootstrap  →  globalMiddlewares[]  →  route middlewares  →  handler
```

The system bootstrap is Router-owned and not configurable from outside — this eliminates "I forgot to add `executionContextMiddleware`" as a failure mode for services that use auth or read `ExecutionContext`. When `executionContext` is omitted, the bootstrap step is skipped entirely; services that never read context pay no boilerplate. Router throws at construction if `authMiddlewares` is set without `executionContext` — the known-static dependency is caught at startup, not at the first authenticated request. The typed `AuthMiddlewareStack` prevents phase misordering at the type level; the array in `globalMiddlewares` stays open-ended because custom middleware ordering is consumer-owned.

## Bridge to `ComponentRegistry<HttpModuleMeta>`

`ComponentRegistry<HttpModuleMeta>` is the shared spine between `@quilla-be-kit/runtime` and `@quilla-be-kit/http`:

```ts
import { ComponentRegistry } from '@quilla-be-kit/runtime';
import { type HttpModuleMeta } from '@quilla-be-kit/http';

const registry = new ComponentRegistry<HttpModuleMeta>({
  contracts: [IAM_CONTRACT, DM_CONTRACT],
});

registry
  .register({
    name: 'iam',
    meta: {
      prefix: '/api/v1',
      controllers: [usersController, authController],
      middlewares: [iamModuleMw],
    },
    dispose: () => iamModule.dispose(),
  })
  .register({
    name: 'dm',
    meta: {
      prefix: '/api/v1',
      controllers: [documentsController],
    },
  });

// Router reads the registry directly:
const router = new Router({ modules: registry.getAll(), ... });

// Shutdown phase reads the same registry:
shutdown.addPhase(registry.toShutdownPhase('modules'));
```

One source of truth: adding a new module means one `.register(...)` call, and both the route table and the shutdown ordering pick it up automatically.

## `WebServer` interface

```ts
export interface WebServer {
  bootstrap(): void | Promise<void>;
  listen(): Promise<void>;
  close(): Promise<void>;
}
```

- `bootstrap()` — wires routes, middlewares, error handler onto the underlying framework. Idempotent.
- `listen()` — starts accepting connections.
- `close()` — stops accepting connections and awaits in-flight requests.

`HonoServer implements WebServer`. Future adapters (Express, Fastify) would ship as additional sub-paths implementing the same interface — `const server: WebServer = new HonoServer(...)` stays the shape your composition root depends on.

## Hono adapter

Sub-path: `@quilla-be-kit/http/adapter/hono`. Ships `HonoServer` only. `hono` is an optional peer dep pinned to `4.x.x`.

```ts
import { HonoServer, type HonoServeFn } from '@quilla-be-kit/http/adapter/hono';
import { serve } from '@hono/node-server';

const honoServe: HonoServeFn = (app, port) => {
  const handle = serve({ fetch: app.fetch, port });
  return {
    close: () =>
      new Promise<void>((resolve, reject) =>
        handle.close((err) => (err ? reject(err) : resolve())),
      ),
  };
};

const server = new HonoServer({
  port: 3000,
  router,                 // HonoServer reads the execution-context provider from Router
  requestValidator,       // optional — required only if any route uses @ValidateRequest
  logger,                 // optional — used for startup/shutdown/error logs
  serve: honoServe,
});
```

The `serve` callback is where you pick your Node runtime — `@hono/node-server`, Bun's native serve, Deno's native serve, a test stub, etc. Runtime-specific so the adapter stays portable.

Consumer never constructs `HonoRequestAdapter` or `HonoMiddlewareAdapter` directly — `HonoServer` wires them internally.

## Other frameworks

If you need Express or Fastify: open an issue. Adapter sub-paths ship as library additions when they exist, not as consumer extension points.

## Testing controllers

Since controllers are plain classes with decorators, you test them the way you'd test any class — construct an instance, pass a fake `HttpRequest`, assert the `HttpResponse`. No framework, no server, no adapter.

```ts
const controller = new UsersController();
const response = await controller.show(fakeRequest({ params: { id: '42' } }));
expect(response.httpCode).toBe(200);
```

For integration tests, use `HonoServer` with a `serve` callback that captures `app.fetch` — see this package's adapter tests for the pattern.
