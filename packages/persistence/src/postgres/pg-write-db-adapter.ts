import { AUDIT_COLUMNS } from '../dao/audit-columns.js';
import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { SelectOptions } from '../db-adapter/read-db-adapter.interface.js';
import type {
  AuditTimestamps,
  CountOptions,
  DeleteOptions,
  ExistsOptions,
  InsertOptions,
  KeySetOptions,
  UpdateManyOptions,
  UpdateOptions,
  WriteDbAdapter,
} from '../db-adapter/write-db-adapter.interface.js';
import {
  type IdentifierQuoter,
  NO_QUOTING,
  PgColumnTypeCache,
  QUOTED,
  buildKeySet,
  buildWhere,
  keyPredicate,
  mapPostgresType,
  runSelect,
  serializeValue,
} from './pg-sql.js';

const TIMESTAMP_LITERAL = `date_trunc('milliseconds', CURRENT_TIMESTAMP)`;
const KIT_TIMESTAMPS: AuditTimestamps = {
  createdAt: AUDIT_COLUMNS.createdAt,
  updatedAt: AUDIT_COLUMNS.updatedAt,
};

const timestampComparison = (paramIndex: number): string =>
  `date_trunc('milliseconds', $${paramIndex}::timestamptz)`;

export type PgWriteDbAdapterOptions = {
  readonly columnTypeCache?: PgColumnTypeCache;
  readonly quoteIdentifiers?: boolean;
};

/**
 * Postgres `WriteDbAdapter`. Resolves column types once per table via
 * `PgColumnTypeCache`, emits explicit parameter casts, JSON.stringify's
 * JSONB values, and renders millisecond-truncated timestamps so
 * optimistic-lock comparisons round-trip with JS `Date`.
 *
 * Accepts an optional shared `PgColumnTypeCache` so a sibling
 * `PgReadDbAdapter` can share the same type cache (one info-schema fetch
 * per table, regardless of which adapter hits it first).
 *
 * `quoteIdentifiers: true` double-quotes every table and column the adapter
 * emits (and accepts `schema.table`); names passed in must then be raw,
 * never pre-quoted. Caller-supplied `SelectOptions.columns` and `orderBy`
 * are passed through as given. Default is off (unquoted output).
 *
 * The timestamp columns stamped on insert/update come from each call's
 * `audit` option, so one adapter serves tables with different audit shapes.
 */
export class PgWriteDbAdapter implements WriteDbAdapter {
  private readonly columnTypes: PgColumnTypeCache;
  private readonly quoter: IdentifierQuoter;
  private readonly db: Database;

  constructor(db: Database, cacheOrOptions?: PgColumnTypeCache | PgWriteDbAdapterOptions) {
    const options: PgWriteDbAdapterOptions =
      cacheOrOptions instanceof PgColumnTypeCache
        ? { columnTypeCache: cacheOrOptions }
        : (cacheOrOptions ?? {});
    this.columnTypes = options.columnTypeCache ?? new PgColumnTypeCache(db);
    this.quoter = options.quoteIdentifiers ? QUOTED : NO_QUOTING;
    this.db = db;
  }

  async insert(opts: InsertOptions, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    if (opts.rows.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const types = await this.columnTypes.get(opts.table);
    const firstRow = opts.rows[0] as Record<string, unknown>;
    const keys = Object.keys(firstRow);
    const stamps = stampColumns(opts.audit);
    const table = this.quoter.table(opts.table);
    const returning = buildReturning(opts.returning, this.quoter);

    if (keys.length === 0 && stamps.length === 0) {
      if (opts.rows.length > 1) {
        throw new Error(
          `insert into ${opts.table}: rows with no columns can only be inserted one at a time`,
        );
      }
      return this.db.query(`INSERT INTO ${table} DEFAULT VALUES${returning}`, [], trx);
    }

    const casts = keys.map((key) => mapPostgresType(types[key]));
    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];
    for (const row of opts.rows) {
      const rowData = row as Record<string, unknown>;
      const placeholders = keys.map((key, i) => {
        values.push(serializeValue(types[key], rowData[key]));
        return `$${values.length}::${casts[i]}`;
      });
      rowPlaceholders.push(
        `(${[...placeholders, ...stamps.map(() => TIMESTAMP_LITERAL)].join(', ')})`,
      );
    }

    const allColumns = [...keys, ...stamps].map(this.quoter.column).join(', ');
    const sql = `INSERT INTO ${table} (${allColumns}) VALUES ${rowPlaceholders.join(', ')}${returning}`;

    return this.db.query(sql, values, trx);
  }

