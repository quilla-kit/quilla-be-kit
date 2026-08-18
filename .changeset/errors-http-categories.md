---
'@quilla-be-kit/errors': minor
---

Add seven transport-neutral error categories

`GoneError`, `PreconditionFailedError`, `PaymentRequiredError`,
`RateLimitError`, `NotImplementedError`, `UnavailableError`, and
`TimeoutError` join the existing eight.

Every one carries meaning outside HTTP — a messaging consumer's retry policy
can treat `TimeoutError`, `UnavailableError`, and `RateLimitError` as
retriable and `GoneError` or `PaymentRequiredError` as terminal, with no
transport involved. Categories whose only meaning is protocol mechanics
(405, 406, 415, …) deliberately stay out of this package; they belong to
whichever transport emits them.

The point is reuse: an application error can now extend a shared category and
get consistent handling everywhere, instead of each consumer teaching its own
transport layer about its own error classes.

```ts
export class ResourceRetiredError extends GoneError {
  override readonly code: string = 'RESOURCE_RETIRED';
}
```

Purely additive — no existing category, code, or behavior changes.
