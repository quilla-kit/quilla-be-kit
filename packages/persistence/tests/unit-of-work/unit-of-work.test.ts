import type { AnyEvent } from '@quilla-kit/ddd';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseTransaction } from '../../src/database/database-transaction.interface.js';
import type { OutboxWriter } from '../../src/unit-of-work/outbox-writer.interface.js';
import { UnitOfWork } from '../../src/unit-of-work/unit-of-work.js';
import { FakeDatabase } from '../helpers/fake-database.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

class CapturingOutboxWriter implements OutboxWriter {
  calls: { events: readonly AnyEvent[]; trx: DatabaseTransaction }[] = [];
  write = vi.fn(async (events: readonly AnyEvent[], trx: DatabaseTransaction) => {
    this.calls.push({ events, trx });
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

  describe('outbox drain', () => {
    it('drains domain events from registered aggregates before commit', async () => {
      const outbox = new CapturingOutboxWriter();
      const uow = new UnitOfWork({ db, outboxWriter: outbox });

      await uow.transaction(async (ctx) => {
        const agg = TestAggregate.create('agg-1', 'foo');
        ctx.registerAggregate(agg);
      });

      expect(outbox.calls).toHaveLength(1);
      expect(outbox.calls[0]?.events).toHaveLength(1);
      expect(outbox.calls[0]?.trx).toBe(db.transaction);
    });

    it('includes registered integration events in the outbox write', async () => {
      const outbox = new CapturingOutboxWriter();
      const uow = new UnitOfWork({ db, outboxWriter: outbox });

      class SomeIntegrationEvent {
        readonly id = 'e1';
        readonly occurredAt = new Date();
        readonly name = 'SomeIntegrationEvent';
        readonly payload = {};
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

      expect(outbox.calls[0]?.events).toHaveLength(1);
    });

    it('does not call outbox when no events are registered', async () => {
      const outbox = new CapturingOutboxWriter();
      const uow = new UnitOfWork({ db, outboxWriter: outbox });

      await uow.transaction(async () => {});

      expect(outbox.write).not.toHaveBeenCalled();
    });

    it('does nothing outbox-related when no OutboxWriter is configured', async () => {
      const uow = new UnitOfWork({ db });

      await uow.transaction(async (ctx) => {
        ctx.registerAggregate(TestAggregate.create('agg-1', 'x'));
      });

      expect(db.transaction.committed).toBe(true);
    });

    it('rolls back (and does not call outbox) when operation throws', async () => {
      const outbox = new CapturingOutboxWriter();
      const uow = new UnitOfWork({ db, outboxWriter: outbox });

      await expect(
        uow.transaction(async (ctx) => {
          ctx.registerAggregate(TestAggregate.create('agg-1', 'x'));
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');

      expect(outbox.write).not.toHaveBeenCalled();
      expect(db.transaction.rolledBack).toBe(true);
    });
  });
});
