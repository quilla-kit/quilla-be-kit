import type { LocalOutboxInsertInput } from './local-outbox-entry.type.js';
import type { TransactionHandle } from './transaction-handle.interface.js';

export interface LocalOutboxWriter {
  /**
   * Accepts any number of entries, writing all of them on `trx`, which must be
   * an open transaction: past a dialect's parameter limit an implementation
   * may need several statements.
   */
  insert(entries: readonly LocalOutboxInsertInput[], trx: TransactionHandle): Promise<void>;
}
