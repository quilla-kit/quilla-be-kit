---
"@quilla-kit/persistence": minor
---

Refactor `BaseReadDao` around a fluent `SqlQueryBuilder` plus a new
`/query-schema` sub-path for HTTP-query parsing. The old
`BaseReadDao<TReadModel>` with a fixed `tableName` forced one DAO per
read model — real read DAOs project over joins, views, and aggregates
and expose multiple query methods against different shapes.

**Breaking:** `BaseReadDao` is no longer generic over `TReadModel` and no
longer declares `tableName`. Constructor now takes an options object:
`{ adapter, builderFactory, columnResolver? }`. Query methods build SQL
through `this.qb<T>()` and hand the resulting `QueryProduct` to the
method-generic `findOne<T>(q)` / `findMany<T>(q)` / `findPaginated<T>(q,
page)`. A single subclass exposes any number of query methods over any
number of tables.

**New — core (`@quilla-kit/persistence`):**

- `SqlQueryBuilder<T>` interface: `.select / .from / .join / .groupBy /
  .where / .filters / .orderBy / .paginate / .build`. Immutable — each
  fluent call returns a new instance, so reuse is safe.
- Suffix-operator filter DSL with double-underscore delimiter:
  `__contains`, `__in`, `__notIn`, `__gt`, `__gte`, `__lt`, `__lte`,
  `__isNull`, `__isNotNull`. `undefined` values are skipped; unknown
  operators throw at build time.
- `ColumnResolver` interface + `DefaultColumnResolver` (camelCase →
  snake_case plus explicit overrides). Select-list columns are
  auto-aliased (`created_at AS "createdAt"`) so read models get domain
  vocabulary back from the DB without hand-written alias strings.
- `QueryProduct`, `PaginatedResult<T>`, `StandardListQuery<TFilters>`,
  `PaginationOptions`, `SortOption`, `FieldDescriptor` /
  `FieldDescriptorMap` / `OPERATORS_BY_KIND`.
- `ReadDbAdapter.raw<T>(sql, params)` — low-level escape hatch used by
  `BaseReadDao` to execute `QueryProduct`.

**New — postgres (`@quilla-kit/persistence/postgres`):**

- `PgSqlQueryBuilder` — Postgres implementation. `$N` placeholder
  rebasing, `DISTINCT ON`, `COUNT(*)` with GROUP BY subquery wrapping,
  identifier validation against `[a-zA-Z_][a-zA-Z0-9_]*` (plus `.` and
  optional `AS alias`) as defense-in-depth against SQL injection.

**New — query-schema (`@quilla-kit/persistence/query-schema`):**

- `createQueryParametersSchema(filterShape, { defaultPageSize?, maxPageSize?, strict? })`
  — Zod helper that takes a base filter shape and returns a full
  validation + transform schema producing `StandardListQuery<TFilters>`.
  Auto-expands the suffix DSL based on Zod field kinds; parses
  `?name__contains=...&sort=field:dir&page=2&pageSize=50` into the
  canonical form. Defaults to tolerant parsing (unknown keys stripped,
  bad sort entries dropped, invalid pagination falls back to defaults);
  pass `{ strict: true }` to surface unknown keys, unknown sort fields,
  bad sort directions, and invalid page/pageSize as `ZodError` issues.
  `maxPageSize` stays a clamp in both modes.
- `fieldDescriptorsFromZod(schema)` exposed for consumers building
  alternative validator adapters (Valibot, ArkType) against the same
  `FieldDescriptorMap` contract.
- `zod` added as an **optional** peer dep — required only when importing
  from this sub-path.

Divergences from the emigraly reference: immutable builder (emigraly
mutates `this`), output column auto-aliasing via the same resolver used
on input (emigraly hand-aliases per-select), `__` delimiter on the
filter DSL (emigraly uses single `_` which collides with field names
containing underscores), `__isNull` / `__isNotNull` operators added,
validator-agnostic output shape (`StandardListQuery<TFilters>`), and
identifier validation in every structured seam.
