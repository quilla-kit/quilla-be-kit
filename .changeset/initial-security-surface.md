---
"@quilla-be-kit/security": minor
---

Initial security surface — interface-only primitives + auth middlewares that plug into `@quilla-be-kit/http`'s Router.

- **`Token`** — extends `AuthenticatedToken` from http with `userId`, `scopeId`, `securityStamp`, `issuedAt`, `expiresAt`, `isExpired()`.
- **`TokenService`** — `sign(payload, { expiresIn })` / `verify(raw)` interface. Consumer wires `jose`/`djwt`/`jsonwebtoken`/PASETO/opaque-reference in ~10 lines.
- **`SignTokenPayload`** — payload shape for `TokenService.sign`: `{ userId, scopeId, securityStamp, scope? }`.
- **`SessionStore`** / **`SessionData`** — keyed session record storage. Consumer picks backend (Redis, Valkey, DynamoDB, Postgres). `securityStamp` in the session is compared against the token's stamp for revocation (password change, logout, admin force-revoke).
- **`PasswordHasher`** — `hash`/`compare` interface. Consumer wires `argon2`/`bcrypt`/`scrypt`.
- **`bearerTokenMiddleware({ tokenService })`** — verifies `Authorization: Bearer ...`, populates `HttpAttributes.VERIFIED_TOKEN`, throws `UnauthorizedError` on any failure (preserving the verifier's native error in `cause`).
- **`authenticatedSessionMiddleware({ sessionStore, executionContextProvider })`** — loads session, compares `securityStamp`, enriches `ExecutionContext` with `userId`/`scopeId`/`actorType: 'user'` via nested `runWithContext` for the remainder of the chain.

Consumers compose the typed `AuthMiddlewareStack` (from `@quilla-be-kit/http`) directly: `{ tokenVerification: bearerTokenMiddleware({ tokenService }), sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider }) }`. No builder helper — the phase shape is the API.

Zero external runtime dependencies — no bundled JWT library, no cache driver, no hashing library. JWT alg choice, key rotation, cache backend, and password-hashing cost parameters are security decisions that belong in the consumer's composition root.

Serves as the toolkit's rule-of-three validation harness: the first consumer that composes every other quilla-be-kit package together.
