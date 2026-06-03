---
'@quilla-be-kit/persistence': minor
---

Add `'enum'` field kind to `createQueryParametersSchema`.

`z.enum(...)` fields in a filter shape were silently dropped from the generated
parameter schema, causing `strict: true` to reject any query param that used an
enum field (e.g. `?status=ACTIVE` → `ValidationError`). Base (no-filter)
requests passed; filter-pill requests did not.

The fix introduces a first-class `'enum'` kind in `FieldKind` and
`OPERATORS_BY_KIND` with operators `['in', 'notIn', 'isNull', 'isNotNull']`.
`__contains` is intentionally excluded — substring match against a fixed-value
set is semantically wrong, and the `'enum'` kind makes that explicit rather than
silently allowing it through the `'string'` bucket.
