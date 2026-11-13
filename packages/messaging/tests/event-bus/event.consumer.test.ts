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
import type { RetryPolicy } from '../../src/event-bus/retry.policy.js';
import { FakeEventBusConsumer } from '../helpers/fake-bus.js';
import { FakeDeliveryQueue, makeDelivery } from '../helpers/fake-deliveries.js';
import { FakeLease } from '../helpers/fake-lease.js';
import { FakeOutcomeStore } from '../helpers/fake-outcome-store.js';

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

  it('claims with a failover window of twice the poll interval by default', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      pollIntervalMs: 500,
    });
    consumer.on('test.happened', async () => {});

    consumer.start();
    await vi.advanceTimersByTimeAsync(500);
    await consumer.dispose();

    expect(bus.claimed[0]?.options).toEqual({ failoverWindowMs: 1000 });
  });

  it('passes failoverWindowMs through, including 0', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      failoverWindowMs: 0,
    });
    consumer.on('test.happened', async () => {});

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.claimed[0]?.options).toEqual({ failoverWindowMs: 0 });
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

  it('makes one attempt per claim and hands a failure back with its retry delay', async () => {
    const handler = vi.fn(async () => {
      throw new Error('transient');
    });
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [10, 20],
    });
    consumer.on('test.happened', handler);
    bus.enqueueBatch([makeBusEntry({ retryCount: 0 })]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.marksFailed).toEqual([{ id: 'evt-1', reason: 'transient' }]);
    expect(bus.markFailedOptions).toEqual([{ retryAfterMs: 10 }]);
    expect(bus.marksDone).toHaveLength(0);
  });

  it('picks the delay by attempt and repeats the last one', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [10, 20],
    });
    consumer.on('test.happened', async () => {
      throw new Error('transient');
    });
    bus.enqueueBatch([
      makeBusEntry({ id: 'e1', retryCount: 1 }),
      makeBusEntry({ id: 'e2', retryCount: 5 }),
    ]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.markFailedOptions).toEqual([{ retryAfterMs: 20 }, { retryAfterMs: 20 }]);
  });

  it('retries at once with an empty retryDelaysMs', async () => {
    const consumer = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [],
    });
    consumer.on('test.happened', async () => {
      throw new Error('transient');
    });
    bus.enqueueBatch([makeBusEntry()]);

    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(bus.markFailedOptions).toEqual([{ retryAfterMs: 0 }]);
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
      source: 'event',
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
    expect(onFailed).toHaveBeenCalledWith(expect.anything(), { permanent: true, source: 'event' });
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

    expect(handler).toHaveBeenCalledTimes(1);
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
    expect(onFailed).toHaveBeenCalledWith(expect.anything(), { permanent: false, source: 'event' });
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

