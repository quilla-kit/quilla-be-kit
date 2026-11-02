import {
  AsyncExecutionContextProvider,
  type ExecutionContext,
} from '@quilla-be-kit/execution-context';
import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { EventBusEntry } from '../../src/event-bus/event-bus-entry.type.js';
import type { EventSubscription } from '../../src/event-bus/event-subscription.interface.js';
import {
  EventConsumer,
  type EventConsumerOptions,
  SchemaValidationError,
} from '../../src/event-bus/event.consumer.js';
import { defineEvent } from '../../src/event-bus/event.descriptor.js';
import type { HandlerEntry } from '../../src/event-bus/handler-entry.type.js';
import { FakeEventBusConsumer } from '../helpers/fake-bus.js';
import { FakeLease } from '../helpers/fake-lease.js';

function makeBusEntry(overrides: Partial<EventBusEntry> = {}): EventBusEntry {
  return {
    id: 'evt-1',
    eventType: 'test.happened',
    eventVersion: 1,
    eventKind: 'domain',
    payload: { foo: 'bar' },
    sourceService: 'svc-a',
    occurredAt: new Date('2025-12-31T23:59:00Z'),
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
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1' }));
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(bus.marksFailed).toHaveLength(0);
  });

  it('passes the event occurredAt through to the handler entry', async () => {
    const occurredAt = new Date('2025-12-31T23:59:00Z');
    const handler = vi.fn(async () => {});
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry({ occurredAt })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ occurredAt }));
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

  it('passes the registered handler keys as allowedTopics to claim()', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
    consumer.on('order.placed', async () => {});
    consumer.on('user.created', async () => {});

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.claimed.length).toBeGreaterThan(0);
    for (const call of bus.claimed) {
      expect([...(call.allowedTopics ?? [])].sort()).toEqual(['order.placed', 'user.created']);
    }
  });

  it('does not call claim() when no handlers are registered', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    consumer.start();
    await vi.advanceTimersByTimeAsync(3000);
    await consumer.dispose();

    expect(bus.claimed).toHaveLength(0);
  });

  it('two consumers with disjoint topics on the same bus do not see each others events', async () => {
    const busA: FakeEventBusConsumer = bus;
    const onOrder = vi.fn(async () => {});
    const onShipping = vi.fn(async () => {});

    const consumerOrders = new EventConsumer({
      bus: busA,
      consumerName: 'orders',
      sourceService: 'orders',
      logger: new NoopLogger(),
    });
    consumerOrders.on('order.placed', onOrder);

    const consumerShipping = new EventConsumer({
      bus: busA,
      consumerName: 'shipping',
      sourceService: 'shipping',
      logger: new NoopLogger(),
    });
    consumerShipping.on('shipping.dispatched', onShipping);

    busA.enqueueBatch([
      makeBusEntry({ id: 'o-1', eventType: 'order.placed' }),
      makeBusEntry({ id: 's-1', eventType: 'shipping.dispatched' }),
    ]);
    busA.enqueueBatch([
      makeBusEntry({ id: 'o-2', eventType: 'order.placed' }),
      makeBusEntry({ id: 's-2', eventType: 'shipping.dispatched' }),
    ]);

    consumerOrders.start();
    consumerShipping.start();
    await vi.advanceTimersByTimeAsync(2000);
    await consumerOrders.dispose();
    await consumerShipping.dispose();

    expect(onOrder).toHaveBeenCalledTimes(1);
    expect(onShipping).toHaveBeenCalledTimes(1);
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
    consumer.on('test.happened', async () => {});

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

describe('EventConsumer claim leases', () => {
  let bus: FakeEventBusConsumer;
  let lease: FakeLease;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
    lease = new FakeLease(60_000);
    bus.lease = lease;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeConsumer(overrides: Partial<EventConsumerOptions> = {}): EventConsumer {
    return new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      instanceId: 'replica-1',
      ...overrides,
    });
  }

  function gate(): { promise: Promise<void>; open: () => void } {
    const { promise, resolve } = Promise.withResolvers<void>();
    return { promise, open: resolve };
  }

  it('renews only the in-flight row while its handler runs', async () => {
    const slow = gate();
    const consumer = makeConsumer();
    consumer.on('test.happened', async (entry) => {
      if (entry.id === 'evt-1') await slow.promise;
    });
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' }), makeBusEntry({ id: 'evt-2' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(lease.renewCalls).toEqual([
      { instanceId: 'replica-1', ids: ['evt-1'] },
      { instanceId: 'replica-1', ids: ['evt-1'] },
    ]);

    slow.open();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    // The tail row aged past one interval, so it is confirmed before dispatch.
    expect(lease.renewCalls[2]).toEqual({ instanceId: 'replica-1', ids: ['evt-2'] });
    expect(bus.marksDone).toEqual(['evt-1', 'evt-2']);
  });

  it('does not query before dispatch while the claim is fresh', async () => {
    const consumer = makeConsumer();
    consumer.on('test.happened', async () => {});
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' }), makeBusEntry({ id: 'evt-2' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(lease.renewCalls).toHaveLength(0);
    expect(bus.marksDone).toEqual(['evt-1', 'evt-2']);
  });

  it('skips a tail row whose claim was lost before dispatch', async () => {
    const slow = gate();
    const handled: string[] = [];
    const onLeaseLost = vi.fn();
    const consumer = makeConsumer({ onLeaseLost });
    consumer.on('test.happened', async (entry) => {
      handled.push(entry.id);
      if (entry.id === 'evt-1') await slow.promise;
    });
    lease.lost.add('evt-2');
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' }), makeBusEntry({ id: 'evt-2' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    slow.open();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    expect(handled).toEqual(['evt-1']);
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).toHaveBeenCalledWith({
      id: 'evt-2',
      eventType: 'test.happened',
      stage: 'renew',
    });
  });

  it('reports a lease lost mid-handler once and still completes the row', async () => {
    const slow = gate();
    const logger = new NoopLogger();
    const warn = vi.spyOn(logger, 'warn');
    const onLeaseLost = vi.fn();
    const consumer = makeConsumer({ logger, onLeaseLost });
    consumer.on('test.happened', async () => {
      await slow.promise;
    });
    lease.lost.add('evt-1');
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    slow.open();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    expect(lease.renewCalls).toHaveLength(1);
    expect(onLeaseLost).toHaveBeenCalledTimes(1);
    expect(onLeaseLost).toHaveBeenCalledWith({
      id: 'evt-1',
      eventType: 'test.happened',
      stage: 'renew',
    });
    expect(warn).toHaveBeenCalledWith(
      'claim lease lost; event may run more than once',
      expect.objectContaining({ meta: expect.objectContaining({ eventId: 'evt-1' }) }),
    );
    expect(bus.marksDone).toEqual(['evt-1']);
  });

  it('does not report a row that completes while a renew is in flight', async () => {
    const slow = gate();
    const renewing = gate();
    const onLeaseLost = vi.fn();
    vi.spyOn(lease, 'renew').mockImplementation(async () => {
      await renewing.promise;
      return [];
    });
    const consumer = makeConsumer({ onLeaseLost });
    consumer.on('test.happened', async () => {
      await slow.promise;
    });
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(20_000);
    slow.open();
    await vi.advanceTimersByTimeAsync(0);
    renewing.open();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    expect(bus.marksDone).toEqual(['evt-1']);
    expect(onLeaseLost).not.toHaveBeenCalled();
  });

  it('reports ClaimLostError from markDone and keeps processing the batch', async () => {
    const onLeaseLost = vi.fn();
    const consumer = makeConsumer({ onLeaseLost });
    consumer.on('test.happened', async () => {});
    bus.claimLost.add('evt-1');
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' }), makeBusEntry({ id: 'evt-2' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(onLeaseLost).toHaveBeenCalledWith({
      id: 'evt-1',
      eventType: 'test.happened',
      stage: 'done',
    });
    expect(bus.marksDone).toEqual(['evt-2']);
  });

  it('reports ClaimLostError from markFailed with stage failed', async () => {
    const onLeaseLost = vi.fn();
    const consumer = makeConsumer({ onLeaseLost, retryDelaysMs: [] });
    consumer.on('test.happened', async () => {
      throw new Error('boom');
    });
    bus.claimLost.add('evt-1');
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(onLeaseLost).toHaveBeenCalledWith({
      id: 'evt-1',
      eventType: 'test.happened',
      stage: 'failed',
    });
  });

  it('passes its instanceId to markDone and markFailed', async () => {
    const consumer = makeConsumer({ retryDelaysMs: [] });
    consumer.on('test.happened', async (entry) => {
      if (entry.id === 'evt-2') throw new Error('boom');
    });
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' }), makeBusEntry({ id: 'evt-2' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.markInstanceIds).toEqual(['replica-1', 'replica-1']);
  });

  it('renewIntervalMs: 0 disables renewal and warns at start', async () => {
    const slow = gate();
    const logger = new NoopLogger();
    const warn = vi.spyOn(logger, 'warn');
    const consumer = makeConsumer({ logger, renewIntervalMs: 0 });
    consumer.on('test.happened', async () => {
      await slow.promise;
    });
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(60_000);
    slow.open();
    await consumer.dispose();

    expect(lease.renewCalls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(
      'claim renewal disabled; work longer than the lease will be re-dispatched',
      { meta: { leaseMs: 60_000 } },
    );
  });

  it('does not renew or warn when the bus has no lease', async () => {
    const plainBus = new FakeEventBusConsumer();
    const logger = new NoopLogger();
    const warn = vi.spyOn(logger, 'warn');
    const consumer = makeConsumer({ bus: plainBus, logger });
    consumer.on('test.happened', async () => {});
    plainBus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(warn).not.toHaveBeenCalled();
    expect(plainBus.marksDone).toEqual(['evt-1']);
  });

  it('rejects a renew interval at or above the lease', () => {
    expect(() => makeConsumer({ renewIntervalMs: 60_000 })).toThrow(/renewIntervalMs/);
    expect(() => makeConsumer({ renewIntervalMs: -1 })).toThrow(/renewIntervalMs/);
  });
});

