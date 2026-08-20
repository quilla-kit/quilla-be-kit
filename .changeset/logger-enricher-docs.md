---
'@quilla-be-kit/observability': patch
'@quilla-be-kit/execution-context': patch
---

Document the logger enricher seam.

`@quilla-be-kit/observability` gains an "Enrichers" README section (contract,
custom-enricher example, `context` vs `extra`, merge order, per-emit timing)
and a `src/logger/README.md` internals doc covering the full emit pipeline.
The `LogContext` bullet now lists `executionAttemptId`.

`@quilla-be-kit/execution-context` enumerates the fields
`ExecutionContextEnricher` actually contributes, and its quick-start snippet
now passes the required `service` on `LoggerConfig`.
