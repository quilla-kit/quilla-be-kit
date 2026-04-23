---
"@quilla-kit/observability": minor
---

`Logger.withMeta(meta)` returns a child logger that merges `meta` into
every emitted entry's `meta` bucket. Chains with `forMethod` orthogonally
and composes across multiple `withMeta` calls. Per-call `params.meta`
wins on key collisions. Useful for per-handler or per-request annotation
(event id, correlation id, subject id) without threading through every
call site.
