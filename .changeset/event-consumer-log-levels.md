---
"@quilla-kit/messaging": minor
---

`EventConsumer.start()` splits its one info entry into two: the info
log carries scalar fields (`pollIntervalMs`, `batchSize`,
`registeredTypeCount`, `instanceId`) and the full `registeredTypes`
list moves to debug. Keeps info-stream meta payloads bounded even when
a consumer has many handler registrations.

`EventConsumer.registeredEventTypes` (readonly getter) exposes the
registered event-type names for health checks and tests without
parsing logs.

`OutboxForwarder.tick()` emits `forwarding N event(s)` at debug
instead of info — it fires on every tick with pending events and was
flooding info streams in services with continuous outbox traffic.
Info remains reserved for lifecycle transitions (`starting`,
`stopped`) and errors/warnings for anomalies.
