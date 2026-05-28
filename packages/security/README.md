# @quilla-be-kit/security

Interface-only security primitives + the two auth middlewares that plug into `@quilla-be-kit/http`'s Router:

- **`Token`** (extends `AuthenticatedToken` from http) — verified-credential contract with `userId`, `scopeId`, `securityStamp`, `issuedAt`, `expiresAt`, `isExpired(now?: Date)`. The optional `now` parameter defaults to `new Date()` — pass an explicit date in tests for deterministic expiry checks.
- **`TokenClaims`** — canonical short-key wire-format type for the JWT payload (`u`, `si`, `st`, `s?` for scopes). Implementers map between the readable `SignTokenPayload` / `Token` shapes and these compact claims at the encode/decode boundary. Tokens travel in every request header — short keys exist for payload size, not security.
- **`TokenService`** — `sign(payload, { expiresIn })` + `verify(raw)` interface. Consumer provides the implementation (JWT via `jose`/`djwt`/`jsonwebtoken`, PASETO, opaque reference tokens — your choice).
- **`SessionStore`** — keyed session record storage. Consumer picks the backend (Redis, Valkey, DynamoDB, Postgres).
- **`SessionData`** — record shape: `{ securityStamp, displayName, userType }`.
- **`PasswordHasher`** — `hash` + `compare` interface. Consumer provides the implementation (argon2 / bcrypt / scrypt).
- **`bearerTokenMiddleware({ tokenService })`** — reads `Authorization: Bearer ...`, calls `tokenService.verify`, populates `HttpAttributes.VERIFIED_TOKEN`. Throws `UnauthorizedError` on any failure.
- **`authenticatedSessionMiddleware({ sessionStore, executionContextProvider })`** — loads session data, compares `securityStamp`, enriches `ExecutionContext` with `actorType: 'user'` and a populated `session: { scopeId, userId }` (the `AuthSession` from `@quilla-be-kit/execution-context`). Throws `UnauthorizedError` on stamp mismatch or session miss.

Zero runtime dependencies on external libraries — JWT lib, cache driver, and hashing library are all consumer-owned. Node 22+.

## Install

```sh
pnpm add @quilla-be-kit/security @quilla-be-kit/http @quilla-be-kit/execution-context @quilla-be-kit/errors
```

## Why interface-only?

JWT algorithm choice, key rotation strategy, cache backend, and password-hashing cost parameters are **security decisions** that belong in the consumer's composition root, not in a toolkit. Shipping a built-in adapter for any of these would either:

- Freeze a choice (one hashing algorithm, one JWT library) that teams rightfully contest, or
- Pull in optional peer deps (`bcrypt` brings `node-gyp`, `jose`/`jsonwebtoken` bring opinions about crypto primitives) for what amounts to ~4–10 lines of glue.

Same discipline as `RequestValidator` in `@quilla-be-kit/http`: ship the interface, let consumers write the 5-line adapter.

## Quick start

```ts
import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { Router } from '@quilla-be-kit/http';
import { HonoServer } from '@quilla-be-kit/http/adapter/hono';
import {
  authenticatedSessionMiddleware,
  bearerTokenMiddleware,
  type TokenService,
  type SessionStore,
  type Token,
  type TokenClaims,
  type SignTokenPayload,
} from '@quilla-be-kit/security';

// --- Consumer-owned TokenService (example: jose) ---
import { SignJWT, jwtVerify, type JWTPayload } from 'jose';

const secret = new TextEncoder().encode(process.env.JWT_SECRET!);

const toClaims = (payload: SignTokenPayload): TokenClaims => ({
  u: payload.userId,
  si: payload.scopeId,
  st: payload.securityStamp,
  ...(payload.scopes ? { s: payload.scopes } : {}),
});

const fromClaims = (claims: TokenClaims): SignTokenPayload => ({
  userId: claims.u,
  scopeId: claims.si,
  securityStamp: claims.st,
  scopes: claims.s,
});

const jwtTokenService: TokenService = {
  async sign(payload: SignTokenPayload, options: { expiresIn: number }): Promise<string> {
    return new SignJWT({ ...toClaims(payload) })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + options.expiresIn)
      .sign(secret);
  },
  async verify(raw: string): Promise<Token> {
    const { payload } = await jwtVerify(raw, secret);
    const decoded = fromClaims(payload as unknown as TokenClaims);
    const issuedAt = new Date((payload.iat as number) * 1000);
    const expiresAt = new Date((payload.exp as number) * 1000);
    return {
      ...decoded,
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

The typed `AuthMiddlewareStack` shape (from `@quilla-be-kit/http`) enforces phase ordering at the type level — `tokenVerification` runs before `sessionLoad` regardless of how keys are declared.

## Middleware options

Both middlewares take a single minimal options bag:

```ts
type BearerTokenMiddlewareOptions = {
  readonly tokenService: TokenService;
};

type AuthenticatedSessionMiddlewareOptions = {
  readonly sessionStore: SessionStore;
  readonly executionContextProvider: ExecutionContextProvider;
};
```

No header override, no timeout, no key prefix — all of those are
implementation choices inside your `TokenService` / `SessionStore`
adapters (where they belong). If you need a different token header or
scheme, swap the whole middleware — see "Custom token schemes" below.

## Where implementations live

The interfaces (`TokenService`, `SessionStore`, `PasswordHasher`) belong
in **your consumer project**, not in `@quilla-be-kit/security`. Typical
placement:

```
src/
├── security/
│   ├── jwt-token-service.ts        // implements TokenService (jose / jsonwebtoken)
│   ├── redis-session-store.ts      // implements SessionStore (ioredis / upstash)
│   └── argon2-password-hasher.ts   // implements PasswordHasher (@node-rs/argon2)
└── composition-root.ts             // wires middlewares with the implementations above
```

The composition root is where you inject your concrete adapters into
`bearerTokenMiddleware({ tokenService })` and
`authenticatedSessionMiddleware({ sessionStore, executionContextProvider })`,
then pass the pair to `new Router({ authMiddlewares: { ... } })`.

## Custom token schemes

Replace `bearerTokenMiddleware` with your own `tokenVerification` middleware to support a different authentication mechanism (API key header, mTLS client cert, OAuth introspection):

```ts
import type { AuthMiddlewareStack, HttpMiddleware } from '@quilla-be-kit/http';
import { HttpAttributes } from '@quilla-be-kit/http';
import { UnauthorizedError } from '@quilla-be-kit/errors';

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

`@quilla-be-kit/security` is the first consumer that exercises every other quilla-be-kit package in concert:

- `@quilla-be-kit/errors` — `UnauthorizedError` surfaces through the http error handler.
- `@quilla-be-kit/execution-context` — enriched context propagates through AsyncLocalStorage to downstream code.
- `@quilla-be-kit/http` — `HttpRequest`/`HttpMiddleware`/`HttpAttributes`/`AuthenticatedToken`/`AuthMiddlewareStack` are all load-bearing here.
- `@quilla-be-kit/observability` — the `UnauthorizedError` `cause` chain preserves the underlying verification failure for structured logs.

If these primitives can be composed into a clean auth module without bending any quilla-be-kit interface, the substrate is right. The moment it starts bending, we catch it here.

## Status

Interface + middleware surface implemented. No bundled `TokenService`, `SessionStore`, or `PasswordHasher` adapters — by design.
