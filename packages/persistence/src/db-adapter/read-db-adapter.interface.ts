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
  select<T>(opts: SelectOptions<T>): Promise<readonly T[]>;
}
