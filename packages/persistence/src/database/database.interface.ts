import type { DatabaseResult } from './database-result.type.js';
import type { DatabaseTransaction } from './database-transaction.interface.js';

export interface Database {
  query(
    sql: string,
    params?: readonly unknown[],
    trx?: DatabaseTransaction,
  ): Promise<DatabaseResult>;
  getDbTransaction(): Promise<DatabaseTransaction>;
  disconnect(): Promise<void>;
  healthCheck(): Promise<void>;
}
