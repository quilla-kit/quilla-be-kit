---
"@quilla-kit/security": minor
---

Add `TokenClaims` — canonical short-key wire-format type for JWT payloads.

`SignTokenPayload` and `Token` keep their readable developer-facing
fields (`userId`, `scopeId`, `securityStamp`, `scope`). `TokenClaims`
gives `TokenService` implementers a typed target for the compact
on-the-wire shape:

```ts
type TokenClaims = {
  readonly u: string;        // userId
  readonly si: string;       // scopeId
  readonly st: string;       // securityStamp
  readonly s?: readonly string[]; // scope
};
```

Short keys exist for **payload size**, not security — JWTs travel in
every authenticated request header, so claim names are a real
bandwidth cost. Renaming developer-facing fields would not have helped
(JWTs are signed, not encrypted, and the type definitions are public
in OSS), so the split keeps ergonomics readable while making the wire
contract explicit.

Implementers map between the two at the sign/parse boundary — see the
package README for a `jose` example.
