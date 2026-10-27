import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { LockedSelectOptions, OnLocked } from '../db-adapter/write-db-adapter.interface.js';

type LockedRead = Pick<LockedSelectOptions<unknown>, 'limit' | 'orderBy' | 'onLocked'>;

export type FindManyForUpdateOptions<TRow> = LockedRead & {
  readonly where: FilterQuery<TRow>;
};

export type FindManyForUpdateByKeysOptions<TRow, TKey extends keyof TRow & string> = LockedRead & {
  readonly keys: readonly Pick<TRow, TKey>[];
};

/**
 * Pass as a predicate to address every row of the table on purpose. An
 * empty filter object is rejected instead, so a whole-table write is never
 * accidental.
 */
export const ALL_ROWS: unique symbol = Symbol.for('@quilla-be-kit/persistence/all-rows');

export type WritePredicate<TRow> = FilterQuery<TRow> | typeof ALL_ROWS;

/** `'skip'` is excluded: skipping a locked second row would defeat the single-row check. */
export type FindSingleForUpdateOptions = {
  readonly onLocked?: Exclude<OnLocked, 'skip'>;
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

  findSingle(where: WritePredicate<TRow>, trx?: DatabaseTransaction): Promise<TRow | null>;

  findSingleForUpdate(
    where: WritePredicate<TRow>,
    trx: DatabaseTransaction,
    options?: FindSingleForUpdateOptions,
  ): Promise<TRow | null>;

  updateBy(
    where: WritePredicate<TRow>,
    set: Partial<TRow>,
    trx?: DatabaseTransaction,
  ): Promise<number>;

  deleteBy(where: WritePredicate<TRow>, trx?: DatabaseTransaction): Promise<number>;
}
