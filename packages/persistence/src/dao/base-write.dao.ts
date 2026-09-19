import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import { KeyedWriteDao } from './keyed-write.dao.js';

/** `KeyedWriteDao` for tables keyed by a string `id` column. */
export abstract class BaseWriteDao<TRow extends { id: string }> extends KeyedWriteDao<TRow, 'id'> {
  protected readonly keyColumns = ['id'] as const;

  async findOneById(id: string, trx?: DatabaseTransaction): Promise<TRow | null> {
    return this.findOneByKey({ id } as Pick<TRow, 'id'>, trx);
  }

  override async deleteMany(
    ids: readonly (string | Pick<TRow, 'id'>)[],
    trx?: DatabaseTransaction,
  ): Promise<void> {
    await super.deleteMany(
      ids.map((id) => (typeof id === 'string' ? ({ id } as Pick<TRow, 'id'>) : id)),
      trx,
    );
  }
}
