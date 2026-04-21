import type { Database } from '../database/database.interface.js';
import type { ReadDbAdapter, SelectOptions } from '../db-adapter/read-db-adapter.interface.js';
import { PgColumnTypeCache, runSelect } from './pg-sql.js';

/**
 * Postgres `ReadDbAdapter`. Query side — never accepts a transaction;
 * always runs on the pool (or the read-replica pool, depending on which
 * `Database` is injected).
 *
 * Shares the column-type cache with its sibling `PgWriteDbAdapter` when
 * one is passed in — so a given table's metadata is fetched at most once
 * per process regardless of which adapter hits it first.
 */
export class PgReadDbAdapter implements ReadDbAdapter {
  private readonly columnTypes: PgColumnTypeCache;

  constructor(
    private readonly db: Database,
    columnTypeCache?: PgColumnTypeCache,
  ) {
    this.columnTypes = columnTypeCache ?? new PgColumnTypeCache(db);
  }

  async select<T>(opts: SelectOptions<T>): Promise<readonly T[]> {
    const types = await this.columnTypes.get(opts.table);
    const result = await runSelect(this.db, opts, types, { forUpdate: false });
    return result.rows as readonly T[];
  }
}
