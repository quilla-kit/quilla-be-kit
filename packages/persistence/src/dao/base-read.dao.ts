import type { ReadDbAdapter } from '../db-adapter/read-db-adapter.interface.js';
import type { ColumnResolver } from '../query/column-resolver.interface.js';
import { DefaultColumnResolver } from '../query/default.resolver.js';
import type { PaginationOptions } from '../query/list-query.type.js';
import type { PaginatedResult } from '../query/paginated-result.type.js';
import type { QueryProduct } from '../query/query-product.type.js';
import type { SqlQueryBuilder } from '../query/sql-query-builder.interface.js';

export type SqlQueryBuilderFactory = (columnResolver: ColumnResolver) => SqlQueryBuilder<unknown>;

export type BaseReadDaoOptions = {
  readonly adapter: ReadDbAdapter;
  readonly builderFactory: SqlQueryBuilderFactory;
  readonly columnResolver?: ColumnResolver;
};

/**
 * Read-side DAO. Reads raw rows via a `SqlQueryBuilder` and returns
 * them to the caller. Never participates in write transactions — no
 * `trx` parameter anywhere in its API.
 *
 * Subclass and add per-query methods; use `this.qb<T>()` to start a
 * new builder, then hand the built `QueryProduct` to `findOne`,
 * `findMany`, or `findPaginated`. A single subclass can expose any
 * number of queries over any number of tables — read DAOs are
 * projection-driven, not table-driven.
 */
export abstract class BaseReadDao {
  protected readonly adapter: ReadDbAdapter;
  protected readonly columnResolver: ColumnResolver;
  private readonly builderFactory: SqlQueryBuilderFactory;

  constructor(options: BaseReadDaoOptions) {
    this.adapter = options.adapter;
    this.builderFactory = options.builderFactory;
    this.columnResolver = options.columnResolver ?? new DefaultColumnResolver();
  }

  /**
   * Start a new query. Returns a fresh builder pre-bound to the DAO's
   * `ColumnResolver`, so domain-keyed columns flow through to the
   * emitted SQL automatically.
   */
  protected qb<TRow>(): SqlQueryBuilder<TRow> {
    return this.builderFactory(this.columnResolver) as SqlQueryBuilder<TRow>;
  }

  /**
   * Execute a built query and return at most one row.
   */
  protected async findOne<TRow>(query: QueryProduct): Promise<TRow | null> {
    const rows = await this.adapter.raw<TRow>(query.sql, query.params);
    return rows[0] ?? null;
  }

  /**
   * Execute a built query and return all rows.
   */
  protected async findMany<TRow>(query: QueryProduct): Promise<readonly TRow[]> {
    return this.adapter.raw<TRow>(query.sql, query.params);
  }

  /**
   * Execute a paginated query. The `QueryProduct` must include a
   * `countSql` (produced automatically by `SqlQueryBuilder.paginate`).
   * Runs the data and count queries in parallel on the read pool.
   */
  protected async findPaginated<TRow>(
    query: QueryProduct,
    page: PaginationOptions,
  ): Promise<PaginatedResult<TRow>> {
    if (!query.countSql) {
      throw new Error(
        'findPaginated requires query.countSql; call .paginate(...) on the builder before .build()',
      );
    }
    const [rows, countRows] = await Promise.all([
      this.adapter.raw<TRow>(query.sql, query.params),
      this.adapter.raw<{ count: string | number }>(query.countSql, query.params),
    ]);
    const total = Number(countRows[0]?.count ?? 0);
    return {
      rows,
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }
}
