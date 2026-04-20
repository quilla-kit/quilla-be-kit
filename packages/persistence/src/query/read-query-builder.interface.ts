import type { FilterQuery } from './filter-query.type.js';
import type { SqlStatement } from './sql-statement.type.js';

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

export interface ReadQueryBuilder {
  select<T>(opts: SelectOptions<T>): SqlStatement;
}
