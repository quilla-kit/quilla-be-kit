import type { PaginationOptions, SortOption } from './list-query.type.js';
import type { QueryProduct } from './query-product.type.js';

export type OrderByOptions = {
  readonly defaults?: readonly SortOption[];
  readonly enforced?: readonly SortOption[];
};

export type PaginateOptions = PaginationOptions & {
  readonly distinctOn?: readonly string[];
};

/**
 * Fluent SQL builder for read-side queries. Implementations are immutable:
 * every chained call returns a new builder instance, so a base builder
 * can be forked without accidental state sharing.
 *
 * Column names passed to `select` / `groupBy` / `orderBy` / `filters` are
 * resolved through the builder's configured `ColumnResolver` (domain key
 * → DB column). Raw strings passed to `from`, `join`, and `where` are
 * emitted verbatim — the builder validates identifiers in the structured
 * seams (select/filters/etc.) but trusts raw clauses.
 *
 * Identifiers passed to `from`, `join`, `groupBy`, and inside `select`
 * column lists are validated against a strict identifier regex
 * (`[a-zA-Z_][a-zA-Z0-9_]*`, with `.` permitted for `table.column` and
 * optional `AS alias` suffixes). This is defense-in-depth: user input
 * must never reach these seams — it flows through `.where(sql, ...params)`
 * or `.filters({...})`, both of which parameterise.
 */
export interface SqlQueryBuilder<TRow = unknown> {
  /**
   * Project columns. Column names are domain-keyed (camelCase); the
   * builder emits `db_col AS "domainKey"` when the resolved column
   * differs from the domain key, so read models receive the domain
   * vocabulary. Accepts already-qualified expressions (`table.col`) too.
   */
  select(columns: readonly string[]): SqlQueryBuilder<TRow>;

  /**
   * Target table. Validated as an identifier; accepts `schema.table`.
   */
  from(table: string): SqlQueryBuilder<TRow>;

  /**
   * Raw JOIN clause, emitted verbatim. Use parameterised `where` for
   * conditions that depend on runtime values.
   */
  join(clause: string): SqlQueryBuilder<TRow>;

  /**
   * GROUP BY — domain-keyed column list, resolved the same way as
   * `select`.
   */
  groupBy(columns: readonly string[]): SqlQueryBuilder<TRow>;

  /**
   * Add a raw WHERE fragment with positional `?` placeholders. Each
   * call is ANDed with previous conditions.
   *
   * @example
   * .where('deleted_at IS NULL')
   * .where('tags @> ?::jsonb', JSON.stringify(['urgent']))
   */
  where(condition: string, ...params: readonly unknown[]): SqlQueryBuilder<TRow>;

  /**
   * Structured filters using the suffix-operator DSL. The delimiter is
   * double-underscore (`__`):
   *
   * - `field` → equality (`=`, or `IS NULL` if value is `null`)
   * - `field__contains` → `ILIKE '%value%'` (string fields)
   * - `field__in` / `field__notIn` → `= ANY($n)` / `<> ALL($n)`
   * - `field__gt` / `__gte` / `__lt` / `__lte` → comparators
   * - `field__isNull` / `field__isNotNull` → boolean-valued
   *
   * Field keys are domain-vocabulary (camelCase); the resolver
   * translates to DB columns at build time.
   *
   * Each key in the map contributes one ANDed predicate. Calling
   * `.filters()` multiple times merges (later keys override earlier
   * ones for the same key).
   *
   * Undefined values are skipped — a filter key with `undefined`
   * contributes nothing (so `filters({ foo: opts.foo })` works when
   * `opts.foo` is optional).
   */
  filters(filters: Readonly<Record<string, unknown>>): SqlQueryBuilder<TRow>;

  /**
   * ORDER BY. Accepts the `[{ field: 'asc' }, { other: 'desc' }]` form.
   * `enforced` options are always applied (e.g. tenant-first secondary
   * sort); `defaults` apply only when user sort is empty.
   */
  orderBy(sort: readonly SortOption[] | undefined, options?: OrderByOptions): SqlQueryBuilder<TRow>;

  /**
   * LIMIT / OFFSET pagination. When present, `.build()` emits a
   * `countSql` alongside `sql` so `findPaginated` can resolve total
   * rows with the same parameters.
   */
  paginate(options: PaginateOptions): SqlQueryBuilder<TRow>;

  /**
   * Emit the final SQL + params. Result is a `QueryProduct` ready to
   * hand to `BaseReadDao.findOne` / `findMany` / `findPaginated`.
   */
  build(): QueryProduct;
}
