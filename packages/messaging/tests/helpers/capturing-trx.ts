import type { TransactionHandle } from '../../src/local-outbox/transaction-handle.interface.js';

export class CapturingTrx implements TransactionHandle {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  async query<TRow = unknown>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: readonly TRow[] }> {
    this.calls.push({ sql, params });
    return { rows: [] };
  }
}
