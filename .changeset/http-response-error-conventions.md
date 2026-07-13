---
'@quilla-be-kit/http': minor
---

Make the HTTP error and success/envelope wire shapes consumer-overridable.

`HonoServerOptions` gains an optional `conventions` facade holding two injectable strategies:

- `errorResolver` (`ErrorResolver` interface) — controls the error status + body shape.
- `responseSerializer` (`ResponseSerializer` interface) — controls the JSON success/envelope
  body (including `metadata.pagination` remapping).

Omitting `conventions` preserves the current wire shape byte-for-byte via `DefaultErrorResolver`
and `DefaultResponseSerializer`.

The `error` barrel is now re-exported from the package root, so `ErrorResolver`,
`DefaultErrorResolver`, and `ResolvedHttpError` are importable from `@quilla-be-kit/http`
alongside `ResponseSerializer`, `DefaultResponseSerializer`, and `HttpConventions`.

BREAKING (source): the free function `resolveHttpError` is removed in favor of
`DefaultErrorResolver`. Replace `resolveHttpError(err)` with
`new DefaultErrorResolver().resolve(err)`. The `ResolvedHttpError` type is unchanged and still
exported.