  async update<T>(opts: UpdateOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    const types = await this.columnTypes.get(opts.table);
    const setKeys = Object.keys(opts.set);

    const values: unknown[] = [];
    const setClauses = setKeys.map((key) => {
      values.push(serializeValue(types[key], opts.set[key]));
      return `${this.quoter.column(key)} = $${values.length}::${mapPostgresType(types[key])}`;
    });
    const { updatedAt } = opts.audit ?? KIT_TIMESTAMPS;
    if (updatedAt !== undefined) {
      setClauses.push(`${this.quoter.column(updatedAt)} = ${TIMESTAMP_LITERAL}`);
    }

    const where = buildWhere(opts.where, types, values.length, this.quoter.column);
    values.push(...where.values);

    let whereSql = where.sql;
    if (opts.optimisticLock) {
      values.push(
        opts.optimisticLock.expected instanceof Date
          ? opts.optimisticLock.expected.toISOString()
          : opts.optimisticLock.expected,
      );
      whereSql += ` AND ${this.quoter.column(opts.optimisticLock.column)} = ${timestampComparison(values.length)}`;
    }

    const returning = buildReturning(opts.returning, this.quoter);
    const sql = `UPDATE ${this.quoter.table(opts.table)} SET ${setClauses.join(', ')} WHERE ${whereSql}${returning}`;

    return this.db.query(sql, values, trx);
  }

