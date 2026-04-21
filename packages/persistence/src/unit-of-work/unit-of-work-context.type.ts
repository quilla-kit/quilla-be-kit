import type { AggregateRoot, IntegrationEvent } from '@quilla-kit/ddd';
import type { DatabaseTransaction } from '../database/database-transaction.interface.js';

export type UnitOfWorkContext = {
  readonly trx: DatabaseTransaction;
  registerAggregate(...aggregates: readonly AggregateRoot<object>[]): void;
  registerIntegrationEvent(event: IntegrationEvent): void;
};