describe('EventConsumer execution context reconstruction', () => {
  let bus: FakeEventBusConsumer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function contextFor(metadata: Record<string, unknown>): Promise<ExecutionContext> {
    const provider = new AsyncExecutionContextProvider();
    let seen: ExecutionContext | undefined;
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      executionContext: { provider },
    });
    consumer.on('test.happened', async () => {
      seen = provider.getContext();
    });
    // Metadata as it comes back from the bus: the parsed `EventMetadata.toJSON()` shape.
    bus.enqueueBatch([makeBusEntry({ payload: { payload: {}, metadata } })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();
    if (!seen) throw new Error('handler did not run');
    return seen;
  }

  it('rebuilds a system event with null ids as a session-less context', async () => {
    const ctx = await contextFor({
      kind: 'domain',
      correlationId: 'corr-1',
      actorType: 'system',
      scopeId: null,
      userId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(ctx.session).toBeUndefined();
    expect(ctx.correlationId).toBe('corr-1');
  });

  it('rebuilds extended session fields carried in actorAttributes', async () => {
    const ctx = await contextFor({
      kind: 'domain',
      correlationId: 'corr-1',
      actorType: 'user',
      scopeId: 'scope-1',
      userId: 'user-1',
      actorAttributes: { projectId: 'p-1' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(ctx.session).toEqual({ scopeId: 'scope-1', userId: 'user-1', projectId: 'p-1' });
  });
});
