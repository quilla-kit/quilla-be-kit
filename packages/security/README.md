# @quilla-kit/security

Interface-only security primitives + the two auth middlewares that plug into `@quilla-kit/http`'s Router:

- **`Token`** (extends `AuthenticatedToken` from http) — verified-credential contract with `userId`, `scopeId`, `securityStamp`, `issuedAt`, `expiresAt`, `isExpired()`.
- **`TokenService`** — `sign(payload, { expiresIn })` + `verify(raw)` interface. Consumer provides the implementation (JWT via `jose`/`djwt`/`jsonwebtoken`, PASETO, opaque reference tokens — your choice).
- **`SessionStore`** — keyed session record storage. Consumer picks the backend (Redis, Valkey, DynamoDB, Postgres).
- **`SessionData`** — record shape: `{ securityStamp, displayName, userType }`.
- **`PasswordHasher`** — `hash` + `compare` interface. Consumer provides the implementation (argon2 / bcrypt / scrypt).
- **`bearerTokenMiddleware({ tokenService })`** — reads `Authorization: Bearer ...`, calls `tokenService.verify`, populates `HttpAttributes.VERIFIED_TOKEN`. Throws `UnauthorizedError` on any failure.
- **`authenticatedSessionMiddleware({ sessionStore, executionContextProvider })`** — loads session data, compares `securityStamp`, enriches `ExecutionContext` with `userId` / `scopeId` / `actorType: 'user'`. Throws `UnauthorizedError` on stamp mismatch or session miss.

Zero runtime dependencies on external libraries — JWT lib, cache driver, and hashing library are all consumer-owned. Node 22+.

## Install

```sh
pnpm add @quilla-kit/security @quilla-kit/http @quilla-kit/execution-context @quilla-kit/errors
```

## Why interface-only?

JWT algorithm choice, key rotation strategy, cache backend, and password-hashing cost parameters are **security decisions** that belong in the consumer's composition root, not in a toolkit. Shipping a built-in adapter for any of these would either:

- Freeze a choice (one hashing algorithm, one JWT library) that teams rightfully contest, or
- Pull in optional peer deps (`bcrypt` brings `node-gyp`, `jose`/`jsonwebtoken` bring opinions about crypto primitives) for what amounts to ~4–10 lines of glue.

Same discipline as `RequestValidator` in `@quilla-kit/http`: ship the interface, let consumers write the 5-line adapter.

## Quick start

```ts
import { AsyncExecutionContextProvider } from '@quilla-kit/execution-context';
import { Router } from '@quilla-kit/http';
import { HonoServer } from '@quilla-kit/http/adapter/hono';
import {
  authenticatedSessionMiddleware,
  bearerTokenMiddleware,
  type TokenService,
  type SessionStore,
  type Token,
  type SignTokenPayload,
} from '@quilla-kit/security';

// --- Consumer-owned TokenService (example: jose) ---
import { SignJWT, jwtVerify } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET!);

const jwtTokenService: TokenService = {
  async sign(payload: SignTokenPayload, options: { expiresIn: number }): Promise<string> {
    return new SignJWT({
      u: payload.userId,
      s: payload.scopeId,
      st: payload.securityStamp,
      ...(payload.scope ? { sc: payload.scope } : {}),
    })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn)
      .sign(secret);
  },
  async verify(raw: string): Promise<Token> {
    const { payload } = await jwtVerify(raw, secret);
    const issuedAt = new Date((payload.iat as number) * 1000);
    const expiresAt = new Date((payload.exp as number) * 1000);
    return {
      userId: String(payload.u),
      scopeId: String(payload.s),
      securityStamp: String(payload.st),
      scope: (payload.sc as readonly string[] | undefined) ?? undefined,
      issuedAt,
      expiresAt,
      isExpired(now = new Date()): boolean {
        return now >= expiresAt;
      },
    };
  },
};

// --- Consumer-owned SessionStore (example: Redis via ioredis) ---
import Redis from 'ioredis';

const redis = new Redis();
const sessionStore: SessionStore = {
  async set(userId, data, ttlSeconds) {
    await redis.setex(`session:${userId}`, ttlSeconds, JSON.stringify(data));
  },
  async get(userId) {
    const raw = await redis.get(`session:${userId}`);
    return raw ? JSON.parse(raw) : null;
  },
  async delete(userId) {
    await redis.del(`session:${userId}`);
  },
};

// --- Wire into Router ---
const provider = new AsyncExecutionContextProvider();

const router = new Router({
  executionContext: { provider },
  authMiddlewares: {
    tokenVerification: bearerTokenMiddleware({ tokenService: jwtTokenService }),
    sessionLoad: authenticatedSessionMiddleware({
      sessionStore,
      executionContextProvider: provider,
    }),
  },
  modules: registry.getAll(),
});

const server = new HonoServer({ port: 3000, router, serve });
```

