import type { AnyEvent } from '@quilla-kit/ddd';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

/**
 * Optional injection point on `UnitOfWork`. When provided, the UoW drains
 * aggregates' domain events plus registered integration events and writes
 * them in the same transaction as the aggregate state changes. When absent,
 * the UoW just commits — no outbox behavior.
 *
 * Concrete implementations live in `@quilla-kit/messaging`.
 */
export interface OutboxWriter {
  write(events: readonly AnyEvent[], trx: DatabaseTransaction): Promise<void>;
}
