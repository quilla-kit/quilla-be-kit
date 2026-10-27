import { AsyncLocalStorage } from 'node:async_hooks';
import type { Database } from '../database/database.interface.js';
import type { DomainEventSource } from './domain-event-source.interface.js';
import type { EventSink } from './event-sink.interface.js';
import type { UnitOfWorkContext } from './unit-of-work-context.type.js';

export type UnitOfWorkOptions<TEntry = unknown, TEvent = unknown> = {
  readonly db: Database;
  readonly events?: {
    readonly sink: EventSink<TEntry>;
    // A method, not a property: its parameter stays bivariant, so a unit of
    // work built for a specific event type still assigns to `UnitOfWork`.
    serialize(event: TEvent): TEntry;
  };
};

/** `TContext` lets a subclass hand out a richer context; see `extendContext`. */
export class UnitOfWork<
  TEntry = unknown,
  TEvent = unknown,
  TContext extends UnitOfWorkContext<TEvent> = UnitOfWorkContext<TEvent>,
> {
  private readonly db: Database;
  private readonly events: UnitOfWorkOptions<TEntry, TEvent>['events'];
  private readonly storage = new AsyncLocalStorage<TContext>();

  constructor(options: UnitOfWorkOptions<TEntry, TEvent>) {
    this.db = options.db;
    this.events = options.events;
  }

  /** Builds the context handed out; a subclass that widens `TContext` must override it. */
  protected extendContext(ctx: UnitOfWorkContext<TEvent>): TContext {
    return ctx as TContext;
  }

  getContext(): TContext | undefined {
    return this.storage.getStore();
  }

  async transaction<T>(operation: (ctx: TContext) => Promise<T>): Promise<T> {
    const existing = this.storage.getStore();
    if (existing) {
      return operation(existing);
    }

    const trx = await this.db.getDbTransaction();
    await trx.start();

    const sources = new Set<DomainEventSource<TEvent>>();
    const integrationEvents: TEvent[] = [];

    const ctx = this.extendContext({
      trx,
      registerEventSource: (...registered) => {
        for (const source of registered) sources.add(source);
      },
      registerIntegrationEvent: (event) => {
        integrationEvents.push(event);
      },
    });

    try {
      const result = await this.storage.run(ctx, async () => {
        const opResult = await operation(ctx);

        const events = this.events;
        if (events) {
          const domainEvents = [...sources].flatMap((source) => source.drainDomainEvents());
          const allEvents: TEvent[] = [...domainEvents, ...integrationEvents];
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