describe('EventConsumer handler outcomes', () => {
  let bus: FakeEventBusConsumer;
  let store: FakeOutcomeStore;
  let logger: NoopLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    bus = new FakeEventBusConsumer();
    store = new FakeOutcomeStore();
    logger = new NoopLogger();
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
      logger,
      retryDelaysMs: [],
      handlerOutcomes: store,
      isPermanentFailure: (err) => err instanceof Gone,
      ...overrides,
    });
  }

  async function run(consumer: EventConsumer, entries: EventBusEntry[]) {
    bus.enqueueBatch(entries);
    consumer.start();
    await vi.advanceTimersByTimeAsync(1100);
    await consumer.dispose();
  }

  // One bus attempt per call; the fake bus doesn't redeliver, so each attempt is enqueued.
  const attempt = (consumer: EventConsumer, retryCount: number) =>
    run(consumer, [makeBusEntry({ retryCount })]);

  function failTimes(times: number, error: () => Error = () => new Error('smtp down')) {
    let calls = 0;
    return vi.fn(async () => {
      calls++;
      if (calls <= times) throw error();
    });
  }

  it('re-runs only the handler that failed: a succeeded neighbour runs once', async () => {
    const bridge = vi.fn(async () => {});
    const email = failTimes(1);
    const consumer = makeConsumer()
      .on('test.happened', bridge, { key: 'bridge' })
      .on('test.happened', email, { key: 'email' });

    await attempt(consumer, 0);
    await attempt(consumer, 1);

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(2);
    expect(bus.marksFailed).toEqual([{ id: 'evt-1', reason: 'smtp down' }]);
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(store.records).toEqual([
      { eventId: 'evt-1', outcomes: [{ key: 'bridge', outcome: 'done' }] },
    ]);
  });

  it('runs the succeeded handler once while the other exhausts retries', async () => {
    const bridge = vi.fn(async () => {});
    const email = failTimes(Number.POSITIVE_INFINITY);
    const onFailed = vi.fn();
    const consumer = makeConsumer({ onFailed })
      .on('test.happened', bridge, { key: 'bridge' })
      .on('test.happened', email, { key: 'email' });

    for (const retryCount of [0, 1, 2]) await attempt(consumer, retryCount);

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(3);
    expect(bus.marksFailed.map((m) => m.reason)).toEqual(['smtp down', 'smtp down', 'smtp down']);
    expect(onFailed).toHaveBeenLastCalledWith(expect.objectContaining({ lastError: 'smtp down' }), {
      permanent: false,
      source: 'event',
    });
  });

  it('skips a permanently failed handler while a transient one retries, then dead-letters', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {
      throw new Gone('aggregate gone');
    });
    const c = failTimes(1);
    const onFailed = vi.fn();
    const consumer = makeConsumer({ onFailed })
      .on('test.happened', a, { key: 'a' })
      .on('test.happened', b, { key: 'b' })
      .on('test.happened', c, { key: 'c' });

    await attempt(consumer, 0);
    expect(bus.marksFailed).toHaveLength(1);
    expect(store.outcomesOf('evt-1').get('b')).toEqual({
      key: 'b',
      outcome: 'dead',
      error: 'aggregate gone',
    });

    await attempt(consumer, 1);

    expect([a, b, c].map((h) => h.mock.calls.length)).toEqual([1, 1, 2]);
    expect(bus.marksFailedPermanently).toEqual([{ id: 'evt-1', reason: 'aggregate gone' }]);
    expect(onFailed).toHaveBeenLastCalledWith(expect.anything(), {
      permanent: true,
      source: 'event',
    });
    expect(store.outcomesOf('evt-1').get('c')?.outcome).toBe('done');
  });

  it('re-runs dead handlers once their outcomes are cleared, but not done ones', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    await store.record('evt-1', [
      { key: 'a', outcome: 'done' },
      { key: 'b', outcome: 'dead', error: 'old bug' },
    ]);
    await store.clear(['evt-1']);
    const consumer = makeConsumer()
      .on('test.happened', a, { key: 'a' })
      .on('test.happened', b, { key: 'b' });

    await attempt(consumer, 0);

    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(bus.marksDone).toEqual(['evt-1']);
  });

  it('keeps skipping a dead handler whatever the retryCount until it is cleared', async () => {
    const b = vi.fn(async () => {});
    await store.record('evt-1', [
      { key: 'a', outcome: 'done' },
      { key: 'b', outcome: 'dead', error: 'old bug' },
    ]);
    const consumer = makeConsumer()
      .on('test.happened', async () => {}, { key: 'a' })
      .on('test.happened', b, { key: 'b' });

    // e.g. a crash between recording and markFailed: the row comes back with retryCount 0
    await attempt(consumer, 0);

    expect(b).not.toHaveBeenCalled();
    expect(bus.marksFailedPermanently).toEqual([{ id: 'evt-1', reason: 'old bug' }]);
  });

  it('dead-letters without running anything, and warns, when only dead handlers remain', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    await store.record('evt-1', [
      { key: 'a', outcome: 'done' },
      { key: 'b', outcome: 'dead', error: 'old bug' },
    ]);
    const consumer = makeConsumer()
      .on('test.happened', a, { key: 'a' })
      .on('test.happened', b, { key: 'b' });

    await attempt(consumer, 3);

    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
    expect(bus.marksFailedPermanently).toEqual([{ id: 'evt-1', reason: 'old bug' }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('bus.replay()'), expect.anything());
  });

  it('writes nothing on the happy path and loads once per batch', async () => {
    const consumer = makeConsumer()
      .on('test.happened', async () => {}, { key: 'a' })
      .on('test.happened', async () => {}, { key: 'b' });
    await run(consumer, [makeBusEntry({ id: 'e1' }), makeBusEntry({ id: 'e2' })]);

    expect(store.loads).toEqual([['e1', 'e2']]);
    expect(store.records).toEqual([]);
    expect(bus.marksDone).toEqual(['e1', 'e2']);
  });

  it('leaves single-handler event types out of the ledger', async () => {
    const handler = failTimes(1);
    const consumer = makeConsumer().on('test.happened', handler);

    await attempt(consumer, 0);
    await attempt(consumer, 1);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(store.loads).toEqual([]);
    expect(store.records).toEqual([]);
  });

  it('runs every handler when loading outcomes fails', async () => {
    const error = vi.spyOn(logger, 'error');
    store.loadError = new Error('db down');
    await store.record('evt-1', [{ key: 'a', outcome: 'done' }]);
    const a = vi.fn(async () => {});
    const consumer = makeConsumer()
      .on('test.happened', a, { key: 'a' })
      .on('test.happened', async () => {}, { key: 'b' });

    await attempt(consumer, 1);

    expect(a).toHaveBeenCalledTimes(1);
    expect(bus.marksDone).toEqual(['evt-1']);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('loading handler outcomes failed'),
      store.loadError,
      expect.anything(),
    );
  });

  it('still settles when recording outcomes fails', async () => {
    store.recordError = new Error('db down');
    const consumer = makeConsumer()
      .on('test.happened', async () => {}, { key: 'a' })
      .on('test.happened', failTimes(1), { key: 'b' });

    await attempt(consumer, 0);

    expect(bus.marksFailed).toEqual([{ id: 'evt-1', reason: 'smtp down' }]);
  });

  it('requires a unique key per handler of a multi-handler type as it is registered', () => {
    const missing = makeConsumer().on('test.happened', async () => {}, { key: 'a' });
    expect(() => missing.on('test.happened', async () => {})).toThrow(/each handler needs a `key`/);

    const duplicate = makeConsumer().on('test.happened', async () => {}, { key: 'a' });
    expect(() => duplicate.on('test.happened', async () => {}, { key: 'a' })).toThrow(
      /duplicate handler key "a"/,
    );
  });

  it('does not require keys for one handler, or without a store', () => {
    expect(() => makeConsumer().on('test.happened', async () => {})).not.toThrow();
    const noStore = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-a',
      logger,
    });
    expect(() =>
      noStore.on('test.happened', async () => {}).on('test.happened', async () => {}),
    ).not.toThrow();
  });

  it('takes keys from subscriptions', async () => {
    const OrderPlaced = defineEvent<{ orderId: string }>('test.happened');
    const a = vi.fn(async () => {});
    const subs: EventSubscription<unknown>[] = [
      { descriptor: OrderPlaced, key: 'a', handle: a },
      { descriptor: OrderPlaced, key: 'b', handle: failTimes(1) },
    ];
    const consumer = makeConsumer({ subscriptions: subs });

    await attempt(consumer, 0);
    await attempt(consumer, 1);

    expect(a).toHaveBeenCalledTimes(1);
  });

  describe('edge cases', () => {
    it('loads outcomes only for events of multi-handler types in a mixed batch', async () => {
      const consumer = makeConsumer()
        .on('test.happened', async () => {}, { key: 'a' })
        .on('test.happened', async () => {}, { key: 'b' })
        .on('other.thing', async () => {});

      await run(consumer, [
        makeBusEntry({ id: 'e1' }),
        makeBusEntry({ id: 'e2', eventType: 'other.thing' }),
      ]);

      expect(store.loads).toEqual([['e1']]);
      expect(bus.marksDone).toEqual(['e1', 'e2']);
    });

    it('records every handler dead and dead-letters once when all fail permanently', async () => {
      const onFailed = vi.fn();
      const consumer = makeConsumer({ onFailed })
        .on(
          'test.happened',
          async () => {
            throw new Gone('a gone');
          },
          { key: 'a' },
        )
        .on(
          'test.happened',
          async () => {
            throw new Gone('b gone');
          },
          { key: 'b' },
        );

      await run(consumer, [makeBusEntry()]);

      expect(bus.marksFailed).toEqual([]);
      expect(bus.marksFailedPermanently).toEqual([{ id: 'evt-1', reason: 'b gone' }]);
      expect(store.records).toEqual([
        {
          eventId: 'evt-1',
          outcomes: [
            { key: 'a', outcome: 'dead', error: 'a gone' },
            { key: 'b', outcome: 'dead', error: 'b gone' },
          ],
        },
      ]);
      expect(onFailed).toHaveBeenCalledWith(expect.anything(), {
        permanent: true,
        source: 'event',
      });
    });

    it('keeps recorded outcomes and reports a lost claim instead of onFailed', async () => {
      bus.claimLost.add('evt-1');
      const onFailed = vi.fn();
      const onLeaseLost = vi.fn();
      const consumer = makeConsumer({ onFailed, onLeaseLost })
        .on('test.happened', async () => {}, { key: 'a' })
        .on(
          'test.happened',
          async () => {
            throw new Error('flaky');
          },
          { key: 'b' },
        );

      await run(consumer, [makeBusEntry()]);

      expect(store.outcomesOf('evt-1').get('a')?.outcome).toBe('done');
      expect(onFailed).not.toHaveBeenCalled();
      expect(onLeaseLost).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'evt-1', stage: 'failed' }),
      );
    });

    it('ignores stored outcomes whose key no longer matches a handler', async () => {
      await store.record('evt-1', [
        { key: 'renamed-away', outcome: 'done' },
        { key: 'removed', outcome: 'dead', error: 'old' },
      ]);
      const a = vi.fn(async () => {});
      const b = vi.fn(async () => {});
      const consumer = makeConsumer()
        .on('test.happened', a, { key: 'a' })
        .on('test.happened', b, { key: 'b' });

      await run(consumer, [makeBusEntry({ retryCount: 1 })]);

      expect(a).toHaveBeenCalledTimes(1);
      expect(b).toHaveBeenCalledTimes(1);
      expect(bus.marksDone).toEqual(['evt-1']);
    });

    it('marks the row done without a warning when every handler already finished', async () => {
      const warn = vi.spyOn(logger, 'warn');
      await store.record('evt-1', [
        { key: 'a', outcome: 'done' },
        { key: 'b', outcome: 'done' },
      ]);
      const a = vi.fn(async () => {});
      const consumer = makeConsumer()
        .on('test.happened', a, { key: 'a' })
        .on('test.happened', async () => {}, { key: 'b' });

      await run(consumer, [makeBusEntry({ retryCount: 1 })]);

      expect(a).not.toHaveBeenCalled();
      expect(bus.marksDone).toEqual(['evt-1']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('finishes the event in flight when shutdown starts mid-dispatch', async () => {
      const b = vi.fn(async () => {});
      const consumer = makeConsumer();
      consumer
        .on(
          'test.happened',
          async () => {
            void consumer.dispose();
          },
          { key: 'a' },
        )
        .on('test.happened', b, { key: 'b' });

      await run(consumer, [makeBusEntry()]);

      expect(b).toHaveBeenCalledTimes(1);
      expect(store.records).toEqual([]);
      expect(bus.marksDone).toEqual(['evt-1']);
    });
  });
});

