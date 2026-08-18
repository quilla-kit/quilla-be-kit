---
'@quilla-be-kit/http': minor
---

Add `HttpStatusAware` so an error can declare its own HTTP status

`DefaultErrorResolver` previously mapped errors to statuses with a closed
`instanceof` chain over the eight `@quilla-be-kit/errors` categories, so a
custom error outside that hierarchy silently resolved to 500 unless you
replaced the whole resolver.

Errors can now opt in by implementing `HttpStatusAware` — a
`Symbol.for('quilla-be-kit.http.status')`-keyed brand that outranks the
category table:

```ts
export class GoneError extends QuillaError implements HttpStatusAware {
  readonly code: string = 'GONE';
  readonly [HTTP_STATUS] = 410;
}
```

The brand is a symbol rather than a plain `httpCode` field so it can only be
set deliberately: an error carrying an unrelated `httpCode` (an
`ExternalError` subclass storing the upstream's status, say) keeps its
category status instead of leaking that number to your clients. A branded
value outside 100–599 or a non-integer is ignored rather than emitted.

The category table is unchanged and still applies to unbranded errors,
including subclasses, so `@ValidateRequest` → 400, `@AuthorizeScope` → 403,
and the `security` middleware → 401 all behave exactly as before. Purely
additive; `@quilla-be-kit/errors` gains no HTTP vocabulary.

Exports: `HTTP_STATUS`, `HttpStatusAware`, `getDeclaredHttpStatus`.
