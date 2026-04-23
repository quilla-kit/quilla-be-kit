import { Pool, type PoolConfig } from 'pg';
import type { DatabaseHealth } from '../database/database-health.type.js';
import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import { PgTransaction } from './pg.transaction.js';

export type PgDatabaseOptions = PoolConfig | { readonly pool: Pool };

/**
 * Postgres implementation of `Database`. Accepts either a `PoolConfig` (the
 * adapter creates and owns the pool) or `{ pool }` (the caller owns it —
 * useful for sharing one `pg.Pool` with `PgLocalOutbox` / `PgEventBus` /
 * other Postgres adapters). When the pool is caller-owned, `disconnect()`
 * is a no-op; register `pool.end()` yourself on a `ShutdownManager`.
 */
export class PgDatabase implements Database {
  private readonly pool: Pool;
  private readonly ownsPool: boolean;

  constructor(options: PgDatabaseOptions) {
    if ('pool' in options) {
      this.pool = options.pool;
      this.ownsPool = false;
    } else {
      this.pool = new Pool(options);
      this.ownsPool = true;
    }
  }

  async query(
    sql: string,
    params: readonly unknown[] = [],
    trx?: DatabaseTransaction,
  ): Promise<DatabaseResult> {
    if (trx) {
      return trx.query(sql, params);
    }
    const result = await this.pool.query(sql, params as unknown[]);
    return {
      rows: result.rows as readonly Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async getDbTransaction(): Promise<DatabaseTransaction> {
    const client = await this.pool.connect();
    return new PgTransaction(client);
  }

  async disconnect(): Promise<void> {
    if (this.ownsPool) {
      await this.pool.end();
    }
  }

  async healthCheck(): Promise<DatabaseHealth> {
    const result = await this.pool.query('SELECT version() AS version');
    const version = String(result.rows[0]?.version ?? 'unknown');
    return { version };
  }
}
