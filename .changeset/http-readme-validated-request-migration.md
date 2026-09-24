---
'@quilla-be-kit/http': patch
---

README: document routes without `@ValidateRequest` (they keep a plain `HttpRequest`; `getValidatedInput` is a compile error there) and add a migration guide from `getValidatedInput<T>()` to `ValidatedRequest<typeof Schema>`.
