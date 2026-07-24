import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventConsumer } from '../src/event-bus/event.consumer.js';
import type { HandlerEntry } from '../src/event-bus/handler-entry.type.js';
import { OutboxForwarder } from '../src/local-outbox/outbox.forwarder.js';
import { PgEventBus } from '../src/postgres/pg-event-bus.js';
import { PgLocalOutbox } from '../src/postgres/pg-local-outbox.js';
import { CapturingTrx } from './helpers/capturing-trx.js';
import { FakeEventBusPublisher } from './helpers/fake-bus.js';
import { FakePgPool } from './helpers/fake-pg-pool.js';

const OCCURRED_AT = new Date('2025-12-31T23:59:00Z');

describe('occurredAt round-trip', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('survives insert -> claim -> forward -> publish -> claim -> handler', async () => {
    // 1. INSERT — the caller supplies the event's occurredAt.
    const outboxPool = new FakePgPool();
    const outbox = new PgLocalOutbox({ pool: outboxPool.asPool() });
    const trx = new CapturingTrx();
    await outbox.insert(
      [
        {
          id: 'outbox-1',
          eventType: 'order.placed',
          eventKind: 'domain',
          payload: { orderId: 'o-1' },
          aggregateId: 'agg-1',
          occurredAt: OCCURRED_AT,
        },
      ],
      trx,
    );
    const insertedOccurredAt = trx.calls[0]?.params[14] as Date;
    expect(insertedOccurredAt).toBe(OCCURRED_AT);

    // 2. CLAIM — the outbox row (carrying the inserted occurred_at) is claimed and
    //    mapped back to a LocalOutboxEntry, then 3. FORWARDed onto the bus.
    outboxPool.enqueue([], 0); // resetStale
    outboxPool.enqueue([
      {
        id: 'outbox-1',
        event_type: 'order.placed',
        event_version: 1,
        event_kind: 'domain',
        payload: { orderId: 'o-1' },
        aggregate_id: 'agg-1',
        correlation_id: null,
        status: 'CLAIMED',
        claimed_by: 'replica-1',
        claimed_at: new Date('2026-01-01T00:00:05Z'),
        retry_count: 0,
        last_error: null,
        published_at: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        occurred_at: insertedOccurredAt,
      },
    ]);

    const publisher = new FakeEventBusPublisher();
    const forwarder = new OutboxForwarder({
      reader: outbox,
      publisher,
      sourceService: 'orders',
      logger: new NoopLogger(),
      instanceId: 'replica-1',
    });
    forwarder.start();
    await vi.advanceTimersByTimeAsync(1000);
    await forwarder.dispose();

    // 4. PUBLISH carried occurredAt through as a first-class field.
    const publishedOccurredAt = publisher.published[0]?.event.occurredAt;
    expect(publishedOccurredAt).toBe(OCCURRED_AT);

    // 5. CLAIM off the bus + 6. HANDLER — the consumer maps the events row back to
    //    an EventBusEntry and threads occurredAt into the HandlerEntry.
    const busPool = new FakePgPool();
    const bus = new PgEventBus({ pool: busPool.asPool() });
    busPool.enqueue([], 0); // resetStale
    busPool.enqueue([
      {
        id: 'bus-1',
        event_type: 'order.placed',
        event_version: 1,
        event_kind: 'domain',
        payload: { orderId: 'o-1' },
        source_service: 'orders',
        aggregate_id: 'agg-1',
        correlation_id: null,
        origin_event_id: 'outbox-1',
        status: 'CLAIMED',
        claimed_by: 'consumer-1',
        claimed_at: new Date('2026-01-01T00:00:06Z'),
        retry_count: 0,
        last_error: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        published_at: new Date('2026-01-01T00:00:02Z'),
        occurred_at: publishedOccurredAt as Date,
      },
    ]);

    let received: HandlerEntry | undefined;
    const consumer = new EventConsumer({
      bus,
      consumerName: 'notifications',
      sourceService: 'notifications',
      logger: new NoopLogger(),
    });
    consumer.on('order.placed', async (entry) => {
      received = entry;
    });
    consumer.start();
    await vi.advanceTimersByTimeAsync(1000);
    await consumer.dispose();

    expect(received?.occurredAt).toBe(OCCURRED_AT);
  });
});
