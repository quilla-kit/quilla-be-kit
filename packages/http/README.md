# @quilla-kit/http

Framework-agnostic HTTP layer for a quilla-kit service:

- **Controller decorators** — `@Controller`, `@Get` / `@Post` / `@Put` / `@Patch` / `@Delete` + `*Public` variants, `@AuthorizeScope`, `@ValidateRequest`.
- **Router** — walks decorated controller instances, composes prefixes, sorts routes by specificity, bridges to `ComponentRegistry<HttpModuleMeta>` from `@quilla-kit/runtime`.
- **Request / response contracts** — `HttpRequest`, `HttpResponse`, `HttpMiddleware`, `AuthenticatedToken`, `HttpAttributes`.
- **Validator contract** — `RequestValidator` interface; wire Zod / Joi / Valibot / ArkType with a ~5-line adapter.
- **Hono adapter** — `@quilla-kit/http/adapter/hono` sub-path ships a `HonoServer` that implements `WebServer`. `hono` is an optional peer dep.

Runtime deps: `@quilla-kit/errors`, `@quilla-kit/execution-context`, `@quilla-kit/observability`, `@quilla-kit/runtime`.

## Install

```sh
# Core:
pnpm add @quilla-kit/http @quilla-kit/errors @quilla-kit/execution-context \
         @quilla-kit/observability @quilla-kit/runtime

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
import { AsyncExecutionContextProvider, executionContextFactory } from '@quilla-kit/execution-context';
import {
  Controller,
  Get,
  Post,
  GetPublic,
  AuthorizeScope,
  ValidateRequest,
  Router,
  executionContextMiddleware,
  type HttpRequest,
  type HttpResponse,
  type RequestValidator,
} from '@quilla-kit/http';
import { HonoServer } from '@quilla-kit/http/adapter/hono';
import { Runtime, ShutdownManager, ComponentRegistry } from '@quilla-kit/runtime';
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
  globalMiddlewares: [
    executionContextMiddleware({ provider, factory: executionContextFactory }),
  ],
  authMiddlewares: [/* your requireAuthMiddleware, authenticatedSessionMiddleware */],
});

const server = new HonoServer({
  port: 3000,
  router,
  executionContextProvider: provider,
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

Scope-based authorization. Reads an `AuthenticatedToken` from `request.getAttribute(HttpAttributes.VERIFIED_TOKEN)` and checks the token's `scope` against the required scope(s).

```ts
@AuthorizeScope('user:read')              // default: 'any' — passes if token has user:read
@AuthorizeScope(['user:read', 'admin'])   // passes if token has any of these
@AuthorizeScope(['user:write', 'admin'], 'all')  // requires both
```

Throws `ForbiddenError` on missing token or mismatch. An auth middleware (from `@quilla-kit/security` or consumer code) must have populated the `VERIFIED_TOKEN` attribute.

### `@ValidateRequest(schema, sources)`

Merges data from the configured sources (`'body'`, `'params'`, `'query'`), automatically injects `scopeId` and `userId` from the active `ExecutionContext`, validates against `schema` using the server's `RequestValidator`, and attaches the validated value to the request. Retrieve with `request.getValidatedInput<T>()`.

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

The http package ships only the interface — you wire your validator of choice in ~5 lines:

```ts
// Zod
import type { ZodType } from 'zod';

const zodRequestValidator: RequestValidator = {
  validate: (schema, input) => {
    const result = (schema as ZodType).safeParse(input);
    return result.success
      ? { success: true, data: result.data }
      : { success: false, error: result.error.issues };
  },
};
```

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
};
```

Pass to `new HonoServer({ requestValidator, ... })`. The library handles conversion from the `{ success, error }` tuple to a thrown `ValidationError` — consumers never construct quilla-kit errors directly.

## Router

```ts
const router = new Router({
  controllers: [new UsersController()],   // plain controller instances
  // OR via modules from ComponentRegistry<HttpModuleMeta>:
  modules: registry.getAll(),

  globalMiddlewares: [...],               // run on every route
  authMiddlewares: [...],                 // run on non-public routes
});
```

- Controllers can be registered as plain instances (no extra metadata) or wrapped in `{ controller, prefix?, middlewares? }` for per-controller prefix + middlewares.
- Routes are sorted by **specificity** (static segments > parametric > wildcard) so `/users/healthz` matches before `/users/:id`.
- Path composition: `[module prefix] + [registration prefix] + [@Controller prefix] + [@Route path]`, normalized to a single leading slash and no trailing slash.
- Duplicate routes (same method + path) throw at construction time — you catch double-registrations at startup, not under load.

## Bridge to `ComponentRegistry<HttpModuleMeta>`

`ComponentRegistry<HttpModuleMeta>` is the shared spine between `@quilla-kit/runtime` and `@quilla-kit/http`:

```ts
import { ComponentRegistry } from '@quilla-kit/runtime';
import { type HttpModuleMeta } from '@quilla-kit/http';

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

Sub-path: `@quilla-kit/http/adapter/hono`. Ships `HonoServer` only. `hono` is an optional peer dep pinned to `4.x.x`.

```ts
import { HonoServer, type HonoServeFn } from '@quilla-kit/http/adapter/hono';
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
  router,
  executionContextProvider,
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
