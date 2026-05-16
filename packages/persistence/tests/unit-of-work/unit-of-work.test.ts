import type { AnyEvent } from '@quilla-be-kit/ddd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../../src/database/database-transaction.interface.js';
import type { EventSink } from '../../src/unit-of-work/event-sink.interface.js';
import { UnitOfWork } from '../../src/unit-of-work/unit-of-work.js';
import { FakeDatabase } from '../helpers/fake-database.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

type TestEntry = { readonly name: string; readonly payload: unknown };

const serialize = (event: AnyEvent): TestEntry => ({
  name: event.name,
  payload: event.payload,
});

class CapturingSink implements EventSink<TestEntry> {
  calls: { entries: readonly TestEntry[]; trx: DatabaseTransaction }[] = [];
  sink = vi.fn(async (entries: readonly TestEntry[], trx: DatabaseTransaction) => {
    this.calls.push({ entries, trx });
  });
}

describe('UnitOfWork', () => {
  let db: FakeDatabase;

  beforeEach(() => {
    db = new FakeDatabase();
  });

  it('starts a transaction, runs the operation, and commits', async () => {
    const uow = new UnitOfWork({ db });

    await uow.transaction(async (ctx) => {
      expect(ctx.trx).toBe(db.transaction);
      expect(db.transaction.isActive).toBe(true);
    });

    expect(db.transaction.committed).toBe(true);
    expect(db.transaction.released).toBe(true);
    expect(db.transaction.rolledBack).toBe(false);
  });

  it('rolls back and releases on error', async () => {
    const uow = new UnitOfWork({ db });
    const boom = new Error('boom');

    await expect(
      uow.transaction(async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(db.transaction.rolledBack).toBe(true);
    expect(db.transaction.rollbackReason).toBe(boom);
    expect(db.transaction.released).toBe(true);
    expect(db.transaction.committed).toBe(false);
  });

  it('nested transaction calls JOIN the outer trx (no new trx, same ctx)', async () => {
    const uow = new UnitOfWork({ db });
    let outerCtx: unknown;
    let innerCtx: unknown;

    await uow.transaction(async (ctx) => {
      outerCtx = ctx;
      await uow.transaction(async (nested) => {
        innerCtx = nested;
      });
    });

    expect(outerCtx).toBe(innerCtx);
    expect(db.getDbTransaction).toHaveBeenCalledTimes(1);
  });

  it('exposes the current context via getContext() inside a transaction', async () => {
    const uow = new UnitOfWork({ db });

    expect(uow.getContext()).toBeUndefined();

    await uow.transaction(async (ctx) => {
      expect(uow.getContext()).toBe(ctx);
    });

    expect(uow.getContext()).toBeUndefined();
  });

  describe('event drain', () => {
    it('drains domain events from registered aggregates, serializes them, and calls the sink', async () => {
      const sink = new CapturingSink();
      const uow = new UnitOfWork<TestEntry>({ db, events: { sink, serialize } });

      await uow.transaction(async (ctx) => {
        const agg = TestAggregate.create('agg-1', 'foo');
        ctx.registerAggregate(agg);
      });

      expect(sink.calls).toHaveLength(1);
      expect(sink.calls[0]?.entries).toHaveLength(1);
      expect(sink.calls[0]?.entries[0]?.name).toBe('TestCreatedEvent');
      expect(sink.calls[0]?.entries[0]?.payload).toEqual({ name: 'foo' });
      expect(sink.calls[0]?.trx).toBe(db.transaction);
    });

    it('includes registered integration events in the sink call', async () => {
      const sink = new CapturingSink();
      const uow = new UnitOfWork<TestEntry>({ db, events: { sink, serialize } });

      class SomeIntegrationEvent {
        readonly id = 'e1';
        readonly occurredAt = new Date();
        readonly name = 'SomeIntegrationEvent';
        readonly payload = { foo: 'bar' };
        toJSON() {
          return {
            id: this.id,
            name: this.name,
            occurredAt: this.occurredAt.toISOString(),
            payload: this.payload,
          };
        }
      }

      await uow.transaction(async (ctx) => {
        ctx.registerIntegrationEvent(
          new SomeIntegrationEvent() as unknown as Parameters<
            typeof ctx.registerIntegrationEvent
          >[0],
        );
      });

      expect(sink.calls[0]?.entries).toHaveLength(1);
      expect(sink.calls[0]?.entries[0]?.name).toBe('SomeIntegrationEvent');
    });

    it('does not call the sink when no events are registered', async () => {
      const sink = new CapturingSink();
      const uow = new UnitOfWork<TestEntry>({ db, events: { sink, serialize } });

      await uow.transaction(async () => {});

      expect(sink.sink).not.toHaveBeenCalled();
    });

    it('does nothing sink-related when no sink is configured', async () => {
      const uow = new UnitOfWork({ db });

      await uow.transaction(async (ctx) => {
        ctx.registerAggregate(TestAggregate.create('agg-1', 'x'));
      });

      expect(db.transaction.committed).toBe(true);
    });

    it('rolls back (and does not call sink) when operation throws', async () => {
      const sink = new CapturingSink();
      const uow = new UnitOfWork<TestEntry>({ db, events: { sink, serialize } });

      await expect(
        uow.transaction(async (ctx) => {
          ctx.registerAggregate(TestAggregate.create('agg-1', 'x'));
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');

      expect(sink.sink).not.toHaveBeenCalled();
      expect(db.transaction.rolledBack).toBe(true);
    });
  });
});
