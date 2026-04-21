import { AsyncLocalStorage } from 'node:async_hooks';
import type { AggregateRoot, AnyEvent, IntegrationEvent } from '@quilla-kit/ddd';
import type { Database } from '../database/database.interface.js';
import type { EventSink } from './event-sink.interface.js';
import type { UnitOfWorkContext } from './unit-of-work-context.type.js';

export type UnitOfWorkOptions<TEntry = unknown> = {
  readonly db: Database;
  readonly events?: {
    readonly sink: EventSink<TEntry>;
    readonly serialize: (event: AnyEvent) => TEntry;
  };
};

export class UnitOfWork<TEntry = unknown> {
  private readonly db: Database;
  private readonly events: UnitOfWorkOptions<TEntry>['events'];
  private readonly storage = new AsyncLocalStorage<UnitOfWorkContext>();

  constructor(options: UnitOfWorkOptions<TEntry>) {
    this.db = options.db;
    this.events = options.events;
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

        const events = this.events;
        if (events) {
          const domainEvents = [...tracked.values()].flatMap((a) => a.drainDomainEvents());
          const allEvents: AnyEvent[] = [...domainEvents, ...integrationEvents];
          if (allEvents.length > 0) {
            const entries = allEvents.map((e) => events.serialize(e));
            await events.sink.sink(entries, trx);
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
