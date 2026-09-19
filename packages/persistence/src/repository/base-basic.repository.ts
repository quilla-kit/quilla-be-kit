import type { BaseWriteDao } from '../dao/base-write.dao.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import { KeyedBasicRepository } from './keyed-basic.repository.js';

/**
 * Repository for non-aggregate entities (no domain events, no aggregate
 * registration). Use for simple persistence shapes without DDD tactical
 * pattern requirements. Rows are addressed by `id`; use
 * `KeyedBasicRepository` for other keys.
 */
export abstract class BaseBasicRepository<TRow extends { id: string }> extends KeyedBasicRepository<
  TRow,
  'id'
> {
  constructor(protected override readonly writeDao: BaseWriteDao<TRow>) {
    super(writeDao);
  }

  override async deleteMany(
    ids: readonly (string | Pick<TRow, 'id'>)[],
    trx?: DatabaseTransaction,
  ): Promise<void> {
    await this.writeDao.deleteMany(ids, trx);
  }
}
