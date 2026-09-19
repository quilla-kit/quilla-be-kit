---
'@quilla-be-kit/http': minor
---

Every JSON response `HonoServer` emits now goes through the configured conventions, and duplicate-route detection catches routes that differ only in parameter name.

- Unknown routes answer with the kit's error shape instead of falling through to Hono's plain-text default: a new `RouteNotFoundError` resolved through the configured `ErrorResolver`. It extends `NotFoundError` from `@quilla-be-kit/errors`, so it still maps to 404, and a custom resolver can `instanceof` it to distinguish an unmatched path from a handler reporting a missing entity. No new option — the error resolver is the customization seam. Unknown routes are not logged; a request for a path that doesn't exist is a client mistake, not a server error.
- Error bodies now go through the configured `ResponseSerializer`, including its `undefined` (bodyless) branch and `headers` forwarding, so a custom envelope applies to errors as well as successes. `DefaultResponseSerializer` passes `error` through unchanged, so the default wire shape is unchanged.
- `Router` duplicate detection keys on route **match shape** rather than literal path text: `/a/:id` and `/a/:claimId` now collide at construction instead of one silently shadowing the other. Parameter constraints remain part of the shape (`/:id{[0-9]+}` does not collide with `/:slug`), `*` and `:param` stay distinct, and the error names both declared paths and both declaration sites.
- Docs: `@ValidateRequest` merges its sources in array order with the last source winning — `['body', 'params']` lets a path id override a body field of the same name, `['params', 'body']` does the reverse.
