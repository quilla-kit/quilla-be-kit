import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { AuditTimestamps, WriteDbAdapter } from '../db-adapter/write-db-adapter.interface.js';
import { OptimisticLockError } from '../errors/optimistic-lock.error.js';
import { resolveAuditPolicy } from './audit-columns.js';
import type { AuditPolicy, ResolvedAudit } from './audit-policy.type.js';

type Row = Record<string, unknown>;

type Memo = {
  readonly audit: ResolvedAudit;
  readonly timestamps: AuditTimestamps;
  readonly insertExcluded: ReadonlySet<string>;
  readonly updateExcluded: ReadonlySet<string>;
};

/**
 * Write-side DAO addressed by `keyColumns` (single or composite);
 * `BaseWriteDao` is the `['id']` case. Key-addressed methods never SET the
 * key columns, and an empty `keyColumns` makes the table insert-only: they
 * throw. `auditPolicy` (default `'kit'`) declares the audit columns; the
 * optimistic lock applies only when an `updatedAt` column is declared and
 * reads the row property named by that column. Unlocked reads take an
 * optional `trx`; locked reads require one. `updateMany`/`deleteMany` have
 * no per-row lock — `findManyForUpdate` first if you need one.
 */
export abstract class KeyedWriteDao<TRow extends object, TKey extends keyof TRow & string> {
  protected abstract readonly tableName: string;
  protected abstract readonly keyColumns: readonly TKey[];
  protected readonly auditPolicy: AuditPolicy = 'kit';
  private memoized?: Memo;

  constructor(
    protected readonly adapter: WriteDbAdapter,
    protected readonly contextProvider: ExecutionContextProvider,
  ) {}

  async findOneByKey(key: Pick<TRow, TKey>, trx?: DatabaseTransaction): Promise<TRow | null> {
    const rows = await this.adapter.find<TRow>(
      {
        table: this.tableName,
        where: this.keyWhere('findOneByKey', key),
        limit: 1,
      },
      trx,
    );
    return rows[0] ?? null;
  }

