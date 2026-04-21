import type { PoolClient } from 'pg';
import type { DatabaseResult } from '../database/database-result.type.js';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

enum TransactionState {
  NotStarted = 0,
  Active = 1,
  Committed = 2,
  RolledBack = 3,
}

/**
 * Postgres `DatabaseTransaction` backed by a `pg.PoolClient`. Tracks its
 * own lifecycle explicitly (NotStarted → Active → Committed | RolledBack)
 * so callers can't commit twice, query a committed transaction, etc.
 * `release()` warns if called while the transaction is still Active —
 * that's almost always a bug (UoW should commit or rollback before release).
 */
export class PgTransaction implements DatabaseTransaction {
  private state: TransactionState = TransactionState.NotStarted;

  constructor(private readonly client: PoolClient) {}

  get isActive(): boolean {
    return this.state === TransactionState.Active;
  }

  async start(): Promise<void> {
    if (this.state !== TransactionState.NotStarted) {
      throw new Error('Transaction already started or completed');
    }
    await this.client.query('BEGIN');
    this.state = TransactionState.Active;
  }

  async query(sql: string, params: readonly unknown[] = []): Promise<DatabaseResult> {
    if (this.state !== TransactionState.Active) {
      throw new Error('Transaction is not active');
    }
    const result = await this.client.query(sql, params as unknown[]);
    return {
      rows: result.rows as readonly Record<string, unknown>[],
      rowCount: result.rowCount ?? 0,
    };
  }

  async commit(): Promise<void> {
    if (this.state !== TransactionState.Active) {
      throw new Error('No active transaction to commit');
    }
    try {
      await this.client.query('COMMIT');
      this.state = TransactionState.Committed;
    } catch (cause) {
      throw new Error('Transaction commit failed', { cause });
    }
  }

  async rollback(_reason: Error): Promise<void> {
    if (this.state !== TransactionState.Active) {
      // Already committed / rolled back / never started — nothing to do.
      // The caller (UoW) invokes rollback defensively in `catch`, so
      // double-rollback must be a no-op rather than an error.
      return;
    }
    try {
      await this.client.query('ROLLBACK');
      this.state = TransactionState.RolledBack;
    } catch (cause) {
      throw new Error('Transaction rollback failed', { cause });
    }
  }

  async release(): Promise<void> {
    if (this.state === TransactionState.Active) {
      // Releasing a still-active transaction returns the client to the pool
      // with an open BEGIN — subsequent work on that connection will observe
      // uncommitted state. Almost always a bug.
      console.warn('PgTransaction.release() called while transaction is still active');
    }
    this.client.release();
  }
}
