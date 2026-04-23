---
"@quilla-kit/messaging": minor
---

`EventSubscription` is an `interface`. Consumers can `class Foo implements
EventSubscription<Payload>` with a plain `async handle(entry)` method —
no constructor property-assignment workaround needed. File renamed to
`event-subscription.interface.ts` to match the repo's naming convention.

Exports `HandlerEntry<TPayload>` — the shape a handler receives
(`{ payload, eventType, eventVersion, aggregateId?, correlationId? }`).
Consumers can type their `handle` parameter explicitly when it helps
readability, and `EventHandler<TPayload>` + `EventSubscription.handle`
share this single definition instead of duplicating it inline.
