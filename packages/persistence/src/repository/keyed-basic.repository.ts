import type { KeyedWriteDao } from '../dao/keyed-write.dao.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

/**
 * Repository for non-aggregate rows addressed by the DAO's `keyColumns`
 * (single, composite, or none for insert-only tables). The optimistic-lock
 * column follows the DAO's `auditPolicy`, so `update`/`delete` take the
 * lock value under whatever name the table uses. `BaseBasicRepository` is
 * the `id`-keyed case.
 */
export abstract class KeyedBasicRepository<TRow extends object, TKey extends keyof TRow & string> {
  constructor(protected readonly writeDao: KeyedWriteDao<TRow, TKey>) {}

  async create(row: TRow, trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.create(row, trx);
  }

  async createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.createMany(rows, trx);
  }

  /** Inserts and reads the stored rows back, including database-produced columns. */
  async createReturning(row: TRow, trx?: DatabaseTransaction): Promise<TRow> {
    return this.writeDao.createReturning(row, trx);
  }

  async createManyReturning(
    rows: readonly TRow[],
    trx?: DatabaseTransaction,
  ): Promise<readonly TRow[]> {
    return this.writeDao.createManyReturning(rows, trx);
  }

  async update(
    row: TRow & Readonly<Record<string, unknown>>,
    trx?: DatabaseTransaction,
  ): Promise<void> {
    await this.writeDao.update(row, trx);
  }

  async updateMany(rows: readonly TRow[], trx: DatabaseTransaction): Promise<void> {
    await this.writeDao.updateMany(rows, trx);
  }

  async delete(
    key: Pick<TRow, TKey> & Readonly<Record<string, unknown>>,
    trx?: DatabaseTransaction,
  ): Promise<void> {
    await this.writeDao.delete(key, trx);
  }

  async deleteMany(keys: readonly Pick<TRow, TKey>[], trx?: DatabaseTransaction): Promise<void> {
    await this.writeDao.deleteMany(keys, trx);
  }
}
