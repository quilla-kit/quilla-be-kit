import { vi } from 'vitest';
import type { DatabaseResult } from '../../src/database/database-result.type.js';
import type { DatabaseTransaction } from '../../src/database/database-transaction.interface.js';
import type { Database } from '../../src/database/database.interface.js';

export type QueryCall = {
  readonly text: string;
  readonly params: readonly unknown[];
  readonly viaTrx: boolean;
};

export class FakeDatabaseTransaction implements DatabaseTransaction {
  isActive = false;
  committed = false;
  rolledBack = false;
  released = false;
  rollbackReason: Error | undefined;

  queryResults: DatabaseResult[] = [];
  queryCalls: { text: string; params: readonly unknown[] }[] = [];

  async start(): Promise<void> {
    this.isActive = true;
  }

  async query(text: string, params: readonly unknown[] = []): Promise<DatabaseResult> {
    this.queryCalls.push({ text, params });
    return this.queryResults.shift() ?? { rows: [], rowCount: 0 };
  }

  async commit(): Promise<void> {
    this.committed = true;
    this.isActive = false;
  }

  async rollback(reason: Error): Promise<void> {
    this.rolledBack = true;
    this.rollbackReason = reason;
    this.isActive = false;
  }

  async release(): Promise<void> {
    this.released = true;
  }
}

export class FakeDatabase implements Database {
  calls: QueryCall[] = [];
  queryResults: DatabaseResult[] = [];
  transaction = new FakeDatabaseTransaction();

  async query(
    text: string,
    params: readonly unknown[] = [],
    trx?: DatabaseTransaction,
  ): Promise<DatabaseResult> {
    this.calls.push({ text, params, viaTrx: trx !== undefined });
    if (trx) {
      return trx.query(text, params);
    }
    return this.queryResults.shift() ?? { rows: [], rowCount: 0 };
  }

  getDbTransaction = vi.fn(async () => this.transaction);

  disconnect = vi.fn(async () => {});

  healthCheck = vi.fn(async () => {});
}
