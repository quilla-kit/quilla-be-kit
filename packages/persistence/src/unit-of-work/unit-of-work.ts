import { AsyncLocalStorage } from 'node:async_hooks';
import type { AggregateRoot, AnyEvent, IntegrationEvent } from '@quilla-kit/ddd';
import type { Database } from '../database/database.interface.js';
import type { OutboxWriter } from './outbox-writer.interface.js';
import type { UnitOfWorkContext } from './unit-of-work-context.type.js';

export type UnitOfWorkOptions = {
  readonly db: Database;
  readonly outboxWriter?: OutboxWriter;
};

/**
 * Coordinates a database transaction over a unit of work: starts the trx,
 * tracks registered aggregates, drains their events plus registered
 * integration events into the outbox (when configured), and commits
 * atomically. Rolls back on error, releases the connection in `finally`.
 *
 * Nested `transaction()` calls detect an active UoW via AsyncLocalStorage
 * and JOIN it — the inner call reuses the outer trx/context without
 * starting a new one.
 */
export class UnitOfWork {
  private readonly db: Database;
  private readonly outboxWriter: OutboxWriter | undefined;
  private readonly storage = new AsyncLocalStorage<UnitOfWorkContext>();

  constructor(options: UnitOfWorkOptions) {
    this.db = options.db;
    this.outboxWriter = options.outboxWriter;
  }

  getContext(): UnitOfWorkContext | undefined {
    return this.storage.getStore();
  }

  async transaction<T>(operation: (ctx: UnitOfWorkContext) => Promise<T>): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) {
      return operation(existing);
    }

    const trx = await this.db.getDbTransaction();
    await trx.start();

    const tracked = new Map<string, AggregateRoot<object>>();
    const integrationEvents: IntegrationEvent[] = [];

    const ctx: UnitOfWorkContext = {
      trx,
      registerAggregate: (...aggregates) => {
        for (const agg of aggregates) {
          tracked.set(`${agg.constructor.name}:${agg.id}`, agg);
        }
      },
      registerIntegrationEvent: (event) => {
        integrationEvents.push(event);
      },
    };

    try {
      const result = await this.storage.run(ctx, async () => {
        const opResult = await operation(ctx);

        if (this.outboxWriter) {
          const domainEvents = [...tracked.values()].flatMap((a) => a.drainDomainEvents());
          const allEvents: AnyEvent[] = [...domainEvents, ...integrationEvents];
          if (allEvents.length > 0) {
            await this.outboxWriter.write(allEvents, trx);
          }
        }

        return opResult;
      });

      await trx.commit();
      return result;
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      await trx.rollback(reason);
      throw error;
    } finally {
      await trx.release();
    }
  }
}
