import type { DatabaseResult } from './database-result.type.js';

export interface DatabaseTransaction {
  readonly isActive: boolean;
  start(): Promise<void>;
  query(sql: string, params?: readonly unknown[]): Promise<DatabaseResult>;
  commit(): Promise<void>;
  rollback(reason: Error): Promise<void>;
  release(): Promise<void>;
}