  async findOne(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<TRow | null> {
    const rows = await this.adapter.find<TRow>({ table: this.tableName, where, limit: 1 }, trx);
    return rows[0] ?? null;
  }

  async findMany(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<readonly TRow[]> {
    return this.adapter.find<TRow>({ table: this.tableName, where }, trx);
  }

  async existsBy(where: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<boolean> {
    return this.adapter.exists<TRow>({ table: this.tableName, where }, trx);
  }

  async countBy(where?: FilterQuery<TRow>, trx?: DatabaseTransaction): Promise<number> {
    return this.adapter.count<TRow>(
      { table: this.tableName, ...(where !== undefined ? { where } : {}) },
      trx,
    );
  }

  async findOneForUpdate(where: FilterQuery<TRow>, trx: DatabaseTransaction): Promise<TRow | null> {
    const rows = await this.adapter.findForUpdate<TRow>(
      { table: this.tableName, where, limit: 1 },
      trx,
    );
    return rows[0] ?? null;
  }

  async findManyForUpdate(
    where: FilterQuery<TRow>,
    trx: DatabaseTransaction,
  ): Promise<readonly TRow[]> {
    return this.adapter.findForUpdate<TRow>({ table: this.tableName, where }, trx);
  }

  async create(row: TRow, trx?: DatabaseTransaction): Promise<void> {
    const userId = this.contextProvider.getContext().session?.userId;
    await this.adapter.insert(
      {
        table: this.tableName,
        rows: [this.prepareInsertRow(row, userId)],
        audit: this.memo().timestamps,
      },
      trx,
    );
  }

  async createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void> {
    if (rows.length === 0) return;
    const userId = this.contextProvider.getContext().session?.userId;
    const prepared = rows.map((row) => this.prepareInsertRow(row, userId));
    await this.adapter.insert(
      { table: this.tableName, rows: prepared, audit: this.memo().timestamps },
      trx,
    );
  }

  async update(row: TRow & Readonly<Row>, trx?: DatabaseTransaction): Promise<void> {
    const where = this.keyWhere('update', row);
    const lock = this.lockFor(row);
    const userId = this.contextProvider.getContext().session?.userId;
    const result = await this.adapter.update<TRow>(
      {
        table: this.tableName,
        set: this.prepareUpdateRow(row, userId),
        where,
        audit: this.memo().timestamps,
        ...(lock ? { optimisticLock: lock } : {}),
      },
      trx,
    );

    if (lock && result.rowCount === 0) {
      throw this.optimisticLockError(row);
    }
  }

  async updateMany(rows: readonly TRow[], trx: DatabaseTransaction): Promise<void> {
    this.requireKey('updateMany');
    if (rows.length === 0) return;
    const userId = this.contextProvider.getContext().session?.userId;
    const prepared = rows.map((row) => ({
      ...this.pickKey(row),
      ...this.prepareUpdateRow(row, userId),
    }));
    await this.adapter.updateMany(
      {
        table: this.tableName,
        rows: prepared,
        keyColumns: this.keyColumns,
        audit: this.memo().timestamps,
      },
      trx,
    );
  }

  async delete(key: Pick<TRow, TKey> & Readonly<Row>, trx?: DatabaseTransaction): Promise<void> {
    const where = this.keyWhere('delete', key);
    const lock = this.lockFor(key);
    const result = await this.adapter.delete<TRow>(
      { table: this.tableName, where, ...(lock ? { optimisticLock: lock } : {}) },
      trx,
    );

    if (lock && result.rowCount === 0) {
      throw this.optimisticLockError(key);
    }
  }

  async deleteMany(keys: readonly Pick<TRow, TKey>[], trx?: DatabaseTransaction): Promise<void> {
    this.requireKey('deleteMany');
    if (keys.length === 0) return;
    if (this.keyColumns.length === 1) {
      const column = this.keyColumns[0] as TKey;
      await this.adapter.delete<TRow>(
        {
          table: this.tableName,
          where: { [column]: keys.map((key) => key[column]) } as FilterQuery<TRow>,
        },
        trx,
      );
      return;
    }
    for (const key of keys) {
      await this.adapter.delete<TRow>(
        { table: this.tableName, where: this.keyWhere('deleteMany', key) },
        trx,
      );
    }
  }

  protected requireKey(operation: string): void {
    if (this.keyColumns.length === 0) {
      throw new Error(`${this.tableName}: ${operation} requires keyColumns, but none are declared`);
    }
  }

  protected keyWhere(operation: string, source: object): FilterQuery<TRow> {
    this.requireKey(operation);
    return this.pickKey(source) as FilterQuery<TRow>;
  }

  protected prepareInsertRow(row: TRow, userId: string | undefined): Row {
    const { audit, insertExcluded } = this.memo();
    return {
      ...this.stripKeys(row, insertExcluded),
      ...(audit.insertedBy !== undefined ? { [audit.insertedBy]: userId } : {}),
      ...(audit.updatedBy !== undefined ? { [audit.updatedBy]: userId } : {}),
    };
  }

  protected prepareUpdateRow(row: TRow, userId: string | undefined): Row {
    const { audit, updateExcluded } = this.memo();
    return {
      ...this.stripKeys(row, updateExcluded),
      ...(audit.updatedBy !== undefined ? { [audit.updatedBy]: userId } : {}),
    };
  }

  protected stripKeys(row: TRow, excluded: ReadonlySet<string>): Row {
    const out: Row = {};
    for (const [key, value] of Object.entries(row as Row)) {
      if (!excluded.has(key)) {
        out[key] = value;
      }
    }
    return out;
  }

  private pickKey(source: object): Row {
    const key: Row = {};
    for (const column of this.keyColumns) {
      key[column] = (source as Row)[column];
    }
    return key;
  }

  private lockFor(source: object): { column: string; expected: unknown } | undefined {
    const column = this.memo().audit.updatedAt;
    const expected = column === undefined ? undefined : (source as Row)[column];
    return column !== undefined && expected !== undefined ? { column, expected } : undefined;
  }

  private optimisticLockError(source: object): OptimisticLockError {
    const key = this.pickKey(source);
    return new OptimisticLockError({
      entity: this.tableName,
      id: this.keyColumns.map((column) => String(key[column])).join(','),
      ...(this.keyColumns.length > 1 ? { key } : {}),
    });
  }

  // Lazy: `auditPolicy` and `keyColumns` are subclass fields, unset during base construction.
  private memo(): Memo {
    if (this.memoized) return this.memoized;
    const audit = resolveAuditPolicy(this.auditPolicy);
    const { createdAt, updatedAt, insertedBy } = audit;
    const declared = (...columns: (string | undefined)[]) =>
      new Set(columns.filter((c): c is string => c !== undefined));
    this.memoized = {
      audit,
      timestamps: {
        ...(createdAt !== undefined ? { createdAt } : {}),
        ...(updatedAt !== undefined ? { updatedAt } : {}),
      },
      insertExcluded: declared(createdAt, updatedAt),
      updateExcluded: declared(...this.keyColumns, createdAt, updatedAt, insertedBy),
    };
    return this.memoized;
  }
}
