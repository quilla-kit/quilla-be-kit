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
    it('deletes the owned event and copies it, with its sequence, into the deliveries in one statement', async () => {
      pool.enqueue([
        {
          ...EVENT_ROW,
          settled: 1,
          id: 'd-1',
          event_id: 'evt-1',
          member: 'user.disabled',
          seq: '900',
          event_seq: '41',
          holds_lane: null,
        },
      ]);
      const created = await queue.settle(
        'evt-1',
        'svc',
        [
          {
            handlerKey: 'mail',
            member: 'user.disabled',
            status: 'FAILED',
            retryCount: 1,
            lastError: 'down',
            holdsLane: true,
          },
        ],
        'inst-1',
      );

      const call = pool.calls[0];
      expect(call?.sql).toContain('DELETE FROM events');
      expect(call?.sql).toContain('(claimed_by = $2 OR claimed_by IS NULL)');
      expect(call?.sql).toContain('INSERT INTO event_deliveries');
      expect(call?.sql).toContain('g.seq');
      expect(call?.sql).toContain(
        "n.holds_lane AND n.status = 'FAILED' AND g.aggregate_id IS NOT NULL",
      );
      expect(call?.sql).toContain(
        'ON CONFLICT (event_id, consumer_name, handler_key, member) DO NOTHING',
      );
      expect(call?.params.slice(0, 3)).toEqual(['evt-1', 'inst-1', 'svc']);
      expect(call?.params.slice(5)).toEqual([
        ['mail'],
        ['user.disabled'],
        ['FAILED'],
        [1],
        ['down'],
        [null],
        [null],
        [true],
      ]);
      expect(created).toEqual([
        expect.objectContaining({
          id: 'd-1',
          member: 'user.disabled',
          sequence: '41',
          holdsLane: false,
        }),
      ]);
    });

    it('returns nothing for deliveries that already existed', async () => {
      pool.enqueue([{ settled: 1, id: null }]);
      expect(
        await queue.settle(
          'evt-1',
          'svc',
          [{ handlerKey: 'a', member: 't', status: 'PENDING', retryCount: 0 }],
          'i',
        ),
      ).toEqual([]);
    });

    it('throws ClaimLostError when the event was not ours to settle', async () => {
      pool.enqueue([{ settled: 0, id: null }]);
      await expect(
        queue.settle(
          'evt-1',
          'svc',
          [{ handlerKey: 'a', member: 't', status: 'PENDING', retryCount: 1 }],
          'i',
        ),
      ).rejects.toBeInstanceOf(ClaimLostError);
    });
  });

  describe('claim', () => {
    it('filters by (key, member) and guards the lane, holds and the busy event', async () => {
      pool.enqueue([]);
      await queue.claim(
        'inst-1',
        10,
        'svc',
        [{ key: 'mail', member: 'm', eventType: 'user.disabled' }],
        { failoverWindowMs: 2000 },
      );

      const claim = pool.clientCalls[1];
      expect(claim?.sql).toContain(
        '(e.handler_key, e.member) IN (SELECT * FROM unnest($5::text[], $6::text[]))',
      );
      expect(claim?.sql).toContain('w.event_id <> e.event_id');
      expect(claim?.sql).toContain("w.status = 'FAILED' AND w.holds_lane IS TRUE");
      expect(claim?.sql).toContain('FROM events b');
      expect(claim?.sql).toContain('unnest($5::text[], $7::text[]) AS p(k, t)');
      expect(claim?.sql).toContain(
        "hashtext(concat_ws(E'\\x1f', e.consumer_name, e.aggregate_id, e.handler_key))",
      );
      expect(claim?.params.slice(0, 2)).toEqual([10, 'inst-1']);
      expect(claim?.params.slice(3, 7)).toEqual(['svc', ['mail'], ['m'], ['user.disabled']]);
      const [now, cutoff] = [claim?.params[2] as Date, claim?.params[8] as Date];
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

  it('dead-letters, holding the lane only for work with an aggregate', async () => {
    pool.enqueue([], 1);
    await queue.markFailedPermanently('d-1', 'down', 'inst-1', { holdLane: true });
    const call = pool.calls[0];
    expect(call?.sql).toContain('holds_lane = $5 AND aggregate_id IS NOT NULL');
    expect(call?.params[4]).toBe(true);
    expect(call?.sql).toContain('claimed_by = $6');
  });

  it('replays with a fresh budget, a new queue time, and the hold released', async () => {
    pool.enqueue([{ ...EVENT_ROW, id: 'd-1', member: 'm', event_seq: null, holds_lane: false }]);
    const replayed = await queue.replay(['d-1']);
    expect(replayed.map((d) => d.id)).toEqual(['d-1']);
    expect(pool.calls[0]?.sql).toContain('retry_count = 0, queued_at = $2, holds_lane = false');
    expect(pool.calls[0]?.sql).toContain("WHERE id = ANY($1) AND status = 'FAILED'");
  });

  it('releases holds and keeps held rows out of retention', async () => {
    pool.enqueue([]);
    await queue.releaseHold(['d-1']);
    expect(pool.calls[0]?.sql).toContain('SET holds_lane = false');
    pool.enqueue([], 0);
    await queue.cleanupFailed(new Date());
    expect(pool.calls[1]?.sql).toContain('AND NOT (holds_lane IS TRUE)');
  });

  it('rekeys under a per-consumer advisory lock, superseding collisions', async () => {
    pool.enqueue([]);
    pool.enqueue([{ moved: 2, superseded: 1 }]);
    const result = await queue.rekey('svc', [
      { from: { key: 'Old', member: 't' }, to: { key: 'new.key', member: 't' } },
    ]);
    expect(result).toEqual({ moved: 2, superseded: 1 });
    expect(pool.clientCalls[1]?.sql).toContain('pg_advisory_xact_lock');
    expect(pool.clientCalls[2]?.sql).toContain("last_error = 'rekey: superseded'");
    expect(pool.clientCalls[2]?.params.slice(0, 5)).toEqual([
      'svc',
      ['Old'],
      ['t'],
      ['new.key'],
      ['t'],
    ]);
  });

  it('summarizes the backlog per member', async () => {
    pool.enqueue([{ handler_key: 'a', member: 't', queued: 3, held: 1, lanes: 2 }]);
    expect(await queue.backlog('svc')).toEqual([
      { handlerKey: 'a', member: 't', queued: 3, held: 1, lanes: 2 },
    ]);
  });
});
