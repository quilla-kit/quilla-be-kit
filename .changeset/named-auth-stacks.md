---
'@quilla-be-kit/http': minor
---

Replace the single global auth middleware stack with named auth stacks selectable per route, controller, or module.

**BREAKING (pre-1.0):** `RouterOptions.authMiddlewares` is replaced by `authStacks` + `defaultAuthStack`, and `AuthMiddlewareStack.tokenVerification` is renamed `credentialVerification`. Both are compiler-caught; migration is mechanical:

```ts
// before
authMiddlewares: {
  tokenVerification: bearerTokenMiddleware({ tokenService }),
  sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider }),
},

// after
authStacks: {
  bearer: {
    credentialVerification: bearerTokenMiddleware({ tokenService }),
    sessionLoad: authenticatedSessionMiddleware({ sessionStore, executionContextProvider }),
  },
},
defaultAuthStack: 'bearer',
```

The phase is renamed because a stack may verify a JWT, an opaque token, an API key, or a client certificate — "token" named only one of them. The attribute it populates keeps the `VERIFIED_TOKEN` name, which is the contract with `@quilla-be-kit/security`'s `Token`.

**Selecting a stack.** `authStack` is a new option on `@Get`/`@Post`/`@Put`/`@Patch`/`@Delete`, on `@Controller`, and on `HttpModuleMeta`, resolving `route ?? @Controller ?? module ?? defaultAuthStack` — the same precedence ladder as `version`, and an option on the existing decorators for the same reason: it is a Router-construction fact with no handler-wrapping behavior, so it rides in the same route registration and cannot be dropped by decorator ordering.

`Router` is now generic over its stack names, so `defaultAuthStack` is constrained to the declared keys. Route-, controller-, and module-level `authStack` remain strings — decorators are evaluated independently of Router construction — and are validated at startup instead.

**Every misconfiguration throws at construction, never at request time:** an empty `authStacks` record; `authStacks` without `executionContext`; a missing or undeclared `defaultAuthStack`; an undeclared stack named by a route, `@Controller`, or module; an `authStack` on a `*Public` route; and the same controller registered twice (whose copies would otherwise resolve to different stacks at different paths). The resolved chain lookup is itself the guard, so an unresolvable stack cannot degrade to "no auth".

Router also stamps the resolved stack name on the request as `HttpAttributes.AUTH_STACK`, so guards can assert which stack authenticated a caller — `scopes` share one flat namespace across stacks and cannot carry that.

Services with no authentication omit `authStacks` entirely and are unaffected.

**Fix:** route metadata was read through the prototype-linked `Symbol.metadata` bag, so defining a subclass pushed its routes into the *parent's* array. An app registering only the base class silently served the subclass's paths, and registering any subclassed controller threw `Duplicate route`. Route storage now uses own-property semantics, and metadata-bag walking dedupes by identity — a subclass with no decorators of its own inherits the parent's bag through the static class chain and previously yielded it twice.

**Fix:** `@AuthorizeScope` and `@ValidateRequest` patched the last-registered route, so writing them *below* the method decorator silently dropped their `scopes` / `scopeMode` / `validation` metadata — which every usage in this repo and its READMEs did. Patches now accumulate per class and merge at read time, making decorator order irrelevant. Enforcement was never affected (it lives in the returned wrappers, which are order-independent), so no runtime behavior changes; the metadata now describes what actually happens.
