import type { ExecutionContextProvider } from '@quilla-be-kit/execution-context';
import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type {
  AuditTimestamps,
  KeySet,
  WriteDbAdapter,
} from '../db-adapter/write-db-adapter.interface.js';
import { OptimisticLockError } from '../errors/optimistic-lock.error.js';
import { resolveAuditPolicy } from './audit-columns.js';
import type { AuditPolicy, ResolvedAudit } from './audit-policy.type.js';

type Row = Record<string, unknown>;

// `rowCount` is optional on `DatabaseResult`; an adapter that omits it reports 0.
const affected = (result: DatabaseResult): number => result.rowCount ?? 0;

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
  protected readonly generatedColumns: readonly string[] = [];
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
    await this.insertRows([row], trx);
  }

  async createMany(rows: readonly TRow[], trx?: DatabaseTransaction): Promise<void> {
    if (rows.length === 0) return;
    await this.insertRows(rows, trx);
  }

  /** Inserts and reads the stored row back, including database-produced columns. */
  async createReturning(row: TRow, trx?: DatabaseTransaction): Promise<TRow> {
    const result = await this.insertRows([row], trx, true);
    const returned = result.rows[0];
    if (returned === undefined) throw this.noReturnedRows('createReturning');
    return returned as TRow;
  }

  async createManyReturning(
    rows: readonly TRow[],
    trx?: DatabaseTransaction,
  ): Promise<readonly TRow[]> {
    if (rows.length === 0) return [];
    const result = await this.insertRows(rows, trx, true);
    if (result.rows.length === 0) throw this.noReturnedRows('createManyReturning');
    return result.rows as readonly TRow[];
  }

  async update(row: TRow & Readonly<Row>, trx?: DatabaseTransaction): Promise<number> {
    const where = this.keyWhere('update', row);
    const lock = this.lockFor(row);
    const userId = this.actorId('update');
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
    return affected(result);
  }

  async updateMany(rows: readonly TRow[], trx: DatabaseTransaction): Promise<number> {
    this.requireKey('updateMany');
    if (rows.length === 0) return 0;
    const userId = this.actorId('update');
    const prepared = rows.map((row) => ({
      ...this.pickKey(row),
      ...this.prepareUpdateRow(row, userId),
    }));
    const result = await this.adapter.updateMany(
      {
        table: this.tableName,
        rows: prepared,
        keyColumns: this.keyColumns,
        audit: this.memo().timestamps,
      },
      trx,
    );
    return affected(result);
  }

  async delete(key: Pick<TRow, TKey> & Readonly<Row>, trx?: DatabaseTransaction): Promise<number> {
    const where = this.keyWhere('delete', key);
    const lock = this.lockFor(key);
    const result = await this.adapter.delete<TRow>(
      { table: this.tableName, where, ...(lock ? { optimisticLock: lock } : {}) },
      trx,
    );

    if (lock && result.rowCount === 0) {
      throw this.optimisticLockError(key);
    }
    return affected(result);
  }

  async deleteMany(keys: readonly Pick<TRow, TKey>[], trx?: DatabaseTransaction): Promise<number> {
    this.requireKey('deleteMany');
    if (keys.length === 0) return 0;
    // Single key stays on the filter path so the emitted SQL is unchanged from BaseWriteDao.
    if (this.keyColumns.length === 1) {
      return affected(
        await this.adapter.delete<TRow>(
          { table: this.tableName, where: this.singleKeyWhere(keys) },
          trx,
        ),
      );
    }
    if (this.adapter.deleteByKeys) {
      return affected(
        await this.adapter.deleteByKeys({ table: this.tableName, ...this.keySet(keys) }, trx),
      );
    }
    let total = 0;
    for (const key of keys) {
      total += affected(
        await this.adapter.delete<TRow>(
          { table: this.tableName, where: this.keyWhere('deleteMany', key) },
          trx,
        ),
      );
    }
    return total;
  }

  async findManyForUpdateByKeys(
    keys: readonly Pick<TRow, TKey>[],
    trx: DatabaseTransaction,
  ): Promise<readonly TRow[]> {
    this.requireKey('findManyForUpdateByKeys');
    if (keys.length === 0) return [];
    if (this.keyColumns.length === 1) {
      return this.adapter.findForUpdate<TRow>(
        { table: this.tableName, where: this.singleKeyWhere(keys) },
        trx,
      );
    }
    if (this.adapter.findByKeysForUpdate) {
      return this.adapter.findByKeysForUpdate<TRow>(
        { table: this.tableName, ...this.keySet(keys) },
        trx,
      );
    }
    const rows: TRow[] = [];
    for (const key of keys) {
      const where = this.keyWhere('findManyForUpdateByKeys', key);
      rows.push(...(await this.adapter.findForUpdate<TRow>({ table: this.tableName, where }, trx)));
    }
    return rows;
  }

  private async insertRows(
    rows: readonly TRow[],
    trx: DatabaseTransaction | undefined,
    returning = false,
  ): Promise<DatabaseResult> {
    const userId = this.actorId('insert');
    return this.adapter.insert(
      {
        table: this.tableName,
        rows: rows.map((row) => this.prepareInsertRow(row, userId)),
        audit: this.memo().timestamps,
        ...(returning ? { returning: 'all' as const } : {}),
      },
      trx,
    );
  }

  private noReturnedRows(operation: string): Error {
    return new Error(
      `${this.tableName}: ${operation} got no rows back — the WriteDbAdapter ignored \`returning\``,
    );
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

  private singleKeyWhere(keys: readonly object[]): FilterQuery<TRow> {
    const column = this.keyColumns[0] as string;
    return { [column]: keys.map((key) => (key as Row)[column]) } as FilterQuery<TRow>;
  }

  private keySet(keys: readonly object[]): KeySet {
    return { keyColumns: this.keyColumns, keys: keys as readonly Row[] };
  }

  private pickKey(source: object): Row {
    const key: Row = {};
    for (const column of this.keyColumns) {
      key[column] = (source as Row)[column];
    }
    return key;
  }

  // Only read the context when the policy has an actor column to stamp on
  // this phase, so tables that record no actor work outside a
  // `runWithContext` scope. Inserts stamp both columns; updates only
  // `updatedBy` (see `prepareUpdateRow`).
  private actorId(phase: 'insert' | 'update'): string | undefined {
    const { insertedBy, updatedBy } = this.memo().audit;
    const stamps =
      phase === 'insert'
        ? insertedBy !== undefined || updatedBy !== undefined
        : updatedBy !== undefined;
    return stamps ? this.contextProvider.getContext().session?.userId : undefined;
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

  // Lazy: `auditPolicy`, `keyColumns` and `generatedColumns` are subclass
  // fields, unset during base construction.
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
      insertExcluded: declared(createdAt, updatedAt, ...this.generatedColumns),
      updateExcluded: declared(
        ...this.keyColumns,
        createdAt,
        updatedAt,
        insertedBy,
        ...this.generatedColumns,
      ),
    };
    return this.memoized;
  }
}
