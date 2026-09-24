---
'@quilla-be-kit/http': minor
'@quilla-be-kit/persistence': patch
---

Derive validated-input types from the `@ValidateRequest` schema instead of a caller-asserted cast.

**Breaking (`http`):** `HttpRequest.getValidatedInput<T>()` is removed. Type the handler parameter as `ValidatedRequest<typeof Schema>` and call `getValidatedInput()` with no type argument; the return type is the schema's output (via the Standard Schema `~standard` marker). `@ValidateRequest` is now generic over the schema and rejects, at compile time, a handler annotated with a different schema's output. A schema without `~standard` yields `unknown`. Custom method decorators that wrap handlers must be generic over the request type (`<R extends HttpRequest>(method: (this: unknown, request: R) => ...)`), as `@AuthorizeScope` now is. Hand-rolled `HttpRequest` mocks must drop `getValidatedInput`. New type export: `ValidatedRequest`.

Reading `query.pageSize` when `tenantScopedListQuery` nests it under `query.pagination` is now a compile error. Runtime behavior is unchanged.

`persistence`: README example updated to the new `ValidatedRequest` pattern.
