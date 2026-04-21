import { Pool, type PoolConfig } from 'pg';
import type { DatabaseHealth } from '../database/database-health.type.js';
import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { Database } from '../database/database.interface.js';
import { PgTransaction } from './pg.transaction.js';

/**
 * Postgres implementation of `Database`. Owns a `pg.Pool` — pass a
 * `PoolConfig` at construction; the adapter creates and manages the pool.
 * Register `disconnect()` on a `ShutdownManager` from
 * `@quilla-kit/lifecycle` to drain the pool gracefully.
 */
export class PgDatabase implements Database {
  private readonly pool: Pool;

  constructor(config: PoolConfig) {
    this.pool = new Pool(config);
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
    await this.pool.end();
  }

  async healthCheck(): Promise<DatabaseHealth> {
    const result = await this.pool.query('SELECT version() AS version');
    const version = String(result.rows[0]?.version ?? 'unknown');
    return { version };
  }
}