  async updateMany(opts: UpdateManyOptions, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    if (opts.rows.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const types = await this.columnTypes.get(opts.table);
    const keyColumns = opts.keyColumns ?? ['id'];
    const firstRow = opts.rows[0] as Record<string, unknown>;
    const allKeys = Object.keys(firstRow);
    const setKeys = allKeys.filter((key) => !keyColumns.includes(key));

    if (setKeys.length === 0) {
      return { rows: [], rowCount: 0 };
    }

    const setCasts = setKeys.map((key) => mapPostgresType(types[key]));
    const keyCasts = keyColumns.map((key) => mapPostgresType(types[key]));
    const values: unknown[] = [];
    const rowPlaceholders: string[] = [];
    for (const row of opts.rows) {
      const rowData = row as Record<string, unknown>;
      const setPlaceholders = setKeys.map((key, i) => {
        values.push(serializeValue(types[key], rowData[key]));
        return `$${values.length}::${setCasts[i]}`;
      });
      const keyPlaceholders = keyColumns.map((key, i) => {
        if (!(key in rowData)) {
          throw new Error(`updateMany on ${opts.table}: row is missing key column "${key}"`);
        }
        values.push(serializeValue(types[key], rowData[key]));
        return `$${values.length}::${keyCasts[i]}`;
      });
      rowPlaceholders.push(`(${[...setPlaceholders, ...keyPlaceholders].join(', ')})`);
    }

    const q = this.quoter.column;
    const setClauses = setKeys.map((key) => `${q(key)} = data.${q(key)}`);
    const { updatedAt } = opts.audit ?? KIT_TIMESTAMPS;
    if (updatedAt !== undefined) {
      setClauses.push(`${q(updatedAt)} = ${TIMESTAMP_LITERAL}`);
    }

    const dataColumns = [...setKeys, ...keyColumns].map(q).join(', ');
    const join = keyPredicate('t', 'data', keyColumns, q);
    const sql = `UPDATE ${this.quoter.table(opts.table)} AS t SET ${setClauses.join(', ')} FROM (VALUES ${rowPlaceholders.join(', ')}) AS data(${dataColumns}) WHERE ${join}`;

    return this.db.query(sql, values, trx);
  }

  async delete<T>(opts: DeleteOptions<T>, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    const types = await this.columnTypes.get(opts.table);
    const where = buildWhere(opts.where, types, 0, this.quoter.column);
    const values = [...where.values];

    let whereSql = where.sql;
    if (opts.optimisticLock) {
      values.push(
        opts.optimisticLock.expected instanceof Date
          ? opts.optimisticLock.expected.toISOString()
          : opts.optimisticLock.expected,
      );
      whereSql += ` AND ${this.quoter.column(opts.optimisticLock.column)} = ${timestampComparison(values.length)}`;
    }

    const sql = `DELETE FROM ${this.quoter.table(opts.table)} WHERE ${whereSql}`;
    return this.db.query(sql, values, trx);
  }

  async deleteByKeys(opts: KeySetOptions, trx?: DatabaseTransaction): Promise<DatabaseResult> {
    if (opts.keys.length === 0) {
      return { rows: [], rowCount: 0 };
    }
    const types = await this.columnTypes.get(opts.table);
    const keySet = buildKeySet(types, this.quoter, opts);
    const sql = `DELETE FROM ${this.quoter.table(opts.table)} AS t WHERE ${keySet.sql}`;
    return this.db.query(sql, keySet.values, trx);
  }

  async findByKeysForUpdate<T>(
    opts: KeySetOptions,
    trx: DatabaseTransaction,
  ): Promise<readonly T[]> {
    if (opts.keys.length === 0) {
      return [];
    }
    const types = await this.columnTypes.get(opts.table);
    const keySet = buildKeySet(types, this.quoter, opts);
    const sql = `SELECT t.* FROM ${this.quoter.table(opts.table)} AS t WHERE ${keySet.sql} FOR UPDATE`;
    const result = await this.db.query(sql, keySet.values, trx);
    return result.rows as readonly T[];
  }

  async find<T>(opts: SelectOptions<T>, trx?: DatabaseTransaction): Promise<readonly T[]> {
    const result = await this.executeSelect(opts, false, trx);
    return result.rows as readonly T[];
  }

  async findForUpdate<T>(opts: SelectOptions<T>, trx: DatabaseTransaction): Promise<readonly T[]> {
    const result = await this.executeSelect(opts, true, trx);
    return result.rows as readonly T[];
  }

  async exists<T>(opts: ExistsOptions<T>, trx?: DatabaseTransaction): Promise<boolean> {
    const types = await this.columnTypes.get(opts.table);
    const where = buildWhere(opts.where, types, 0, this.quoter.column);
    const sql = `SELECT 1 FROM ${this.quoter.table(opts.table)} WHERE ${where.sql} LIMIT 1`;
    const result = await this.db.query(sql, where.values, trx);
    return result.rows.length > 0;
  }

  async count<T>(opts: CountOptions<T>, trx?: DatabaseTransaction): Promise<number> {
    const types = await this.columnTypes.get(opts.table);
    let sql = `SELECT COUNT(*) AS count FROM ${this.quoter.table(opts.table)}`;
    let values: unknown[] = [];
    if (opts.where && Object.keys(opts.where).length > 0) {
      const where = buildWhere(opts.where, types, 0, this.quoter.column);
      values = where.values;
      sql += ` WHERE ${where.sql}`;
    }
    const result = await this.db.query(sql, values, trx);
    return Number(result.rows[0]?.count ?? 0);
  }

  private async executeSelect<T>(
    opts: SelectOptions<T>,
    forUpdate: boolean,
    trx?: DatabaseTransaction,
  ): Promise<DatabaseResult> {
    const types = await this.columnTypes.get(opts.table);
    return runSelect(this.db, opts, types, { forUpdate, trx, quoter: this.quoter });
  }
}

function buildReturning(
  returning: readonly string[] | undefined,
  quoter: IdentifierQuoter,
): string {
  if (!returning || returning.length === 0) return '';
  return ` RETURNING ${returning.map(quoter.column).join(', ')}`;
}

function stampColumns(audit: AuditTimestamps | undefined): string[] {
  const { createdAt, updatedAt } = audit ?? KIT_TIMESTAMPS;
  return [createdAt, updatedAt].filter((column): column is string => column !== undefined);
}
