import type { ExecutionContextProvider } from '@quilla-kit/execution-context';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import { OptimisticLockError } from '../errors/optimistic-lock.error.js';
import type { FilterQuery } from '../query/filter-query.type.js';
import type { WriteQueryBuilder } from '../query/write-query-builder.interface.js';

const INSERT_EXCLUDED_KEYS = new Set(['created_at', 'updated_at']);
const UPDATE_EXCLUDED_KEYS = new Set(['id', 'created_at', 'updated_at', 'inserted_by']);

/**
 * Write-side DAO. Orchestrates row writes with audit-field injection,
 * excluded-keys filtering, and optimistic-lock enforcement. Delegates
 * SQL generation to `WriteQueryBuilder` and execution to `Database`.
 *
 * Verb: `find*` — returns raw `TRow` (DB-level). Repository layer wraps
 * these into `load*` for aggregate loading.
 */
export abstract class BaseWriteDao<TRow extends { id: string }> {
  protected abstract readonly tableName: string;

  constructor(
    protected readonly db: Database,
    protected readonly queryBuilder: WriteQueryBuilder,
    protected readonly contextProvider: ExecutionContextProvider,
  ) {}

  async findOneById(id: string, trx?: DatabaseTransaction): Promise<TRow | null> {
    const stmt = this.queryBuilder.selectForUpdate<TRow>({
      table: this.tableName,
      where: { id } as FilterQuery<TRow>,
    });
    const result = await this.db.query(stmt.text, stmt.params, trx);
    return (result.rows[0] as TRow | undefined) ?? null;
  }

  async findOneForUpdate(where: FilterQuery<TRow>, trx: DatabaseTransaction): Promise<TRow | null> {
    const stmt = this.queryBuilder.selectForUpdate<TRow>({
      table: this.tableName,
      where,
    });
    const result = await this.db.query(stmt.text, stmt.params, trx);
    return (result.rows[0] as TRow | undefined) ?? null;
  }

  async findManyForUpdate(where: FilterQuery<TRow>, trx: DatabaseTransaction): Promise<TRow[]> {
    const stmt = this.queryBuilder.selectForUpdate<TRow>({
      table: this.tableName,
      where,
    });
    const result = await this.db.query(stmt.text, stmt.params, trx);
    return result.rows as TRow[];
  }

  async create(row: TRow, trx?: DatabaseTransaction): Promise<void> {
    const prepared = this.prepareInsertRow(row);
    const stmt = this.queryBuilder.insert({
      table: this.tableName,
      rows: [prepared],
    });
    await this.db.query(stmt.text, stmt.params, trx);
  }

  async createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void> {
    if (rows.length === 0) return;
    const prepared = rows.map((row) => this.prepareInsertRow(row));
    const stmt = this.queryBuilder.insert({
      table: this.tableName,
      rows: prepared,
    });
    await this.db.query(stmt.text, stmt.params, trx);
  }

  async update(row: TRow & { updated_at?: Date }, trx?: DatabaseTransaction): Promise<void> {
    const { id, updated_at } = row;
    const prepared = this.prepareUpdateRow(row);
    const stmt = this.queryBuilder.update<TRow>({
      table: this.tableName,
      set: prepared,
      where: { id } as FilterQuery<TRow>,
      ...(updated_at !== undefined
        ? { optimisticLock: { column: 'updated_at', expected: updated_at } }
        : {}),
    });
    const result = await this.db.query(stmt.text, stmt.params, trx);

    if (updated_at !== undefined && result.rowCount === 0) {
      throw new OptimisticLockError({ entity: this.tableName, id });
    }
  }

  async delete(id: string, trx?: DatabaseTransaction): Promise<void> {
    const stmt = this.queryBuilder.delete<TRow>({
      table: this.tableName,
      where: { id } as FilterQuery<TRow>,
    });
    await this.db.query(stmt.text, stmt.params, trx);
  }

  async deleteMany(ids: readonly string[], trx?: DatabaseTransaction): Promise<void> {
    if (ids.length === 0) return;
    const stmt = this.queryBuilder.delete<TRow>({
      table: this.tableName,
      where: { id: ids } as FilterQuery<TRow>,
    });
    await this.db.query(stmt.text, stmt.params, trx);
  }

  private prepareInsertRow(row: TRow): Record<string, unknown> {
    const filtered = this.stripKeys(row, INSERT_EXCLUDED_KEYS);
    const userId = this.contextProvider.getContext().userId;
    return {
      ...filtered,
      inserted_by: userId,
      updated_by: userId,
    };
  }

  private prepareUpdateRow(row: TRow): Record<string, unknown> {
    const filtered = this.stripKeys(row, UPDATE_EXCLUDED_KEYS);
    const userId = this.contextProvider.getContext().userId;
    return {
      ...filtered,
      updated_by: userId,
    };
  }

  private stripKeys(row: TRow, excluded: ReadonlySet<string>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
      if (!excluded.has(key)) {
        out[key] = value;
      }
    }
    return out;
  }
}
