import type { ColumnResolver } from '../query/column-resolver.interface.js';
import type { SortOption } from '../query/list-query.type.js';
import type { QueryProduct } from '../query/query-product.type.js';
import type {
  FromTarget,
  OrderByOptions,
  PaginateOptions,
  SqlQueryBuilder,
} from '../query/sql-query-builder.interface.js';
import {
  type IdentifierQuoter,
  NO_QUOTING,
  QUOTED,
  buildFilterClause,
  parseFilterKey,
} from './pg-sql.js';

const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const QUALIFIED_IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/;
// `table` or `schema.table` or `table alias` or `table AS alias`.
const FROM_RE =
  /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?(\s+(AS\s+)?[a-zA-Z_][a-zA-Z0-9_]*)?$/i;
const ALIAS_RE = /^(.+?)\s+AS\s+"([a-zA-Z_][a-zA-Z0-9_]*)"$/i;
const STAR_RE = /^([a-zA-Z_][a-zA-Z0-9_]*\.)?\*$/;

type BuilderState = {
  readonly columns: readonly string[];
  readonly table: string | null;
  readonly joins: readonly string[];
  readonly groupBys: readonly string[];
  readonly rawConditions: readonly { readonly sql: string; readonly params: readonly unknown[] }[];
  readonly filterMap: Readonly<Record<string, unknown>>;
  readonly sort: readonly SortOption[] | null;
  readonly sortOptions: OrderByOptions | null;
  readonly pagination: PaginateOptions | null;
};

const EMPTY_STATE: BuilderState = {
  columns: [],
  table: null,
  joins: [],
  groupBys: [],
  rawConditions: [],
  filterMap: {},
  sort: null,
  sortOptions: null,
  pagination: null,
};

export type PgSqlQueryBuilderOptions = {
  readonly quoteIdentifiers?: boolean;
};

export class PgSqlQueryBuilder<TRow = unknown> implements SqlQueryBuilder<TRow> {
  private readonly quoter: IdentifierQuoter;

  constructor(
    private readonly resolver: ColumnResolver,
    private readonly options: PgSqlQueryBuilderOptions = {},
    private readonly state: BuilderState = EMPTY_STATE,
  ) {
    this.quoter = options.quoteIdentifiers ? QUOTED : NO_QUOTING;
  }

  select(columns: readonly string[]): SqlQueryBuilder<TRow> {
    for (const c of columns) validateSelectColumn(c);
    return this.fork({ columns: [...columns] });
  }

  from(target: string | FromTarget): SqlQueryBuilder<TRow> {
    if (typeof target === 'string') {
      if (!FROM_RE.test(target)) {
        throw new Error(
          `SqlQueryBuilder.from: invalid identifier ${JSON.stringify(target)}. Accepts "table", "schema.table", "table alias", or "table AS alias".`,
        );
      }
      return this.fork({ table: target });
    }
    // Parts are already separated, so each is quoted on its own — unlike
    // `QUOTED.table`, which has to split `schema.table` out of one string.
    const name =
      target.schema !== undefined
        ? `${this.fromIdentifier(target.schema)}.${this.fromIdentifier(target.table)}`
        : this.fromIdentifier(target.table);
    const table =
      target.alias !== undefined ? `${name} AS ${this.fromIdentifier(target.alias)}` : name;
    return this.fork({ table });
  }

  private fromIdentifier(value: string): string {
    if (!this.options.quoteIdentifiers && !IDENT_RE.test(value)) {
      throw new Error(
        `SqlQueryBuilder.from: invalid identifier ${JSON.stringify(value)}. Without quoteIdentifiers, each part must match ${IDENT_RE}.`,
      );
    }
    return this.quoter.column(value);
  }

  join(clause: string): SqlQueryBuilder<TRow> {
    return this.fork({ joins: [...this.state.joins, clause] });
  }

  groupBy(columns: readonly string[]): SqlQueryBuilder<TRow> {
    for (const c of columns) validateQualifiedIdentifier(c, 'groupBy');
    return this.fork({ groupBys: [...this.state.groupBys, ...columns] });
  }

  where(condition: string, ...params: readonly unknown[]): SqlQueryBuilder<TRow> {
    return this.fork({
      rawConditions: [...this.state.rawConditions, { sql: condition, params }],
    });
  }

