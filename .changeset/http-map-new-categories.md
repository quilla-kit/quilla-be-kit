---
'@quilla-be-kit/http': minor
---

Map the seven new error categories to HTTP statuses

`DefaultErrorResolver` now resolves `PaymentRequiredError` → 402,
`GoneError` → 410, `PreconditionFailedError` → 412, `RateLimitError` → 429,
`NotImplementedError` → 501, `UnavailableError` → 503, and `TimeoutError` →
504, alongside the existing seven. Subclasses inherit their category's
status, so an application error can get correct HTTP handling without
importing anything from this package.

This makes the `HttpStatusAware` brand added in 0.9.0 the escape hatch it was
meant to be rather than the primary extension point — the README now says so,
and steers you to a category first. The brand is unchanged and still outranks
the category table.

The category chain is also reordered by ascending status for readability. All
categories are direct `QuillaError` subclasses, so no resolution changes.
