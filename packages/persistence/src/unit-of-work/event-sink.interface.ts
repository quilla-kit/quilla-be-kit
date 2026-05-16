import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

export interface EventSink<TEntry = unknown> {
  sink(entries: readonly TEntry[], trx: DatabaseTransaction): Promise<void>;
}
