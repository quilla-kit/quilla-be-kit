import type { FilterQuery } from './filter-query.type.js';
import type { SqlStatement } from './sql-statement.type.js';

export type OptimisticLock = {
  readonly column: string;
  readonly expected: unknown;
};

export type InsertOptions = {
  readonly table: string;
  readonly rows: readonly Record<string, unknown>[];
  readonly returning?: readonly string[];
};

export type UpdateOptions<T> = {
  readonly table: string;
  readonly set: Record<string, unknown>;
  readonly where: FilterQuery<T>;
  readonly optimisticLock?: OptimisticLock;
  readonly returning?: readonly string[];
};

export type DeleteOptions<T> = {
  readonly table: string;
  readonly where: FilterQuery<T>;
};

export type SelectForUpdateOptions<T> = {
  readonly table: string;
  readonly columns?: readonly string[];
  readonly where: FilterQuery<T>;
};

export interface WriteQueryBuilder {
  insert(opts: InsertOptions): SqlStatement;
  update<T>(opts: UpdateOptions<T>): SqlStatement;
  delete<T>(opts: DeleteOptions<T>): SqlStatement;
  selectForUpdate<T>(opts: SelectForUpdateOptions<T>): SqlStatement;
}
