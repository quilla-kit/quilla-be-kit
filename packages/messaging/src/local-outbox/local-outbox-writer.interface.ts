import type { LocalOutboxInsertInput } from './local-outbox-entry.type.js';
import type { TransactionHandle } from './transaction-handle.interface.js';

export interface LocalOutboxWriter {
  insert(entries: readonly LocalOutboxInsertInput[], trx: TransactionHandle): Promise<void>;
}
