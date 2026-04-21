import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import type { FilterQuery } from '../db-adapter/filter-query.type.js';
import type { SelectOptions } from '../db-adapter/read-db-adapter.interface.js';

export type ColumnTypeMap = Record<string, string>;

/**
 * Maps `information_schema.columns.data_type` (or `udt_name` for arrays)
 * to the Postgres type name used for explicit parameter casting
 * (`$1::UUID`, `$2::JSONB`, etc.). Unknown types fall back to `TEXT`.
 */
export function mapPostgresType(dataType: string | undefined): string {
  if (!dataType) return 'TEXT';
  switch (dataType) {
    case 'uuid':
      return 'UUID';
    case 'integer':
    case 'smallint':
    case 'bigint':
      return 'INTEGER';
    case 'boolean':
      return 'BOOLEAN';
    case 'timestamp without time zone':
    case 'timestamp with time zone':
    case 'timestamptz':
      return 'TIMESTAMPTZ';
    case 'date':
      return 'DATE';
    case 'numeric':
    case 'real':
    case 'double precision':
      return 'NUMERIC';
    case 'json':
      return 'JSON';
    case 'jsonb':
      return 'JSONB';
    case 'text':
    case 'character varying':
      return 'TEXT';
    case 'bytea':
      return 'BYTEA';
    case '_uuid':
      return 'UUID[]';
    case '_int4':
      return 'INTEGER[]';
    case '_text':
    case '_varchar':
      return 'TEXT[]';
    default:
      return 'TEXT';
  }
}

/**
 * Builds a parameterised `WHERE` clause from a `FilterQuery`. Scalar values
 * emit `col = $n::TYPE`; arrays emit `col = ANY($n::TYPE[])`.
 *
 * `startIndex` is the placeholder offset — pass the number of params
 * already consumed upstream (e.g. by a SET clause in UPDATE). Read-side
 * callers pass `0`.
 */
export function buildWhere<T>(
  filters: FilterQuery<T>,
  types: ColumnTypeMap,
  startIndex = 0,
): { sql: string; values: unknown[] } {
  const entries = Object.entries(filters);
  if (entries.length === 0) {
    throw new Error('WHERE clause requires at least one filter');
  }

  const values: unknown[] = [];
  const clauses = entries.map(([key, value]) => {
    const pgType = mapPostgresType(types[key]);
    if (Array.isArray(value)) {
      values.push(value);
      return `${key} = ANY($${startIndex + values.length}::${pgType}[])`;
    }
    values.push(value);
    return `${key} = $${startIndex + values.length}::${pgType}`;
  });

  return { sql: clauses.join(' AND '), values };
}

/**
 * Assembles a parameterised `SELECT` statement for the shared read path
 * (used by both `PgWriteDbAdapter.find*` and `PgReadDbAdapter.select`).
 */
export async function runSelect<T>(
  db: Database,
  opts: SelectOptions<T>,
  types: ColumnTypeMap,
  flags: { forUpdate: boolean; trx?: DatabaseTransaction | undefined },
): Promise<DatabaseResult> {
  const columns = opts.columns?.length ? opts.columns.join(', ') : '*';
  let sql = `SELECT ${columns} FROM ${opts.table}`;

  const values: unknown[] = [];
  if (opts.where && Object.keys(opts.where).length > 0) {
    const where = buildWhere(opts.where, types);
    values.push(...where.values);
    sql += ` WHERE ${where.sql}`;
  }

  if (opts.orderBy?.length) {
    const orderClauses = opts.orderBy.map((o) => `${o.column} ${o.direction.toUpperCase()}`);
    sql += ` ORDER BY ${orderClauses.join(', ')}`;
  }

  if (opts.limit !== undefined) {
    sql += ` LIMIT ${opts.limit}`;
  }

  if (flags.forUpdate) {
    sql += ' FOR UPDATE';
  }

  return db.query(sql, values, flags.trx);
}

const INFO_SCHEMA_SQL = `SELECT column_name, data_type, udt_name
       FROM information_schema.columns
       WHERE table_name = $1`;

/**
 * Caches column types per table across the life of a process. Shared by
 * `PgWriteDbAdapter` and `PgReadDbAdapter` so a given table's metadata is
 * fetched at most once, regardless of which adapter gets there first.
 */
export class PgColumnTypeCache {
  private readonly cache = new Map<string, ColumnTypeMap>();

  constructor(private readonly db: Database) {}

  async get(table: string): Promise<ColumnTypeMap> {
    const cached = this.cache.get(table);
    if (cached) return cached;

    const result = await this.db.query(INFO_SCHEMA_SQL, [table]);
    const types: ColumnTypeMap = {};
    for (const row of result.rows) {
      const name = String(row.column_name);
      const dataType = String(row.data_type);
      const udtName = String(row.udt_name);
      types[name] = dataType === 'ARRAY' ? udtName : dataType;
    }

    this.cache.set(table, types);
    return types;
  }
}
