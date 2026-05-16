---
"@quilla-be-kit/observability": minor
"@quilla-be-kit/messaging": minor
---

`LoggerConfig.service` identifies the emitting service (microservice,
backend, worker) on every log entry. Surfaces as a first-class top-level
field in JSON output and as a `[service]` bracket in pretty output,
preceding the module label. Propagates through `forMethod` and
`withMeta` child loggers.

Pretty format goes from `[module::location]` to
`[service] [module::location]`.

Messaging adapters no longer double-stamp their class name on the
caller-provided logger: `OutboxForwarder` takes the logger as-is, and
`EventConsumer` places its per-instance `consumerName` into the `meta`
bucket (via `withMeta`) rather than in the location label — keeping
`module` cleanly owned by the caller.
