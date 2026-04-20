import type { Database } from '../database/database.interface.js';
import type { FilterQuery } from '../query/filter-query.type.js';
import type { ReadQueryBuilder } from '../query/read-query-builder.interface.js';

/**
 * Read-side DAO. Projects database rows into read-model shapes.
 * Verb: `find*` — returns raw `TReadModel` from the replica. Does NOT
 * participate in write transactions.
 */
export abstract class BaseReadDao<TReadModel> {
  protected abstract readonly tableName: string;

  constructor(
    protected readonly db: Database,
    protected readonly queryBuilder: ReadQueryBuilder,
  ) {}

  async findOne(where: FilterQuery<TReadModel>): Promise<TReadModel | null> {
    const stmt = this.queryBuilder.select<TReadModel>({
      table: this.tableName,
      where,
      limit: 1,
    });
    const result = await this.db.query(stmt.text, stmt.params);
    return (result.rows[0] as TReadModel | undefined) ?? null;
  }

  async findMany(where: FilterQuery<TReadModel>): Promise<TReadModel[]> {
    const stmt = this.queryBuilder.select<TReadModel>({
      table: this.tableName,
      where,
    });
    const result = await this.db.query(stmt.text, stmt.params);
    return result.rows as TReadModel[];
  }

  async findAll(): Promise<TReadModel[]> {
    const stmt = this.queryBuilder.select<TReadModel>({
      table: this.tableName,
    });
    const result = await this.db.query(stmt.text, stmt.params);
    return result.rows as TReadModel[];
  }
}
