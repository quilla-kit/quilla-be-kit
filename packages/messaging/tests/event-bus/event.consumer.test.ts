import {
  AsyncExecutionContextProvider,
  type ExecutionContext,
  executionContextFactory,
  requireScopeId,
} from '@quilla-be-kit/execution-context';
import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { EventBusEntry } from '../../src/event-bus/event-bus-entry.type.js';
import type {
  EventSubscription,
  ScopedEventSubscription,
} from '../../src/event-bus/event-subscription.interface.js';
import {
  EventConsumer,
  type EventConsumerOptions,
  SchemaValidationError,
} from '../../src/event-bus/event.consumer.js';
import { defineEvent } from '../../src/event-bus/event.descriptor.js';
import { createHandlerEntry } from '../../src/event-bus/handler-entry.factory.js';
import type { HandlerEntry, ScopedHandlerEntry } from '../../src/event-bus/handler-entry.type.js';
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

  describe('onFailed', () => {
    function failing(overrides: Partial<EventConsumerOptions> = {}): EventConsumer {
      const consumer = new EventConsumer({
        bus,
        consumerName: 'test',
        sourceService: 'svc-a',
        logger: new NoopLogger(),
        retryDelaysMs: [],
        instanceId: 'replica-1',
        ...overrides,
      });
      consumer.on('test.happened', async () => {
        throw new Error('boom');
      });
      return consumer;
    }

    it('gets the updated entry for a retry and for a dead letter', async () => {
      const onFailed = vi.fn();
      const consumer = failing({ onFailed });
      bus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);
      consumer.start();
      await vi.advanceTimersByTimeAsync(1000);
      bus.failedStatus = 'FAILED';
      bus.enqueueBatch([makeBusEntry({ id: 'evt-2', retryCount: 2 })]);
      await vi.advanceTimersByTimeAsync(1000);
      await consumer.dispose();

      expect(onFailed).toHaveBeenCalledTimes(2);
      expect(onFailed.mock.calls[0]?.[0]).toMatchObject({
        id: 'evt-1',
        status: 'PENDING',
        retryCount: 1,
        lastError: 'boom',
      });
      expect(onFailed.mock.calls[1]?.[0]).toMatchObject({
        id: 'evt-2',
        status: 'FAILED',
        retryCount: 3,
        lastError: 'boom',
        failedAt: expect.any(Date),
      });
    });

    it('is not called when the claim was lost', async () => {
      const onFailed = vi.fn();
      const onLeaseLost = vi.fn();
      bus.claimLost.add('evt-1');
      const consumer = failing({ onFailed, onLeaseLost });
      bus.enqueueBatch([makeBusEntry({ id: 'evt-1' })]);
      consumer.start();
      await vi.advanceTimersByTimeAsync(1000);
      await consumer.dispose();

      expect(onFailed).not.toHaveBeenCalled();
      expect(onLeaseLost).toHaveBeenCalledTimes(1);
    });
  });

  it('contains throwing hooks without abandoning the batch', async () => {
    const logger = new NoopLogger();
    const error = vi.spyOn(logger, 'error');
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger,
      retryDelaysMs: [],
      onProcessed: () => {
        throw new Error('processed hook bug');
      },
      onFailed: () => {
        throw new Error('failed hook bug');
      },
    });
    consumer.on('ok.type', async () => {});
    consumer.on('fail.type', async () => {
      throw new Error('boom');
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'ok-1', eventType: 'ok.type' }),
      makeBusEntry({ id: 'fail-1', eventType: 'fail.type' }),
      makeBusEntry({ id: 'ok-2', eventType: 'ok.type' }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.marksDone).toEqual(['ok-1', 'ok-2']);
    expect(bus.marksFailed.map((m) => m.id)).toEqual(['fail-1']);
    expect(error).toHaveBeenCalledWith('onProcessed hook threw', expect.any(Error), {
      meta: { eventId: 'ok-1' },
    });
    expect(error).toHaveBeenCalledWith('onFailed hook threw', expect.any(Error), {
      meta: { eventId: 'fail-1' },
    });
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

  it('validates payload against the descriptor schema and dead-letters a mismatch', async () => {
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
    expect(bus.marksFailed).toHaveLength(0);
    expect(bus.marksFailedPermanently).toHaveLength(1);
    expect(bus.marksFailedPermanently[0]?.reason).toMatch(/schema validation failed/);
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
    expect(bus.marksFailedPermanently).toHaveLength(1);
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

  it('renews the in-flight row and hands back the waiting rows after one interval', async () => {
    const slow = gate();
    const handled: string[] = [];
    const onLeaseLost = vi.fn();
    const consumer = makeConsumer({ onLeaseLost });
    consumer.on('test.happened', async (entry) => {
      handled.push(entry.id);
      if (entry.id === 'evt-1') await slow.promise;
    });
    bus.enqueueBatch([makeBusEntry({ id: 'evt-1' }), makeBusEntry({ id: 'evt-2' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(40_000);

    expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-2'] }]);
    expect(lease.renewCalls).toEqual([
      { instanceId: 'replica-1', ids: ['evt-1'] },
      { instanceId: 'replica-1', ids: ['evt-1'] },
    ]);

    slow.open();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    expect(handled).toEqual(['evt-1']);
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(lease.releaseCalls).toHaveLength(1);
    expect(onLeaseLost).not.toHaveBeenCalled();
  });

  it('renews the waiting rows with the in-flight one when the lease cannot release', async () => {
    lease = new FakeLease(60_000, { release: false });
    bus.lease = lease;
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
      { instanceId: 'replica-1', ids: ['evt-1', 'evt-2'] },
      { instanceId: 'replica-1', ids: ['evt-1', 'evt-2'] },
    ]);

    slow.open();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    expect(bus.marksDone).toEqual(['evt-1', 'evt-2']);
  });

  it('hands back the rows it has not started when stopped mid-batch', async () => {
    const slow = gate();
    const consumer = makeConsumer();
    consumer.on('test.happened', async (entry) => {
      if (entry.id === 'evt-1') await slow.promise;
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'evt-1' }),
      makeBusEntry({ id: 'evt-2' }),
      makeBusEntry({ id: 'evt-3' }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    const disposed = consumer.dispose();
    slow.open();
    await disposed;

    expect(bus.marksDone).toEqual(['evt-1']);
    expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-2', 'evt-3'] }]);
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

  it('skips a tail row whose claim was lost before dispatch, without reporting it', async () => {
    lease = new FakeLease(60_000, { release: false });
    bus.lease = lease;
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
    expect(onLeaseLost).not.toHaveBeenCalled();
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

describe('EventConsumer per-aggregate ordering within a batch', () => {
  let bus: FakeEventBusConsumer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function run(handle: (entry: HandlerEntry<unknown>) => Promise<void>, lease?: FakeLease) {
    if (lease) bus.lease = lease;
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [],
    });
    consumer.on('test.happened', handle);
    return consumer;
  }

  it('skips the rest of an aggregate after one of its events fails', async () => {
    const handled: string[] = [];
    const consumer = run(async (entry) => {
      handled.push(entry.id);
      if (entry.id === 'x1') throw new Error('boom');
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'x1', aggregateId: 'X' }),
      makeBusEntry({ id: 'y1', aggregateId: 'Y' }),
      makeBusEntry({ id: 'x2', aggregateId: 'X' }),
      makeBusEntry({ id: 'n1' }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handled).toEqual(['x1', 'y1', 'n1']);
    expect(bus.marksFailed.map((m) => m.id)).toEqual(['x1']);
    expect(bus.marksDone).toEqual(['y1', 'n1']);
  });

  it('holds an aggregate behind a permanent failure for the rest of the batch only', async () => {
    const handled: string[] = [];
    const consumer = run(async (entry) => {
      handled.push(entry.id);
      if (entry.id === 'x1') throw new SchemaValidationError('test.happened', []);
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'x1', aggregateId: 'X' }),
      makeBusEntry({ id: 'x2', aggregateId: 'X' }),
    ]);
    bus.enqueueBatch([makeBusEntry({ id: 'x2', aggregateId: 'X' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(2000);
    await consumer.dispose();

    expect(bus.marksFailedPermanently.map((m) => m.id)).toEqual(['x1']);
    expect(handled).toEqual(['x1', 'x2']);
    expect(bus.marksDone).toEqual(['x2']);
  });

  it('skips the rest of an aggregate after a lost claim before dispatch', async () => {
    const lease = new FakeLease(60_000);
    const slow = Promise.withResolvers<void>();
    const handled: string[] = [];
    const consumer = run(async (entry) => {
      handled.push(entry.id);
      if (entry.id === 'y1') await slow.promise;
    }, lease);
    lease.lost.add('x1');
    bus.enqueueBatch([
      makeBusEntry({ id: 'y1', aggregateId: 'Y' }),
      makeBusEntry({ id: 'x1', aggregateId: 'X' }),
      makeBusEntry({ id: 'x2', aggregateId: 'X' }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(30_000);
    slow.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await consumer.dispose();

    expect(handled).toEqual(['y1']);
    expect(bus.marksDone).toEqual(['y1']);
  });

  it('skips the rest of an aggregate after an unregistered event type', async () => {
    const handled: string[] = [];
    const consumer = run(async (entry) => {
      handled.push(entry.id);
    });
    // A broker that ignores allowedTopics hands over an unregistered type.
    vi.spyOn(bus, 'claim').mockResolvedValueOnce([
      makeBusEntry({ id: 'x1', aggregateId: 'X', eventType: 'unknown.type' }),
      makeBusEntry({ id: 'x2', aggregateId: 'X' }),
      makeBusEntry({ id: 'y1', aggregateId: 'Y' }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handled).toEqual(['y1']);
  });

  it('starts every batch with no blocked aggregates', async () => {
    let failOnce = true;
    const handled: string[] = [];
    const consumer = run(async (entry) => {
      handled.push(entry.id);
      if (failOnce) {
        failOnce = false;
        throw new Error('boom');
      }
    });
    bus.enqueueBatch([makeBusEntry({ id: 'x1', aggregateId: 'X' })]);
    bus.enqueueBatch([makeBusEntry({ id: 'x1', aggregateId: 'X' })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(2000);
    await consumer.dispose();

    expect(handled).toEqual(['x1', 'x1']);
    expect(bus.marksDone).toEqual(['x1']);
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

describe('EventConsumer handler context', () => {
  let bus: FakeEventBusConsumer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tenantMetadata = {
    kind: 'domain',
    correlationId: 'corr-1',
    actorType: 'user',
    scopeId: 'tenant-1',
    userId: 'user-1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const systemMetadata = { ...tenantMetadata, actorType: 'system', scopeId: null, userId: null };

  function makeConsumer(
    provider = new AsyncExecutionContextProvider(),
    overrides: Partial<EventConsumerOptions> = {},
  ) {
    return new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      executionContext: { provider },
      ...overrides,
    });
  }

  function unwired() {
    return new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });
  }

  function withMetadata(metadata: Record<string, unknown>, overrides: Partial<EventBusEntry> = {}) {
    return makeBusEntry({ payload: { payload: { foo: 'bar' }, metadata }, ...overrides });
  }

  async function run(
    consumer: EventConsumer,
    entries: Record<string, unknown> | EventBusEntry[],
    ms = 1000,
  ) {
    bus.enqueueBatch(Array.isArray(entries) ? entries : [withMetadata(entries)]);
    consumer.start();
    await vi.advanceTimersByTimeAsync(ms);
    await consumer.dispose();
  }

  it('exposes the resolved context view through entry.getContext()', async () => {
    const consumer = makeConsumer();
    let view: unknown;
    consumer.on('test.happened', async (entry) => {
      view = entry.getContext();
    });
    await run(consumer, tenantMetadata);
    expect(view).toMatchObject({
      actorType: 'user',
      correlationId: 'corr-1',
      scopeId: 'tenant-1',
      userId: 'user-1',
      session: { scopeId: 'tenant-1', userId: 'user-1' },
    });
  });

  it('reads live: it follows withScope and crossScope inside the handler', async () => {
    const provider = new AsyncExecutionContextProvider({ scopeCrossing: { authorize: () => {} } });
    const consumer = makeConsumer(provider);
    const seen: (string | undefined)[] = [];
    consumer.on('test.happened', async (entry) => {
      seen.push(entry.getContext().scopeId);
      await provider.withScope('scope-a', async () => {
        seen.push(entry.getContext().scopeId);
        await provider.crossScope('scope-b', async () => {
          seen.push(entry.getContext().scopeId);
          seen.push(entry.getContext().crossedFrom);
        });
      });
    });
    await run(consumer, systemMetadata);
    expect(seen).toEqual([undefined, 'scope-a', 'scope-b', 'scope-a']);
  });

  it('stays live after schema validation', async () => {
    const consumer = makeConsumer();
    const Described = defineEvent('test.happened', z.object({ foo: z.string() }));
    let scopeId: string | undefined;
    consumer.on(Described, async (entry) => {
      scopeId = entry.getContext().scopeId;
    });
    await run(consumer, tenantMetadata);
    expect(scopeId).toBe('tenant-1');
  });

  it('throws when the entry is read outside its dispatch', async () => {
    const consumer = makeConsumer();
    let captured: HandlerEntry | undefined;
    consumer.on('test.happened', async (entry) => {
      captured = entry;
    });
    await run(consumer, tenantMetadata);
    expect(() => captured?.getContext()).toThrow(/outside the dispatch of its handler/);
  });

  it('throws when the entry escapes into another dispatch', async () => {
    const provider = new AsyncExecutionContextProvider();
    const consumer = makeConsumer(provider);
    const entries: HandlerEntry[] = [];
    let crossRead: unknown;
    consumer.on('test.happened', async (entry) => {
      const first = entries[0];
      entries.push(entry);
      if (first) {
        try {
          first.getContext();
        } catch (err) {
          crossRead = err;
        }
      }
    });
    await run(consumer, [
      withMetadata(tenantMetadata, { id: 'e1' }),
      withMetadata({ ...tenantMetadata, scopeId: 'tenant-2' }, { id: 'e2' }),
    ]);
    expect(entries).toHaveLength(2);
    expect(crossRead).toBeInstanceOf(Error);
    expect((crossRead as Error).message).toMatch(/outside the dispatch of its handler/);
  });

  it('re-checks the requirement on read after a scope-dropping runWithContext', async () => {
    const provider = new AsyncExecutionContextProvider();
    const consumer = makeConsumer(provider);
    let caught: unknown;
    consumer.on(
      'test.happened',
      async (entry) => {
        const ctx = provider.getContext();
        const { session: _session, ...unscoped } = ctx;
        await provider.runWithContext(unscoped, async () => {
          try {
            entry.getContext();
          } catch (err) {
            caught = err;
          }
        });
      },
      { requires: 'scope' },
    );
    await run(consumer, tenantMetadata);
    expect((caught as { code?: string }).code).toBe('MISSING_SCOPE');
  });

  it('serializes an entry from an unwired consumer without throwing', async () => {
    const consumer = unwired();
    let json: string | undefined;
    let readError: unknown;
    consumer.on('test.happened', async (entry) => {
      json = JSON.stringify(entry);
      try {
        entry.getContext();
      } catch (err) {
        readError = err;
      }
    });
    await run(consumer, [makeBusEntry()]);
    expect(json).toContain('"id":"evt-1"');
    expect((readError as Error).message).toMatch(/no `executionContext` wired/);
  });

  it('rejects a requirement on a consumer without executionContext at registration', () => {
    expect(() => unwired().on('test.happened', async () => {}, { requires: 'scope' })).toThrow(
      /requires a scope, but no `executionContext` is wired/,
    );
  });

  it('fails only the handler whose requirement is unmet and dead-letters the event once', async () => {
    const plain = vi.fn(async () => {});
    const needsSession = vi.fn(async () => {});
    const onFailed = vi.fn();
    const consumer = makeConsumer(undefined, { onFailed });
    consumer.on('test.happened', plain);
    consumer.on('test.happened', needsSession, { requires: 'session' });

    await run(consumer, systemMetadata);

    expect(plain).toHaveBeenCalledTimes(1);
    expect(needsSession).not.toHaveBeenCalled();
    expect(bus.marksFailed).toHaveLength(0);
    expect(bus.marksFailedPermanently).toHaveLength(1);
    expect(bus.marksFailedPermanently[0]?.reason).toMatch(/session is required/);
    expect(onFailed).toHaveBeenCalledTimes(1);
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }), {
      permanent: true,
    });
  });

  it('dead-letters without in-process retries when a handler throws MissingScopeError', async () => {
    const provider = new AsyncExecutionContextProvider();
    const consumer = makeConsumer(provider);
    const handler = vi.fn(async () => {
      requireScopeId(provider.getContext());
    });
    consumer.on('test.happened', handler);
    await run(consumer, systemMetadata);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.marksFailedPermanently).toHaveLength(1);
  });

  it('narrows the entry for a class-based ScopedEventSubscription', async () => {
    const Described = defineEvent<{ foo: string }>('test.happened');
    const seen: string[] = [];
    class OnHappened implements ScopedEventSubscription<{ foo: string }> {
      readonly descriptor = Described;
      readonly requires = 'scope';
      async handle(entry: ScopedHandlerEntry<{ foo: string }>): Promise<void> {
        const scopeId: string = entry.getContext().scopeId;
        seen.push(scopeId);
      }
    }
    const consumer = makeConsumer();
    consumer.subscribe([new OnHappened()]);
    await run(consumer, tenantMetadata);
    expect(seen).toEqual(['tenant-1']);
  });
});

describe('createHandlerEntry', () => {
  it('builds an entry whose getContext returns a fixed view', () => {
    const view = {
      actorType: 'user',
      correlationId: 'c',
      executionAttemptId: 'a',
      scopeId: 's-1',
    } as const;
    const entry = createHandlerEntry(
      { id: 'e', payload: 1, eventType: 't', eventVersion: 1, occurredAt: new Date(0) },
      view,
    );
    const scoped: ScopedHandlerEntry<number> = entry;
    expect(scoped.getContext().scopeId).toBe('s-1');
  });
});

describe('EventConsumer permanent failures', () => {
  let bus: FakeEventBusConsumer;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  class Gone extends Error {}

  function makeConsumer(overrides: Partial<EventConsumerOptions> = {}) {
    return new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [10, 10],
      ...overrides,
    });
  }

  async function runOnce(consumer: EventConsumer, entry: EventBusEntry = makeBusEntry()) {
    bus.enqueueBatch([entry]);
    consumer.start();
    await vi.advanceTimersByTimeAsync(1100);
    await consumer.dispose();
  }

  it('dead-letters an error the app classifies as permanent, without retries', async () => {
    const handler = vi.fn(async () => {
      throw new Gone('aggregate deleted');
    });
    const isPermanentFailure = vi.fn((err: unknown) => err instanceof Gone);
    const onFailed = vi.fn();
    const consumer = makeConsumer({ isPermanentFailure, onFailed });
    consumer.on('test.happened', handler);
    await runOnce(consumer);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(isPermanentFailure).toHaveBeenCalledWith(expect.any(Gone), {
      entry: expect.objectContaining({ id: 'evt-1', eventType: 'test.happened' }),
    });
    expect(bus.marksFailedPermanently).toEqual([{ id: 'evt-1', reason: 'aggregate deleted' }]);
    expect(onFailed).toHaveBeenCalledWith(expect.anything(), { permanent: true });
  });

  it('treats the failure as transient when the classifier throws', async () => {
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const consumer = makeConsumer({
      isPermanentFailure: () => {
        throw new Error('classifier bug');
      },
    });
    consumer.on('test.happened', handler);
    await runOnce(consumer);

    expect(handler).toHaveBeenCalledTimes(3);
    expect(bus.marksFailed).toEqual([{ id: 'evt-1', reason: 'boom' }]);
    expect(bus.marksFailedPermanently).toHaveLength(0);
  });

  it('redelivers when a permanent failure is mixed with a transient one', async () => {
    const onFailed = vi.fn();
    const consumer = makeConsumer({ isPermanentFailure: (e) => e instanceof Gone, onFailed });
    consumer.on('test.happened', async () => {
      throw new Gone('gone');
    });
    consumer.on('test.happened', async () => {
      throw new Error('flaky');
    });
    await runOnce(consumer);

    expect(bus.marksFailed).toEqual([{ id: 'evt-1', reason: 'flaky' }]);
    expect(bus.marksFailedPermanently).toHaveLength(0);
    expect(onFailed).toHaveBeenCalledWith(expect.anything(), { permanent: false });
  });

  it('redelivers a handler cut short by shutdown even after a permanent failure', async () => {
    const consumer = makeConsumer({ isPermanentFailure: (e) => e instanceof Gone });
    consumer.on('test.happened', async () => {
      throw new Gone('gone');
    });
    consumer.on('test.happened', async () => {
      void consumer.dispose();
      throw new Error('interrupted');
    });
    await runOnce(consumer);

    expect(bus.marksFailedPermanently).toHaveLength(0);
    expect(bus.marksFailed).toHaveLength(1);
  });

  it('dead-letters when the execution context cannot be rebuilt from the event', async () => {
    const factory = {
      ...executionContextFactory,
      createFromEventMetadata: () => {
        throw new Error('corrupt metadata');
      },
    };
    const consumer = makeConsumer({
      executionContext: { provider: new AsyncExecutionContextProvider({ factory }) },
    });
    const handler = vi.fn(async () => {});
    consumer.on('test.happened', handler);
    await runOnce(
      consumer,
      makeBusEntry({ payload: { payload: {}, metadata: { actorType: 'user' } } }),
    );

    expect(handler).not.toHaveBeenCalled();
    expect(bus.marksFailedPermanently).toEqual([{ id: 'evt-1', reason: 'corrupt metadata' }]);
  });
});