  filters(filters: Readonly<Record<string, unknown>>): SqlQueryBuilder<TRow> {
    const merged = { ...this.state.filterMap };
    for (const [k, v] of Object.entries(filters)) {
      if (v === undefined) continue;
      merged[k] = v;
    }
    return this.fork({ filterMap: merged });
  }

  orderBy(
    sort: readonly SortOption[] | undefined,
    options?: OrderByOptions,
  ): SqlQueryBuilder<TRow> {
    return this.fork({
      sort: sort ? [...sort] : null,
      sortOptions: options ?? null,
    });
  }

  paginate(options: PaginateOptions): SqlQueryBuilder<TRow> {
    return this.fork({ pagination: options });
  }

  build(): QueryProduct {
    if (!this.state.table) {
      throw new Error('SqlQueryBuilder.build: .from(table) is required');
    }

    const params: unknown[] = [];
    const columnsSql = this.buildColumnsSql();
    const { whereSql } = this.buildWhereSql(params);

    let sql = `SELECT ${columnsSql} FROM ${this.state.table}`;
    for (const j of this.state.joins) sql += ` ${j}`;
    if (whereSql) sql += ` WHERE ${whereSql}`;
    if (this.state.groupBys.length > 0) {
      sql += ` GROUP BY ${this.state.groupBys.map((c) => this.resolveOrPassThrough(c)).join(', ')}`;
    }

    const orderSql = this.buildOrderSql();
    if (orderSql) sql += ` ORDER BY ${orderSql}`;

    let countSql: string | undefined;
    if (this.state.pagination) {
      const { page, pageSize, distinctOn } = this.state.pagination;
      if (distinctOn?.length) {
        const distinctCols = distinctOn.map((c) => this.resolveOrPassThrough(c)).join(', ');
        sql = sql.replace(/^SELECT /, `SELECT DISTINCT ON (${distinctCols}) `);
      }
      const offset = Math.max(0, (page - 1) * pageSize);
      sql += ` LIMIT ${pageSize} OFFSET ${offset}`;
      countSql = this.buildCountSql(whereSql);
    }

    return countSql !== undefined ? { sql, countSql, params } : { sql, params };
  }

  private fork(patch: Partial<BuilderState>): PgSqlQueryBuilder<TRow> {
    return new PgSqlQueryBuilder<TRow>(this.resolver, this.options, { ...this.state, ...patch });
  }

  private buildColumnsSql(): string {
    if (this.state.columns.length === 0) return '*';
    return this.state.columns.map((c) => this.projectColumn(c)).join(', ');
  }

  private projectColumn(column: string): string {
    if (STAR_RE.test(column)) return column;
    if (ALIAS_RE.test(column)) return column;
    if (column.includes('.')) {
      validateQualifiedIdentifier(column, 'select');
      return column;
    }
    if (!IDENT_RE.test(column)) {
      throw new Error(
        `SqlQueryBuilder.select: invalid column expression ${JSON.stringify(column)}. Use a plain identifier, a qualified "table.col", "*", or pre-aliased "expr AS \\"name\\"".`,
      );
    }
    const resolved = this.resolver.resolve(column);
    const rendered = this.quoter.column(resolved);
    // The alias is always quoted, whatever the quoter: unquoted, Postgres
    // folds `AS createdAt` to `createdat` and the domain key stops round-tripping.
    return resolved === column ? rendered : `${rendered} AS ${QUOTED.column(column)}`;
  }

  private resolveOrPassThrough(key: string): string {
    if (key.includes('.') || !IDENT_RE.test(key)) {
      validateQualifiedIdentifier(key, 'column reference');
      return key;
    }
    return this.quoter.column(this.resolver.resolve(key));
  }

  private buildWhereSql(params: unknown[]): { whereSql: string } {
    const fragments: string[] = [];

    for (const [rawKey, value] of Object.entries(this.state.filterMap)) {
      const fragment = this.filterFragment(rawKey, value, params);
      if (fragment) fragments.push(fragment);
    }

    for (const raw of this.state.rawConditions) {
      fragments.push(rebaseQuestionMarks(raw.sql, params, raw.params));
    }

    return { whereSql: fragments.join(' AND ') };
  }