// Compiled by `pnpm typecheck`, never run.
function _keyOptionTypes(consumer: EventConsumer, sub: EventSubscription) {
  const Placed = defineEvent<{ orderId: string }>('order.placed');
  const scoped = async (_entry: ScopedHandlerEntry<{ orderId: string }>) => {};
  consumer.on(Placed, async () => {}, { key: 'a' });
  consumer.on('order.placed', async () => {}, { key: 'a' });
  consumer.on(Placed, scoped, { key: 'a', requires: 'scope' });
  consumer.on('order.placed', scoped as never, { requires: 'session', key: 'a' });
  // @ts-expect-error a scoped handler needs `requires`, not just a key
  consumer.on(Placed, scoped, { key: 'a' });
  // @ts-expect-error keys are strings
  consumer.on(Placed, async () => {}, { key: 1 });
  const keyed: EventSubscription = { ...sub, key: 'a' };
  const scopedSub: ScopedEventSubscription = {
    descriptor: Placed,
    requires: 'scope',
    key: 'a',
    handle: scoped,
  };
  return [keyed, scopedSub];
}
void _keyOptionTypes;

describe('EventConsumer isolation', () => {
  let bus: FakeEventBusConsumer;
  let deliveries: FakeDeliveryQueue;
  let logger: NoopLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
    bus = new FakeEventBusConsumer();
    deliveries = new FakeDeliveryQueue();
    bus.deliveries = deliveries;
    logger = new NoopLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function consumer(overrides: Partial<EventConsumerOptions> = {}): EventConsumer {
    return new EventConsumer({
      bus,
      consumerName: 'svc',
      sourceService: 'svc-a',
      logger,
      isolation: true,
      ...overrides,
    });
  }

  async function runOnce(c: EventConsumer): Promise<void> {
    c.start();
    await vi.advanceTimersByTimeAsync(1000);
    await c.dispose();
  }

  describe('configuration', () => {
    it('needs a bus with deliveries', () => {
      bus = new FakeEventBusConsumer();
      expect(() => consumer()).toThrow(/needs a bus with `deliveries`/);
    });

    it('excludes handlerOutcomes', () => {
      expect(() => consumer({ handlerOutcomes: new FakeOutcomeStore() })).toThrow(/exclusive/);
    });

    it('needs a key on every handler, even a lone one', () => {
      expect(() => consumer().on('test.happened', async () => {})).toThrow(/needs a `key`/);
    });

    it('rejects two different explicit policies for one subscriber, in any order', () => {
      const c = consumer().on('a.happened', async () => {}, { key: 'mail' });
      c.on('b.happened', async () => {}, { key: 'mail', retry: { maxAttempts: 3 } });
      expect(() =>
        c.on('c.happened', async () => {}, { key: 'mail', retry: { maxAttempts: 5 } }),
      ).toThrow(/two different retry policies/);
    });

    it('accepts the same policy repeated, whatever its field order', () => {
      const c = consumer().on('a.happened', async () => {}, {
        key: 'mail',
        retry: { maxAttempts: 3, delaysMs: [1, 2] },
      });
      expect(() =>
        c.on('b.happened', async () => {}, {
          key: 'mail',
          retry: { delaysMs: [1, 2], maxAttempts: 3 },
        }),
      ).not.toThrow();
    });

    it('validates attempt budgets', () => {
      expect(() => consumer({ maxAttempts: 0 })).toThrow(/maxAttempts/);
      expect(() =>
        consumer().on('a.happened', async () => {}, { key: 'k', retry: { maxAttempts: 1.5 } }),
      ).toThrow(/retry.maxAttempts/);
      expect(() => consumer({ maxAttempts: Number.POSITIVE_INFINITY })).not.toThrow();
    });
  });

  describe('event path', () => {
    it('settles a fully handled event with markDone and no deliveries', async () => {
      const onProcessed = vi.fn();
      const c = consumer({ onProcessed }).on('test.happened', async () => {}, { key: 'a' });
      bus.enqueueBatch([makeBusEntry()]);

      await runOnce(c);

      expect(bus.marksDone).toEqual(['evt-1']);
      expect(deliveries.settled).toEqual([]);
      expect(onProcessed).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1' }), {
        source: 'event',
      });
    });

    it('moves a failed handler to its own delivery and never re-runs the one that finished', async () => {
      const ok = vi.fn(async () => {});
      const onFailed = vi.fn();
      const c = consumer({ onFailed })
        .on('test.happened', ok, { key: 'projection' })
        .on(
          'test.happened',
          async () => {
            throw new Error('smtp down');
          },
          { key: 'mail' },
        );
      bus.enqueueBatch([makeBusEntry({ aggregateId: 'agg-1' })]);

      await runOnce(c);

      expect(ok).toHaveBeenCalledTimes(1);
      expect(bus.marksDone).toEqual([]);
      expect(bus.marksFailed).toEqual([]);
      expect(deliveries.settled).toEqual([
        {
          eventId: 'evt-1',
          consumerName: 'svc',
          deliveries: [
            {
              handlerKey: 'mail',
              status: 'PENDING',
              retryCount: 1,
              lastError: 'smtp down',
              lastFailedBy: expect.any(String),
              nextAttemptAt: new Date('2026-06-01T00:00:02Z'),
            },
          ],
        },
      ]);
      expect(onFailed).toHaveBeenCalledWith(
        expect.objectContaining({ handlerKey: 'mail', eventId: 'evt-1' }),
        { permanent: false, source: 'delivery', handlerKey: 'mail' },
      );
    });

    it('dead-letters a permanent failure, or one the policy gives a single attempt', async () => {
      const c = consumer()
        .on(
          'test.happened',
          async () => {
            throw new SchemaValidationError('test.happened', []);
          },
          { key: 'strict' },
        )
        .on(
          'test.happened',
          async () => {
            throw new Error('down');
          },
          { key: 'once', retry: { maxAttempts: 1 } },
        );
      bus.enqueueBatch([makeBusEntry()]);

      await runOnce(c);

      expect(deliveries.settled[0]?.deliveries.map((d) => [d.handlerKey, d.status])).toEqual([
        ['strict', 'FAILED'],
        ['once', 'FAILED'],
      ]);
    });

    it('queues a handler behind its open lane without running it, and runs the others', async () => {
      const mail = vi.fn(async () => {});
      const projection = vi.fn(async () => {});
      deliveries.lanes = [{ handlerKey: 'mail', aggregateId: 'agg-1' }];
      const c = consumer()
        .on('test.happened', mail, { key: 'mail' })
        .on('test.happened', projection, { key: 'projection' });
      bus.enqueueBatch([makeBusEntry({ aggregateId: 'agg-1' })]);

      await runOnce(c);

      expect(mail).not.toHaveBeenCalled();
      expect(projection).toHaveBeenCalledTimes(1);
      expect(deliveries.settled[0]?.deliveries).toEqual([
        { handlerKey: 'mail', status: 'PENDING', retryCount: 0 },
      ]);
    });

    it("queues the aggregate's later events behind a failure in the same batch, and keeps going", async () => {
      const calls: string[] = [];
      const c = consumer()
        .on(
          'test.happened',
          async (e) => {
            calls.push(`mail:${e.id}`);
            if (e.id === 'e1') throw new Error('down');
          },
          { key: 'mail' },
        )
        .on(
          'test.happened',
          async (e) => {
            calls.push(`projection:${e.id}`);
          },
          { key: 'projection' },
        );
      bus.enqueueBatch([
        makeBusEntry({ id: 'e1', aggregateId: 'agg-1' }),
        makeBusEntry({ id: 'e2', aggregateId: 'agg-1' }),
      ]);

      await runOnce(c);

      expect(calls).toEqual(['mail:e1', 'projection:e1', 'projection:e2']);
      expect(deliveries.settled.map((s) => [s.eventId, s.deliveries[0]?.retryCount])).toEqual([
        ['e1', 1],
        ['e2', 0],
      ]);
    });

    it('runs an event without an aggregate straight away: it has no lane', async () => {
      const handler = vi.fn(async () => {});
      deliveries.lanes = [{ handlerKey: 'a', aggregateId: 'agg-1' }];
      const c = consumer().on('test.happened', handler, { key: 'a' });
      bus.enqueueBatch([makeBusEntry()]);

      await runOnce(c);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(bus.marksDone).toEqual(['evt-1']);
    });

    it('runs nothing when the open lanes cannot be read', async () => {
      const handler = vi.fn(async () => {});
      deliveries.lanesError = new Error('db down');
      const c = consumer().on('test.happened', handler, { key: 'a' });
      bus.enqueueBatch([makeBusEntry({ aggregateId: 'agg-1' })]);

      await runOnce(c);

      expect(handler).not.toHaveBeenCalled();
      expect(bus.marksDone).toEqual([]);
      expect(deliveries.settled).toEqual([]);
    });

    it('reports nothing as failed when the claim was lost while settling', async () => {
      const onFailed = vi.fn();
      const onLeaseLost = vi.fn();
      deliveries.claimLost.add('evt-1');
      const c = consumer({ onFailed, onLeaseLost }).on(
        'test.happened',
        async () => {
          throw new Error('down');
        },
        { key: 'a' },
      );
      bus.enqueueBatch([makeBusEntry()]);

      await runOnce(c);

      expect(onFailed).not.toHaveBeenCalled();
      expect(onLeaseLost).toHaveBeenCalledWith(expect.objectContaining({ id: 'evt-1' }));
    });
  });

  describe('delivery path', () => {
    it("claims the registered (key, type) pairs and runs only that subscriber, with the event's id", async () => {
      const mail = vi.fn(async (_e: HandlerEntry) => {});
      const projection = vi.fn(async () => {});
      const onProcessed = vi.fn();
      const c = consumer({ onProcessed, deliveryBatchSize: 5 })
        .on('test.happened', mail, { key: 'mail' })
        .on('test.happened', projection, { key: 'projection' })
        .on('other.happened', mail, { key: 'mail' });
      const delivery = makeDelivery({ id: 'd-1', eventId: 'evt-9', handlerKey: 'mail' });
      deliveries.enqueueBatch([delivery]);

      await runOnce(c);

      expect(deliveries.claims[0]).toEqual({
        batchSize: 5,
        consumerName: 'svc',
        pairs: [
          { key: 'mail', eventType: 'test.happened' },
          { key: 'projection', eventType: 'test.happened' },
          { key: 'mail', eventType: 'other.happened' },
        ],
      });
      expect(mail).toHaveBeenCalledTimes(1);
      expect(mail.mock.calls[0]?.[0].id).toBe('evt-9');
      expect(projection).not.toHaveBeenCalled();
      expect(deliveries.marksDone).toEqual(['d-1']);
      expect(onProcessed).toHaveBeenCalledWith(delivery, {
        source: 'delivery',
        handlerKey: 'mail',
      });
    });

    function failing(c: EventConsumer, retry?: RetryPolicy): EventConsumer {
      return c.on(
        'test.happened',
        async () => {
          throw new Error('down');
        },
        { key: 'mail', ...(retry ? { retry } : {}) },
      );
    }

    it("schedules the retry by the subscriber's policy", async () => {
      const c = failing(consumer({ retryDelaysMs: [1, 2] }), {
        delaysMs: [5_000, 60_000],
        maxAttempts: Number.POSITIVE_INFINITY,
      });
      deliveries.enqueueBatch([makeDelivery({ id: 'd-1', handlerKey: 'mail', retryCount: 3 })]);

      await runOnce(c);

      expect(deliveries.marksFailed).toEqual([
        { id: 'd-1', reason: 'down', options: { retryAfterMs: 60_000 } },
      ]);
    });

    it('moves the retry up to the deadline, and dead-letters once it has passed', async () => {
      const c = failing(consumer(), {
        delaysMs: [60_000],
        maxAttempts: Number.POSITIVE_INFINITY,
        maxAgeMs: 30_000,
      });
      const queuedAt = new Date('2026-06-01T00:00:00Z');
      deliveries.enqueueBatch([
        makeDelivery({ id: 'young', handlerKey: 'mail', aggregateId: 'a', queuedAt }),
        makeDelivery({ id: 'old', handlerKey: 'mail', aggregateId: 'b', queuedAt: new Date(0) }),
      ]);

      await runOnce(c);

      expect(deliveries.marksFailed).toEqual([
        { id: 'young', reason: 'down', options: { retryAfterMs: 29_000 } },
      ]);
      expect(deliveries.marksFailedPermanently.map((m) => m.id)).toEqual(['old']);
    });

    it('defaults the budget from the consumer', async () => {
      const c = failing(consumer({ retryDelaysMs: [10, 20], maxAttempts: 7 }));
      deliveries.enqueueBatch([
        makeDelivery({ id: 'fresh', handlerKey: 'mail', aggregateId: 'a', retryCount: 0 }),
        makeDelivery({ id: 'spent', handlerKey: 'mail', aggregateId: 'b', retryCount: 6 }),
      ]);

      await runOnce(c);

      expect(deliveries.marksFailed).toEqual([
        { id: 'fresh', reason: 'down', options: { retryAfterMs: 10 } },
      ]);
      expect(deliveries.marksFailedPermanently.map((m) => m.id)).toEqual(['spent']);
    });

    it('runs one delivery per lane per batch once one fails', async () => {
      const handler = vi.fn(async () => {
        throw new Error('down');
      });
      const c = consumer().on('test.happened', handler, { key: 'mail' });
      deliveries.enqueueBatch([
        makeDelivery({ id: 'd-1', handlerKey: 'mail', aggregateId: 'agg-1' }),
        makeDelivery({ id: 'd-2', handlerKey: 'mail', aggregateId: 'agg-1' }),
      ]);

      await runOnce(c);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('moves renamed subscribers before dispatching, and warns about orphans', async () => {
      const warn = vi.spyOn(logger, 'warn');
      deliveries.orphans = 2;
      const c = consumer().on('test.happened', async () => {}, {
        key: 'iam.users.mail',
        previousKeys: ['MailHandler'],
      });

      await runOnce(c);

      expect(deliveries.rekeys).toEqual([
        { consumerName: 'svc', from: ['MailHandler'], to: 'iam.users.mail' },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('previousKeys'), expect.anything());
    });

    it('dead-letters a permanent failure at once, and tells it apart from a spent budget', async () => {
      const onFailed = vi.fn();
      const c = consumer({ onFailed, maxAttempts: 2 }).on(
        'test.happened',
        async (e) => {
          if (e.payload === 'bad') throw new SchemaValidationError('test.happened', []);
          throw new Error('down');
        },
        { key: 'mail' },
      );
      deliveries.enqueueBatch([
        makeDelivery({ id: 'bad', handlerKey: 'mail', aggregateId: 'a', payload: 'bad' }),
        makeDelivery({ id: 'spent', handlerKey: 'mail', aggregateId: 'b', retryCount: 1 }),
      ]);

      await runOnce(c);

      expect(deliveries.marksFailed).toEqual([]);
      expect(deliveries.marksFailedPermanently.map((m) => m.id)).toEqual(['bad', 'spent']);
      expect(onFailed.mock.calls.map(([entry, info]) => [entry.id, info])).toEqual([
        ['bad', { permanent: true, source: 'delivery', handlerKey: 'mail' }],
        ['spent', { permanent: false, source: 'delivery', handlerKey: 'mail' }],
      ]);
    });

    it('dispatches nothing until renamed subscribers are moved, retrying after an error', async () => {
      deliveries.rekeyErrors = 1;
      const handler = vi.fn(async () => {});
      const c = consumer().on('test.happened', handler, { key: 'new', previousKeys: ['old'] });
      bus.enqueueBatch([makeBusEntry({ id: 'e1' })]);
      bus.enqueueBatch([makeBusEntry({ id: 'e2' })]);

      c.start();
      await vi.advanceTimersByTimeAsync(1000);
      expect(handler).not.toHaveBeenCalled();
      expect(bus.claimed).toEqual([]);
      await vi.advanceTimersByTimeAsync(1000);
      await c.dispose();

      expect(deliveries.rekeys).toHaveLength(2);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('drains deliveries without isolation, so turning it off strands nothing', async () => {
      const handler = vi.fn(async () => {});
      const c = consumer({ isolation: false }).on('test.happened', handler, { key: 'mail' });
      deliveries.enqueueBatch([makeDelivery({ id: 'd-1', handlerKey: 'mail' })]);
      bus.enqueueBatch([makeBusEntry()]);

      await runOnce(c);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(deliveries.marksDone).toEqual(['d-1']);
      expect(bus.marksDone).toEqual(['evt-1']);
    });

    it('keeps claiming events while a delivery is stuck', async () => {
      let release: () => void = () => {};
      const stuck = new Promise<void>((resolve) => {
        release = resolve;
      });
      const events = vi.fn(async () => {});
      const c = consumer()
        .on('test.happened', async () => stuck, { key: 'slow' })
        .on('other.happened', events, { key: 'fast' });
      deliveries.enqueueBatch([makeDelivery({ id: 'd-1', handlerKey: 'slow' })]);
      bus.enqueueBatch([makeBusEntry({ id: 'e1', eventType: 'other.happened' })]);
      bus.enqueueBatch([makeBusEntry({ id: 'e2', eventType: 'other.happened' })]);

      c.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(events).toHaveBeenCalledTimes(2);
      release();
      await c.dispose();
      expect(deliveries.marksDone).toEqual(['d-1']);
    });
  });
});
