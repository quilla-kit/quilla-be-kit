import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { EventBusEntry } from '../../src/event-bus/event-bus-entry.type.js';
import type { EventSubscription } from '../../src/event-bus/event-subscription.interface.js';
import { EventConsumer, SchemaValidationError } from '../../src/event-bus/event.consumer.js';
import { defineEvent } from '../../src/event-bus/event.descriptor.js';
import type { HandlerEntry } from '../../src/event-bus/handler-entry.type.js';
import { FakeEventBusConsumer } from '../helpers/fake-bus.js';

function makeBusEntry(overrides: Partial<EventBusEntry> = {}): EventBusEntry {
  return {
    id: 'evt-1',
    eventType: 'test.happened',
    eventVersion: 1,
    eventKind: 'domain',
    payload: { foo: 'bar' },
    sourceService: 'svc-a',
    status: 'CLAIMED',
    retryCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    publishedAt: new Date('2026-01-01T00:00:01Z'),
    ...overrides,
  };
}

describe('EventConsumer', () => {
  let bus: FakeEventBusConsumer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('routes claimed events to registered handlers and markDone on success', async () => {
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry()]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(bus.marksFailed).toHaveLength(0);
  });

  it('unwraps { payload, metadata } envelopes before handing to handler', async () => {
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([
      makeBusEntry({
        payload: { payload: { inner: 'value' }, metadata: { scope: 'x' } },
      }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ payload: { inner: 'value' } }));
  });

  it('infers payload type from EventDescriptor', async () => {
    const OrderPlaced = defineEvent<{ orderId: string }>('order.placed');
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on(OrderPlaced, handler);
    bus.enqueueBatch([makeBusEntry({ eventType: 'order.placed', payload: { orderId: 'o-1' } })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'order.placed',
        payload: { orderId: 'o-1' },
      }),
    );
  });

  it('markDone when no handler is registered for event type', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    bus.enqueueBatch([makeBusEntry({ eventType: 'unhandled.type' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.marksDone).toEqual(['evt-1']);
    expect(bus.marksFailed).toHaveLength(0);
  });

  it('skips self-emitted events matching `skipOwnEventKinds` and markDone without invoking handler', async () => {
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      skipOwnEventKinds: ['integration'],
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry({ sourceService: 'svc-a', eventKind: 'integration' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).not.toHaveBeenCalled();
    expect(bus.marksDone).toEqual(['evt-1']);
  });

  it('retries on failure using configured delays then markDone on success', async () => {
    let calls = 0;
    const handler = vi.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
    });
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [10, 20],
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry()]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledTimes(3);
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(bus.marksFailed).toHaveLength(0);
  });

  it('markFailed after exhausting retries; no markDone', async () => {
    const handler = vi.fn(async () => {
      throw new Error('permanent');
    });
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [1, 1],
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry()]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledTimes(3);
    expect(bus.marksFailed).toEqual([{ id: 'evt-1', reason: 'permanent' }]);
    expect(bus.marksDone).toHaveLength(0);
  });

  it('fires onProcessed for successful events only', async () => {
    const onProcessed = vi.fn();
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      onProcessed,
      retryDelaysMs: [],
    });
    consumer.on('ok.type', async () => {});
    consumer.on('fail.type', async () => {
      throw new Error('boom');
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'ok-1', eventType: 'ok.type' }),
      makeBusEntry({ id: 'fail-1', eventType: 'fail.type' }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    await consumer.dispose();

    expect(onProcessed).toHaveBeenCalledTimes(1);
    expect(onProcessed.mock.calls[0]?.[0]?.id).toBe('ok-1');
    expect(bus.marksDone).toEqual(['ok-1']);
    expect(bus.marksFailed.map((m) => m.id)).toEqual(['fail-1']);
  });

  it('passes a stable instanceId across ticks', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      instanceId: 'replica-7',
    });

    consumer.start();
    await vi.advanceTimersByTimeAsync(3000);
    await consumer.dispose();

    expect(bus.claimed.length).toBeGreaterThan(0);
    for (const call of bus.claimed) {
      expect(call.instanceId).toBe('replica-7');
    }
  });

  it('validates payload against the descriptor schema before dispatch and markFailed on failure', async () => {
    const schema = z.object({ orderId: z.string(), total: z.number() });
    const OrderPlaced = defineEvent('order.placed', schema);
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [1000, 1000],
    });
    consumer.on(OrderPlaced, handler);
    bus.enqueueBatch([
      makeBusEntry({ eventType: 'order.placed', payload: { orderId: 'o-1', total: 'bad' } }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).not.toHaveBeenCalled();
    expect(bus.marksDone).toHaveLength(0);
    expect(bus.marksFailed).toHaveLength(1);
    expect(bus.marksFailed[0]?.reason).toMatch(/schema validation failed/);
  });

  it('passes the schema-validated payload to the handler on success', async () => {
    const schema = z.object({ orderId: z.string(), total: z.number() });
    const OrderPlaced = defineEvent('order.placed', schema);
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on(OrderPlaced, handler);
    bus.enqueueBatch([
      makeBusEntry({ eventType: 'order.placed', payload: { orderId: 'o-1', total: 42 } }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ payload: { orderId: 'o-1', total: 42 } }),
    );
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(bus.marksFailed).toHaveLength(0);
  });

  it('does not retry schema-validation failures', async () => {
    const schema = z.object({ orderId: z.string() });
    const OrderPlaced = defineEvent('order.placed', schema);
    const validateSpy = vi.spyOn(schema['~standard'], 'validate');
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [1, 1, 1],
    });
    consumer.on(OrderPlaced, handler);
    bus.enqueueBatch([makeBusEntry({ eventType: 'order.placed', payload: { orderId: 123 } })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(100);
    await consumer.dispose();

    expect(handler).not.toHaveBeenCalled();
    expect(validateSpy).toHaveBeenCalledTimes(1);
    expect(bus.marksFailed).toHaveLength(1);
  });

  it('SchemaValidationError carries eventType + issues', () => {
    const err = new SchemaValidationError('order.placed', [{ message: 'boom', path: ['total'] }]);
    expect(err.eventType).toBe('order.placed');
    expect(err.issues).toHaveLength(1);
    expect(err.message).toMatch(/order\.placed/);
    expect(err.message).toMatch(/total: boom/);
  });

  it('wires subscriptions from options', async () => {
    const OrderPlaced = defineEvent<{ orderId: string }>('order.placed');
    const UserCreated = defineEvent<{ userId: string }>('user.created');
    const onOrder = vi.fn(async () => {});
    const onUser = vi.fn(async () => {});
    const subscriptions: EventSubscription[] = [
      { descriptor: OrderPlaced, handle: onOrder },
      { descriptor: UserCreated, handle: onUser },
    ];

    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      subscriptions,
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'o-1', eventType: 'order.placed', payload: { orderId: 'o-1' } }),
      makeBusEntry({ id: 'u-1', eventType: 'user.created', payload: { userId: 'u-1' } }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(onOrder).toHaveBeenCalledTimes(1);
    expect(onUser).toHaveBeenCalledTimes(1);
    expect(bus.marksDone).toEqual(['o-1', 'u-1']);
  });

  it('preserves `this` when a subscription is a class instance', async () => {
    const OrderPlaced = defineEvent<{ orderId: string }>('order.placed');
    const seen: string[] = [];

    class OrderPlacedSubscription implements EventSubscription<{ orderId: string }> {
      readonly descriptor = OrderPlaced;
      private readonly tag = 'class-bound';

      async handle(entry: HandlerEntry<{ orderId: string }>): Promise<void> {
        seen.push(`${this.tag}:${entry.payload.orderId}`);
      }
    }

    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      subscriptions: [new OrderPlacedSubscription()],
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'o-1', eventType: 'order.placed', payload: { orderId: 'o-1' } }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(seen).toEqual(['class-bound:o-1']);
    expect(bus.marksDone).toEqual(['o-1']);
    expect(bus.marksFailed).toHaveLength(0);
  });

  it('subscribe() adds heterogeneous subscriptions post-construction', async () => {
    const OrderPlaced = defineEvent<{ orderId: string }>('order.placed');
    const UserCreated = defineEvent<{ userId: string }>('user.created');
    const onOrder = vi.fn(async () => {});
    const onUser = vi.fn(async () => {});

    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.subscribe([
      { descriptor: OrderPlaced, handle: onOrder },
      { descriptor: UserCreated, handle: onUser },
    ]);
    bus.enqueueBatch([
      makeBusEntry({ id: 'o-1', eventType: 'order.placed', payload: { orderId: 'o-1' } }),
      makeBusEntry({ id: 'u-1', eventType: 'user.created', payload: { userId: 'u-1' } }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(onOrder).toHaveBeenCalledTimes(1);
    expect(onUser).toHaveBeenCalledTimes(1);
  });

  it('dispose() awaits in-flight tick before resolving (graceful drain)', async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handler = vi.fn(async () => {
      await blocker;
    });
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry()]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    const disposePromise = consumer.dispose();
    let disposed = false;
    disposePromise.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    release();
    await disposePromise;
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.marksDone).toEqual(['evt-1']);
  });

  it('registeredEventTypes reflects every registration from on() and subscribe()', () => {
    const OrderPlaced = defineEvent<{ orderId: string }>('order.placed');
    const UserCreated = defineEvent<{ userId: string }>('user.created');
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    expect(consumer.registeredEventTypes).toEqual([]);

    consumer.on('plain.type', async () => {});
    consumer.on(OrderPlaced, async () => {});
    consumer.subscribe([{ descriptor: UserCreated, handle: async () => {} }]);

    expect(consumer.registeredEventTypes).toEqual(['plain.type', 'order.placed', 'user.created']);
  });
});
