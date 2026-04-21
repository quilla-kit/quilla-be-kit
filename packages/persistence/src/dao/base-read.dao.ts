import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { ReadDbAdapter } from '../db-adapter/read-db-adapter.interface.js';

/**
 * Read-side DAO. Projects database rows into read-model shapes. Never
 * participates in write transactions — its API has no `trx` parameter.
 *
 * Verb: `find*` — returns raw `TReadModel` from the read connection.
 */
export abstract class BaseReadDao<TReadModel> {
  protected abstract readonly tableName: string;

  constructor(protected readonly adapter: ReadDbAdapter) {}

  async findOne(where: FilterQuery<TReadModel>): Promise<TReadModel | null> {
    const rows = await this.adapter.select<TReadModel>({
      table: this.tableName,
      where,
      limit: 1,
    });
    return rows[0] ?? null;
  }

  async findMany(where: FilterQuery<TReadModel>): Promise<readonly TReadModel[]> {
    return this.adapter.select<TReadModel>({
      table: this.tableName,
      where,
    });
  }

  async findAll(): Promise<readonly TReadModel[]> {
    return this.adapter.select<TReadModel>({ table: this.tableName });
  }
}
