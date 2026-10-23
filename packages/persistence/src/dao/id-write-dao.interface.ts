import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { WriteDao } from './write-dao.interface.js';

/** `WriteDao` for rows keyed by a string `id` column. */
export interface IdWriteDao<TRow extends { id: string }> extends WriteDao<TRow, 'id'> {
  findOneById(id: string, trx?: DatabaseTransaction): Promise<TRow | null>;

  deleteMany(
    ids: readonly (string | Pick<TRow, 'id'>)[],
    trx?: DatabaseTransaction,
  ): Promise<number>;
}
