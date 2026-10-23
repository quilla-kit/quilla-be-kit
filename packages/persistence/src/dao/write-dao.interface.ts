import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { LockedSelectOptions } from '../db-adapter/write-db-adapter.interface.js';

type LockedRead = Pick<LockedSelectOptions<unknown>, 'limit' | 'orderBy' | 'onLocked'>;

export type FindManyForUpdateOptions<TRow> = LockedRead & {
  readonly where: FilterQuery<TRow>;
};

export type FindManyForUpdateByKeysOptions<TRow, TKey extends keyof TRow & string> = LockedRead & {
  readonly keys: readonly Pick<TRow, TKey>[];
};

/**
 * Write-side DAO contract for rows addressed by `TKey` columns. The
 * repository bases depend on this, not on `KeyedWriteDao`, so any
 * implementation can back them.
 */
export interface WriteDao<TRow extends object, TKey extends keyof TRow & string> {
  findOneByKey(key: Pick<TRow, TKey>, trx?: DatabaseTransaction): Promise<TRow | null>;

  findOne(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<TRow | null>;

  findMany(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<readonly TRow[]>;

  existsBy(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<boolean>;

  countBy(where?: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<number>;

  findOneForUpdate(where: FilterQuery<TRow>, trx: DatabaseTransaction): Promise<TRow | null>;

  findManyForUpdate(
    options: FindManyForUpdateOptions<TRow>,
    trx: DatabaseTransaction,
  ): Promise<readonly TRow[]>;

  findManyForUpdateByKeys(
    options: FindManyForUpdateByKeysOptions<TRow, TKey>,
    trx: DatabaseTransaction,
  ): Promise<readonly TRow[]>;

  create(row: TRow, trx?: DatabaseTransaction): Promise<void>;

  createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void>;

  createReturning(row: TRow, trx?: DatabaseTransaction): Promise<TRow>;

  createManyReturning(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<readonly TRow[]>;

  update(row: TRow & Readonly<Record<string, unknown>>, trx?: DatabaseTransaction): Promise<number>;

  updateMany(rows: readonly TRow[], trx: DatabaseTransaction): Promise<number>;

  delete(
    key: Pick<TRow, TKey> & Readonly<Record<string, unknown>>,
    trx?: DatabaseTransaction,
  ): Promise<number>;

  deleteMany(keys: readonly Pick<TRow, TKey>[], trx?: DatabaseTransaction): Promise<number>;
}
