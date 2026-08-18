---
'@quilla-be-kit/security': patch
---

Document multi-audience authentication, following the named auth stacks in `@quilla-be-kit/http`.

"Custom token schemes" becomes "Custom credential schemes" and now shows running a JWT stack and an API-key stack **concurrently** with per-route selection, rather than replacing the single stack. The quick start and middleware-chain sections are rewired to `authStacks` / `credentialVerification`.

Two hazards are called out that the code cannot enforce:

- **Each stack needs its own `sessionLoad`.** `authenticatedSessionMiddleware` keys `SessionStore` on `token.userId` alone and hardcodes `actorType: 'user'`. Reusing it for a second stack whose credential resolves to an existing user makes a human logout silently revoke machine access, and can never produce a non-user `actorType`. A custom `sessionLoad` must also populate `ExecutionContext.session` — `@ValidateRequest` injects `scopeId`/`userId` only when it is present, so omitting it fails open.
- **Stacks must not share a credential verifier or signing key.** `TokenService.verify` takes no audience and `TokenClaims` carries no `aud`, so per-route stack selection is the only boundary between audiences.

Docs only — no API change.
