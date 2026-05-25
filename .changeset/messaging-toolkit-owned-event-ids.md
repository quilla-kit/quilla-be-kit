---
'@quilla-be-kit/messaging': minor
---

**Breaking:** `EventBusPublisher.publish` no longer accepts a caller-supplied
`id`; the bus owns event identity and returns the generated id.

The previous shape exposed `id: string` as a required input. Combined with the
explicit at-least-once retry loop, this created a contract trap: any caller
that reused an id across publish attempts (intentionally — content-addressed
ids — or accidentally — wrapping `publish` in a retry block) collided on
`events_pkey` and silently wedged the bus.

The new shape closes the trap by removing the parameter entirely:

```ts
// before
await publisher.publish({ id: myId, eventType, ..., createdAt });

// after
const busEventId: string = await publisher.publish({ eventType, ..., createdAt });
```

`PgEventBus.publish` now generates a UUID v4 internally per call. `OutboxForwarder`
no longer preserves a 1:1 correspondence between outbox row id and bus event id —
each forwarder publish generates a fresh bus id. The outbox row id and bus
event id are now logged together at `debug` level for tracing.

### Delivery-semantics implication

With toolkit-owned ids, the forwarder's "publish then markSent" pattern can
produce **duplicate bus rows for the same logical event** if `markSent` fails
after `publish` commits (next tick re-claims the outbox row → publishes
again with a fresh id → consumer dispatches twice). This is at-least-once
delivery working as documented — but the README previously did not spell out
the consequences for consumer handlers.

The README now has a `### At-least-once delivery — handlers must be idempotent`
section in Core concepts with the standard `processed_events`-table recipe.
Handlers whose side effects are not naturally idempotent must dedup themselves
until a first-class `IdempotencyStore` lands.

### Migration

- Drop the `id` field from any `publish({...})` call site.
- If you were relying on `id` correspondence between outbox rows and bus rows
  for tracing, switch to the `outboxId` + `busEventId` pair in the forwarder's
  `debug`-level "forwarded outbox entry" log line.
- Audit consumer handlers for replay-safety and add a `processed_events` table
  for any non-idempotent side effects.
