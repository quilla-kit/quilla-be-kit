---
"@quilla-be-kit/messaging": minor
---

Add `EventSubscription<TPayload>` + bulk wiring on `EventConsumer`
(`options.subscriptions` and `consumer.subscribe()`) so module factories
can return `(descriptor, handle)` pairs and the composition root just
passes the combined array to the consumer.

`defineEvent` now accepts a [Standard Schema v1](https://standardschema.dev)
instance (Zod, Valibot, ArkType, etc.) as its second argument. When a
descriptor carries a schema, `EventConsumer.on` validates
`entry.payload` before dispatching to the handler — failures mark the
event `FAILED` immediately (no retries; validation is deterministic) and
surface the issue summary in the row's `last_error`. `EventDescriptor`'s
`schema` field is now typed as `StandardSchemaV1<unknown, TPayload>`
instead of the previous opaque URI string (which was never read).

Exports `SchemaValidationError` so operators can `instanceof`-check in
metrics and alerting.
