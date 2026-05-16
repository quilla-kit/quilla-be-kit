---
"@quilla-be-kit/http": minor
"@quilla-be-kit/security": minor
---

Add `TokenClaims` (security) and rename `scope` → `scopes` on token-shaped types.

**`TokenClaims` — canonical short-key wire-format type for JWT payloads.**
`SignTokenPayload` and `Token` keep their readable developer-facing
fields (`userId`, `scopeId`, `securityStamp`, `scopes`). `TokenClaims`
gives `TokenService` implementers a typed target for the compact
on-the-wire shape:

```ts
type TokenClaims = {
  readonly u: string;             // userId
  readonly si: string;            // scopeId
  readonly st: string;            // securityStamp
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