  private filterFragment(rawKey: string, value: unknown, params: unknown[]): string {
    const { field, operator, hadSuffix } = parseFilterKey(rawKey);
    const isBareIdent = IDENT_RE.test(field);
    // Only suffixed keys are field-name-validated here: a bare key (no
    // `__operator`) may be a dotted qualified reference, which
    // `validateQualifiedIdentifier` below already validates on its own terms.
    if (hadSuffix && !isBareIdent) {
      throw new Error(`SqlQueryBuilder.filters: invalid field name "${field}" in key "${rawKey}".`);
    }
    // Reuses `isBareIdent` instead of calling `resolveOrPassThrough` (which
    // would re-run the same `IDENT_RE` test internally).
    if (!isBareIdent) {
      validateQualifiedIdentifier(field, 'column reference');
    }
    const column = isBareIdent ? this.quoter.column(this.resolver.resolve(field)) : field;
    return buildFilterClause(column, operator, value, (v) => pushParam(params, v));
  }

  private buildOrderSql(): string {
    const { sort, sortOptions } = this.state;
    const enforced = sortOptions?.enforced ?? [];
    const defaults = sortOptions?.defaults ?? [];
    const user = sort ?? [];

    const effective = user.length > 0 ? [...enforced, ...user] : [...enforced, ...defaults];
    if (effective.length === 0) return '';

    const clauses: string[] = [];
    for (const entry of effective) {
      for (const [field, direction] of Object.entries(entry)) {
        const column = this.resolveOrPassThrough(field);
        const dir = direction === 'desc' ? 'DESC' : 'ASC';
        clauses.push(`${column} ${dir}`);
      }
    }
    return clauses.join(', ');
  }

  private buildCountSql(whereSql: string): string {
    // If GROUP BY is present, count must be over the grouped set.
    if (this.state.groupBys.length > 0) {
      let inner = `SELECT 1 FROM ${this.state.table}`;
      for (const j of this.state.joins) inner += ` ${j}`;
      if (whereSql) inner += ` WHERE ${whereSql}`;
      inner += ` GROUP BY ${this.state.groupBys
        .map((c) => this.resolveOrPassThrough(c))
        .join(', ')}`;
      return `SELECT COUNT(*)::bigint AS count FROM (${inner}) AS _grouped`;
    }
    let sql = `SELECT COUNT(*)::bigint AS count FROM ${this.state.table}`;
    for (const j of this.state.joins) sql += ` ${j}`;
    if (whereSql) sql += ` WHERE ${whereSql}`;
    return sql;
  }
}

function pushParam(params: unknown[], value: unknown): string {
  params.push(value);
  return `$${params.length}`;
}

function rebaseQuestionMarks(
  sql: string,
  targetParams: unknown[],
  sourceParams: readonly unknown[],
): string {
  let i = 0;
  const rebased = sql.replace(/\?/g, () => {
    if (i >= sourceParams.length) {
      throw new Error(
        `SqlQueryBuilder.where: more "?" placeholders than parameters in fragment ${JSON.stringify(sql)}`,
      );
    }
    targetParams.push(sourceParams[i]);
    i++;
    return `$${targetParams.length}`;
  });
  if (i < sourceParams.length) {
    throw new Error(
      `SqlQueryBuilder.where: more parameters than "?" placeholders in fragment ${JSON.stringify(sql)}`,
    );
  }
  return rebased;
}

function validateSelectColumn(column: string): void {
  if (STAR_RE.test(column)) return;
  if (ALIAS_RE.test(column)) return;
  if (QUALIFIED_IDENT_RE.test(column)) return;
  throw new Error(
    `SqlQueryBuilder.select: invalid column expression ${JSON.stringify(column)}. Use a plain identifier, a qualified "table.col", "*", or pre-aliased "expr AS \\"name\\"".`,
  );
}

function validateQualifiedIdentifier(value: string, context: string): void {
  if (!QUALIFIED_IDENT_RE.test(value)) {
    throw new Error(
      `SqlQueryBuilder.${context}: invalid identifier ${JSON.stringify(value)}. Must match /^[a-zA-Z_][a-zA-Z0-9_]*(\\.[a-zA-Z_][a-zA-Z0-9_]*)?$/.`,
    );
  }
}
