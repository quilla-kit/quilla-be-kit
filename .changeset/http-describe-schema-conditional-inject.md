---
"@quilla-kit/http": minor
---

`@ValidateRequest` now injects `scopeId` and `userId` from the active
`ExecutionContext` **only when the schema declares those keys**. The
previous unconditional injection wrote the fields into every validated
payload regardless of schema shape — which worked by accident for
tolerant schemas (Zod silently stripped the extras) and broke strict
schemas outright (unknown keys rejected). Worse, it conflated "what
the schema represents" with "what the server happens to add on top,"
making the decorator's contract ambiguous.

New behavior:

- `RequestValidator` gains an optional `describeSchema(schema)` method
  returning `{ keys }` or `null`. When implemented, `@ValidateRequest`
  reads the top-level key list and injects only declared auth-derived
  fields.
- When `describeSchema` is absent or returns `null`, auth-injection is
  **skipped** — fail-safe: no surprise fields written into schemas that
  didn't ask for them.

**Consumer impact:**

Consumers with command DTOs that declare `scopeId` / `userId` and rely
on auto-injection now need to add `describeSchema` to their
`RequestValidator` wrapper (a 3–5 line addition for Zod; see the
updated README). Without it, command DTOs land with `scopeId: undefined`
at the handler — a loud failure rather than a silent miss, which is
the intent.

Consumers whose schemas don't declare `scopeId` / `userId` see no
behavior change (injection was always a silent no-op for them, and
now is explicitly so).

The updated Zod adapter in the README handles `ZodObject` (direct key
enumeration) and unwraps `ZodPipe` (produced by `.transform(...)`)
until it reaches a `ZodObject` — so schemas produced by
`createQueryParametersSchema` (a transform over an object) are
introspected correctly and auth-derived extras are injected when
declared via the new `extraFields` option in
`@quilla-kit/persistence/query-schema`.

**New: out-of-the-box Zod adapter.** `@quilla-kit/http/validator/zod`
exports `createZodRequestValidator({ extractIssues? })` — a drop-in
`RequestValidator` implementation for Zod 4 with the `ZodPipe` unwrap
logic baked in. Avoids every consumer re-writing the same ~15 lines,
and guarantees the unwrap chain matches what
`createQueryParametersSchema` emits. `zod` is an optional peer dep of
`@quilla-kit/http` — required only when importing from the
`/validator/zod` sub-path.
