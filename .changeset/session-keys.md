---
'@quilla-be-kit/http': minor
'@quilla-be-kit/ddd': minor
'@quilla-be-kit/execution-context': minor
'@quilla-be-kit/messaging': patch
'@quilla-be-kit/security': patch
---

Carry app-defined session fields through validated input, logs and events.

`http`: `AuthMiddlewareStack` gains `sessionKeys`. On that stack's routes, `@ValidateRequest` injects the listed `ExecutionContext.session` fields when the schema declares them, alongside `scopeId`/`userId`. A client-sent value for those keys is always discarded, even when the validator has no `describeSchema`, and a key the session can't supply fails the request with a generic 500.

New construction errors:

- `sessionKeys` without `sessionLoad`.
- An empty or prototype-named session key.
- A route that sources a session key from a header on a stack with `sessionLoad`. This also covers `scopeId`/`userId`, so a route mapping them to a header on such a stack now throws.

Behavior changes:

- Session fields are injected after header fields, so the session wins over a header mapped to the same key.
- A session without a `scopeId`/`userId` value the schema declares now fails with a 500 instead of injecting `undefined`.

`ddd`: `EventMetadata` gains optional `actorAttributes`, app-defined facts about the actor beyond `scopeId`/`userId`. Values are strings, numbers or booleans; both ids are required and their names can't be reused. `toJSON` omits the key when absent, so existing event JSON is unchanged. New type export: `ActorAttributes`.

`execution-context`:

- `createFromEventMetadata` accepts parsed JSON metadata (`EventMetadataSource`) and restores `actorAttributes` onto the session.
- `ExecutionContextEnricher` takes an optional `{ sessionKeys }` to log the listed session fields under `extra.session`.
- **Fix:** a system event read back from the bus (`scopeId: null`, `userId: null`) was rebuilt as an authenticated context with `null` ids; it now has no session.

`messaging`, `security`: README updates for the above.
