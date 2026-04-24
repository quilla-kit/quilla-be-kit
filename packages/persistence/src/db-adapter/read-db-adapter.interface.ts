import type { FilterQuery } from './filter-query.type.js';

export type OrderBy = {
  readonly column: string;
  readonly direction: 'asc' | 'desc';
};

export type SelectOptions<T> = {
  readonly table: string;
  readonly columns?: readonly string[];
  readonly where?: FilterQuery<T>;
  readonly limit?: number;
  readonly orderBy?: readonly OrderBy[];
};

/**
 * Read-side adapter. Pure query side — never participates in write
 * transactions. Builds SELECT statements and executes them against the
 * (replica) connection.
 *
 * See `WriteDbAdapter.findForUpdate` for reads that must happen inside
 * a write transaction.
 */
export interface ReadDbAdapter {
  /**
   * Structured single-table SELECT. Use for simple `WHERE = / WHERE IN`
   * projections; reach for `raw()` or a `SqlQueryBuilder` when you need
   * joins, aggregates, or operator-rich filters.
   */
  select<T>(opts: SelectOptions<T>): Promise<readonly T[]>;

  /**
   * Execute a pre-built SQL statement with positional parameters. The
   * adapter does not inspect or modify the SQL — callers are responsible
   * for parameterising every value. `BaseReadDao.findOne` / `findMany` /
   * `findPaginated` invoke this to run `QueryProduct` output from a
   * `SqlQueryBuilder`.
   */
  raw<T>(sql: string, params: readonly unknown[]): Promise<readonly T[]>;
}
