# @quilla-kit/execution-context

Per-operation execution context: `IExecutionContext`,
`IExecutionContextProvider`, AsyncLocalStorage-backed storage, factory, and a
logger enricher bridge to `@quilla-kit/observability`.

## Why this exists

The execution context carries the actor (who), scope (tenant / workspace /
project / whatever the consumer's isolation boundary is), and correlation
metadata (tracing) for a single logical operation. Persistence uses it to
populate audit fields (`inserted_by`, `updated_by`) without requiring callers
to pass them. Observability uses it to enrich every log line emitted during
the operation.

## Install

```sh
pnpm add @quilla-kit/execution-context
```

## Status

Interface surface not yet implemented — scaffolded only.
