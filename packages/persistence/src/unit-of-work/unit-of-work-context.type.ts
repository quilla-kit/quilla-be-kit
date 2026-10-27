import type { DatabaseTransaction } from '../database/database-transaction.interface.js';
import type { DomainEventSource } from './domain-event-source.interface.js';

export type UnitOfWorkContext<TEvent = unknown> = {
  readonly trx: DatabaseTransaction;
  registerEventSource(...sources: readonly DomainEventSource<TEvent>[]): void;
  registerIntegrationEvent(event: TEvent): void;
};
