# @quilla-kit/messaging

Messaging infrastructure interfaces: `IEventBus`, `IEventConsumer`,
`ILocalOutbox`, `EventSubscriptionBuilder`, `OutboxForwarder`.

The *event types* being moved across the bus (`DomainEvent`, `IntegrationEvent`,
`EventMetadata`) live in [`@quilla-kit/ddd`](../ddd). This package is the
*plumbing* that dispatches them.

Broker drivers (Postgres LISTEN/NOTIFY, Redis Streams, Kafka, etc.) are out of
scope for this package; concrete adapters implement `IEventBus` and
`ILocalOutbox` in consumer projects.

## Install

```sh
pnpm add @quilla-kit/messaging
```

## Status

Interface surface not yet implemented — scaffolded only.
