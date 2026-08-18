---
"@quilla-be-kit/execution-context": minor
"@quilla-be-kit/observability": minor
---

Add `executionAttemptId` to `ExecutionContext`, identifying a single physical attempt at an operation, distinct from `correlationId` (which identifies the logical operation and can span retries). All three `ExecutionContextFactory` methods now mint a fresh `executionAttemptId` per call — it is never accepted as caller input, so a retried operation reusing the same `correlationId` still gets a distinct `executionAttemptId` per attempt. `ExecutionContextEnricher` now includes `executionAttemptId` on every log line alongside `correlationId`.

**Breaking for `@quilla-be-kit/execution-context`:** `executionAttemptId` is a required field on `ExecutionContext`. Any consumer that hand-constructs an `ExecutionContext` object literal directly (rather than via `executionContextFactory` or by spreading an existing context) must add this field.

`@quilla-be-kit/observability`'s `LogContext` gains an optional `executionAttemptId` field to carry the new context field into log entries — additive, non-breaking.
