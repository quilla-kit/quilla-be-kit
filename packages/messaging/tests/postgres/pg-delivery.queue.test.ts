import { beforeEach, describe, expect, it } from 'vitest';
import { ClaimLostError } from '../../src/event-bus/claim-lost.error.js';
import { PgDeliveryQueue } from '../../src/postgres/pg-delivery.queue.js';
import { PgEventBus } from '../../src/postgres/pg-event-bus.js';
import { FakePgPool } from '../helpers/fake-pg-pool.js';

const EVENT_ROW = {
  id: 'evt-1',
  event_type: 'user.disabled',
  event_version: 1,
  event_kind: 'domain',
  payload: { userId: 'u-1' },
  source_service: 'iam',
  aggregate_id: 'agg-1',
  correlation_id: null,
  occurred_at: new Date('2026-01-01T00:00:00Z'),
  created_at: new Date('2026-01-01T00:00:00Z'),
  published_at: new Date('2026-01-01T00:00:01Z'),
};

describe('PgDeliveryQueue', () => {
  let pool: FakePgPool;
  let queue: PgDeliveryQueue;

  beforeEach(() => {
    pool = new FakePgPool();
    queue = new PgDeliveryQueue({
      pool: pool.asPool(),
      table: 'event_deliveries',
      eventsTable: 'events',
      leaseMs: 60_000,
    });
  });

  it('is offered by PgEventBus only when asked', () => {
    expect(new PgEventBus({ pool: pool.asPool() }).deliveries).toBeUndefined();
    const bus = new PgEventBus({ pool: pool.asPool(), deliveries: true });
    expect(bus.deliveries).toBeInstanceOf(PgDeliveryQueue);
    expect(bus.deliveries?.lease.durationMs).toBe(60_000);
  });

  describe('settle', () => {
    it('deletes the owned event and copies it into the deliveries in one statement', async () => {
      pool.enqueue([{ ...EVENT_ROW, settled: 1, id: 'd-1', event_id: 'evt-1' }]);
      const created = await queue.settle(
        'evt-1',
        'svc',
        [{ handlerKey: 'mail', status: 'PENDING', retryCount: 1, lastError: 'down' }],
        'inst-1',
      );

      const call = pool.calls[0];
      expect(call?.sql).toContain('DELETE FROM events');
      expect(call?.sql).toContain('(claimed_by = $2 OR claimed_by IS NULL)');
      expect(call?.sql).toContain('INSERT INTO event_deliveries');
      expect(call?.sql).toContain('ON CONFLICT (event_id, consumer_name, handler_key) DO NOTHING');
      expect(call?.params.slice(0, 3)).toEqual(['evt-1', 'inst-1', 'svc']);
      expect(call?.params.slice(5)).toEqual([['mail'], ['PENDING'], [1], ['down'], [null], [null]]);
      expect(created.map((d) => d.id)).toEqual(['d-1']);
    });

    it('returns nothing for deliveries that already existed', async () => {
      pool.enqueue([{ settled: 1, id: null }]);
      expect(
        await queue.settle(
          'evt-1',
          'svc',
          [{ handlerKey: 'a', status: 'PENDING', retryCount: 0 }],
          'i',
        ),
      ).toEqual([]);
    });

    it('throws ClaimLostError when the event was not ours to settle', async () => {
      pool.enqueue([{ settled: 0, id: null }]);
      await expect(
        queue.settle('evt-1', 'svc', [{ handlerKey: 'a', status: 'PENDING', retryCount: 1 }], 'i'),
      ).rejects.toBeInstanceOf(ClaimLostError);
    });
  });

  describe('claim', () => {
    it('filters by (key, type) pairs and guards the lane and the busy event', async () => {
      pool.enqueue([]);
      await queue.claim('inst-1', 10, 'svc', [{ key: 'mail', eventType: 'user.disabled' }], {
        failoverWindowMs: 2000,
      });

      const claim = pool.clientCalls[1];
      expect(claim?.sql).toContain(
        '(e.handler_key, e.event_type) IN (SELECT * FROM unnest($5::text[], $6::text[]))',
      );
      expect(claim?.sql).toContain('FROM events b');
      expect(claim?.sql).toContain('WHERE p.k = e.handler_key');
      expect(claim?.sql).toContain(
        "hashtext(concat_ws(E'\\x1f', e.consumer_name, e.aggregate_id, e.handler_key))",
      );
      expect(claim?.params.slice(0, 2)).toEqual([10, 'inst-1']);
      expect(claim?.params.slice(3, 6)).toEqual(['svc', ['mail'], ['user.disabled']]);
      const [now, cutoff] = [claim?.params[2] as Date, claim?.params[7] as Date];
      expect(now.getTime() - cutoff.getTime()).toBe(2000);
    });

    it('claims nothing without pairs', async () => {
      expect(await queue.claim('inst-1', 10, 'svc', [])).toEqual([]);
      expect(pool.clientCalls).toEqual([]);
    });
  });

  it('schedules retries without an attempt cap: the consumer applies the budget', async () => {
    pool.enqueue([], 1);
    await queue.markFailed('d-1', 'down', 'inst-1', { retryAfterMs: 5000 });
    const call = pool.calls[0];
    expect(call?.params[2]).toBe(2_147_483_647);
    expect((call?.params[5] as Date).getTime() - (call?.params[3] as Date).getTime()).toBe(5000);
  });

  it('replays with a fresh budget and a new queue time', async () => {
    pool.enqueue([{ id: 'd-1' }]);
    expect(await queue.replay(['d-1'])).toEqual(['d-1']);
    expect(pool.calls[0]?.sql).toContain('retry_count = 0, queued_at = $2');
    expect(pool.calls[0]?.sql).toContain("WHERE id = ANY($1) AND status = 'FAILED'");
  });

  it('rekeys without colliding with a delivery already under the new key', async () => {
    pool.enqueue([], 3);
    expect(await queue.rekey('svc', ['Old'], 'new.key')).toBe(3);
    expect(pool.calls[0]?.params).toEqual(['svc', ['Old'], 'new.key']);
    expect(pool.calls[0]?.sql).toContain('AND o.handler_key = $3');
  });

  it('counts orphans outside the registered pairs', async () => {
    pool.enqueue([{ count: '2' }]);
    expect(await queue.countOrphans('svc', [{ key: 'a', eventType: 't' }])).toBe(2);
    expect(pool.calls[0]?.sql).toContain('NOT IN (SELECT * FROM unnest($2::text[], $3::text[]))');
  });
});
