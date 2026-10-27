import type { AnyEvent } from '@quilla-be-kit/ddd';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { UnitOfWork, type UnitOfWorkContext } from '../../src/aggregate/unit-of-work.js';
import { UnitOfWork as EventUnitOfWork } from '../../src/unit-of-work/unit-of-work.js';
import { FakeDatabase } from '../helpers/fake-database.js';
import { TestAggregate } from '../helpers/test.aggregate.js';

type Entry = { readonly name: string };

describe('aggregate UnitOfWork', () => {
  it('is the core UnitOfWork bound to the DDD event types', async () => {
    const db = new FakeDatabase();
    const sink = vi.fn(async () => {});
    const uow = new UnitOfWork<Entry>({
      db,
      events: {
        sink: { sink },
        serialize: (event) => {
          expectTypeOf(event).toEqualTypeOf<AnyEvent>();
          return { name: event.name };
        },
      },
    });

    await uow.transaction(async (ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<UnitOfWorkContext>();
      ctx.registerAggregate(TestAggregate.create('agg-1', 'foo'));
      // Type-level only: integration events must be DDD events.
      const typeOnly = () => {
        // @ts-expect-error
        ctx.registerIntegrationEvent(42);
      };
      expect(typeOnly).toBeTypeOf('function');
    });

    expect(uow).toBeInstanceOf(EventUnitOfWork);
    expect(sink).toHaveBeenCalledWith([{ name: 'TestCreatedEvent' }], db.transaction);
  });

  it('still assigns to the event-agnostic UnitOfWork', () => {
    const uow = new UnitOfWork<Entry>({
      db: new FakeDatabase(),
      events: { sink: { sink: async () => {} }, serialize: (event) => ({ name: event.name }) },
    });
    const plain: EventUnitOfWork = uow;
    expect(plain).toBe(uow);
  });

  it('hands out the DDD context from transaction and getContext alike', async () => {
    const uow = new UnitOfWork({ db: new FakeDatabase() });
    await uow.transaction(async (ctx) => {
      expect(typeof ctx.registerAggregate).toBe('function');
      expect(uow.getContext()).toBe(ctx);
      await uow.transaction(async (inner) => {
        expect(inner).toBe(ctx);
      });
    });
  });
});
