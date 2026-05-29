---
"@quilla-be-kit/persistence": patch
---

Correct the qualified-column examples in the `SqlQueryBuilder` joins / groupBy sections and document the qualified-reference rule explicitly. The previous examples used camelCase column parts after the table qualifier (`o.createdAt`, `o.scopeId`), which contradicts the actual builder behavior: qualified references are passed through verbatim with no resolver lookup, so the emitted SQL referenced columns Postgres rejects. Examples now use snake_case after the qualifier (`o.created_at`, `o.scope_id`), and a callout makes the rule explicit — bare keys are domain vocabulary (resolved), qualified keys are SQL space (the consumer owns the column name). The asymmetry is silent at build time and surfaces only at query execution, so the README is where consumers need to learn it.
