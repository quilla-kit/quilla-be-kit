import type { AggregateRoot, IntegrationEvent } from '@quilla-kit/ddd';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

export type UnitOfWorkContext = {
  readonly trx: DatabaseTransaction;
  /**
   * Register one or more aggregates for event collection. Before commit,
   * the UoW drains each aggregate's domain events and hands them to the
   * `OutboxWriter` (if configured) to persist in the same transaction.
   */
  registerAggregate(...aggregates: readonly AggregateRoot<object>[]): void;
  /**
   * Register an integration event for the outbox. Use for cross-bounded-
   * context events that aren't emitted by an aggregate.
   */
  registerIntegrationEvent(event: IntegrationEvent): void;
};