## Middleware chain

When `authMiddlewares` is populated, Router runs on a **non-public** route:

```
system executionContext bootstrap (http-owned)
  → globalMiddlewares[]
    → bearerTokenMiddleware           (security — tokenVerification phase)
      → authenticatedSessionMiddleware  (security — sessionLoad phase, if present)
        → route middlewares
          → handler
```

On a **`*Public` route**, the entire `authMiddlewares` stack is skipped. The system execution-context bootstrap always runs, so even public handlers can call `provider.getContext()`.

The typed `AuthMiddlewareStack` shape (from `@quilla-kit/http`) enforces phase ordering at the type level — `tokenVerification` runs before `sessionLoad` regardless of how keys are declared.

## Custom token schemes

Replace `bearerTokenMiddleware` with your own `tokenVerification` middleware to support a different authentication mechanism (API key header, mTLS client cert, OAuth introspection):

```ts
import type { AuthMiddlewareStack, HttpMiddleware } from '@quilla-kit/http';
import { HttpAttributes } from '@quilla-kit/http';
import { UnauthorizedError } from '@quilla-kit/errors';

const apiKeyVerification: HttpMiddleware = async (request, next) => {
  const key = request.getHeader('x-api-key');
  if (!key || !(await isValid(key))) {
    throw new UnauthorizedError({ message: 'Invalid API key' });
  }
  request.setAttribute(HttpAttributes.VERIFIED_TOKEN, await loadTokenForKey(key));
  await next();
};

const stack: AuthMiddlewareStack = { tokenVerification: apiKeyVerification };
new Router({ /* ... */ authMiddlewares: stack });
```

The only contract `tokenVerification` must honor: on success, populate `HttpAttributes.VERIFIED_TOKEN` with something satisfying `AuthenticatedToken` (for `@AuthorizeScope`) — typically a full `Token`, so `authenticatedSessionMiddleware` can load the matching session.

## Session revocation

`securityStamp` is the revocation mechanism. Rotate the stored stamp whenever the session should be invalidated:

- **Explicit logout** → `sessionStore.delete(userId)`.
- **Password change / force revoke** → rotate `securityStamp` in your user record and `sessionStore.set(userId, { ...session, securityStamp: newStamp }, ttl)`.

The next request with a token carrying the old stamp fails `authenticatedSessionMiddleware`'s stamp comparison and is rejected as `UnauthorizedError` — without any change to the token itself.

## Role as the rule-of-three harness

`@quilla-kit/security` is the first consumer that exercises every other quilla-kit package in concert:

- `@quilla-kit/errors` — `UnauthorizedError` surfaces through the http error handler.
- `@quilla-kit/execution-context` — enriched context propagates through AsyncLocalStorage to downstream code.
- `@quilla-kit/http` — `HttpRequest`/`HttpMiddleware`/`HttpAttributes`/`AuthenticatedToken`/`AuthMiddlewareStack` are all load-bearing here.
- `@quilla-kit/observability` — the `UnauthorizedError` `cause` chain preserves the underlying verification failure for structured logs.

If these primitives can be composed into a clean auth module without bending any quilla-kit interface, the substrate is right. The moment it starts bending, we catch it here.

## Status

Interface + middleware surface implemented. No bundled `TokenService`, `SessionStore`, or `PasswordHasher` adapters — by design.
