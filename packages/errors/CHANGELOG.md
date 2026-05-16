# @quilla-be-kit/errors

## 0.2.1

### Patch Changes

- 30c8333: test: smoke-test CI release via Trusted Publishers (OIDC) across all packages

## 0.2.0

### Minor Changes

- 6ce0a43: Initial public surface: `QuillaError` abstract base and seven category
  classes (`ValidationError`, `NotFoundError`, `ConflictError`,
  `UnauthorizedError`, `ForbiddenError`, `InternalError`, `ExternalError`),
  plus `UnknownError` extending `InternalError`.

  Key design decisions:

  - **Transport-agnostic.** No `httpCode`, no `toHttpResponse()`. The HTTP
    mapping lives in `@quilla-be-kit/http`; this package stays usable from jobs,
    CLIs, workers, anywhere errors need a uniform shape.
  - **`code` is immutable per class**, not a constructor arg. Category classes
    ship a default code (`'NOT_FOUND'`, `'CONFLICT'`, etc.); leaf subclasses
    override via `override readonly code = '…'`. Callers cannot vary the code
    per throw site — it's a property of the type.
  - **Cross-realm-safe brand.** `QuillaError.is(e)` uses
    `Symbol.for('quilla-be-kit.error')` so duplicate package copies (peer-dep
    drift, bundler quirks) still identify toolkit errors correctly. Category
    classification stays `instanceof`-based — downstream packages should
    declare `@quilla-be-kit/errors` as a `peerDependency` to keep that reliable.
  - **No `type` / `category` string field.** Class hierarchy _is_ the
    classification; consumers don't branch on string literals. `instanceof`
    gives inheritance-aware matching for free (a `CrossScopeAccessError`
    matches `instanceof NotFoundError`).
  - **No normalize helper.** Wrapping unknown throws is a boundary concern
    that lives in the HTTP error handler (`@quilla-be-kit/http`), not a generic
    utility exported here.
  - **Native `cause` passthrough** via the ES2022 `Error({ cause })` option,
    plus a `context?: Record<string, unknown>` field for structured,
    log-safe metadata.
  - **`toJSON()`** emits `{ name, code, message, context?, cause? }` — safe
    for structured logging without accidentally leaking non-serializable
    state.
  - **Single `message` field**, always safe to show end users. Internal debug
    strings belong in `context`. No split between `message` / `clientDetails`.
