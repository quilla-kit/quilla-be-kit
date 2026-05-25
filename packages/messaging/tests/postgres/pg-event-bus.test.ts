import { beforeEach, describe, expect, it } from 'vitest';
import { PgEventBus } from '../../src/postgres/pg-event-bus.js';
import { FakePgPool } from '../helpers/fake-pg-pool.js';

describe('PgEventBus', () => {
  let pool: FakePgPool;
  let bus: PgEventBus;

  beforeEach(() => {
    pool = new FakePgPool();
    bus = new PgEventBus({ pool: pool.asPool() });
  });

  describe('publish', () => {
    it('inserts into the events table with PENDING status and returns the generated id', async () => {
      const returnedId = await bus.publish({
        eventType: 'order.placed',
        eventVersion: 1,
        eventKind: 'domain',
        payload: { orderId: 'o-1' },
        sourceService: 'svc-a',
        aggregateId: 'agg-1',
        correlationId: 'corr-1',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });

      const call = pool.calls[0];
      expect(call?.sql).toContain('INSERT INTO events');
      expect(call?.params[0]).toBe(returnedId);
      expect(returnedId).toMatch(/^[0-9a-f-]{36}$/);
      expect(call?.params[1]).toBe('order.placed');
      expect(call?.params[2]).toBe(1);
      expect(call?.params[4]).toBe(JSON.stringify({ orderId: 'o-1' }));
      expect(call?.params[5]).toBe('svc-a');
      expect(call?.params[6]).toBe('agg-1');
      expect(call?.params[7]).toBe('corr-1');
      expect(call?.params[8]).toBe('PENDING'); // status
      expect(call?.params[9]).toBeNull(); // claimed_by
      expect(call?.params[11]).toBe(0); // retry_count
      expect(call?.params[14]).toBeInstanceOf(Date); // published_at
    });

    it('generates a fresh id on every call', async () => {
      const id1 = await bus.publish({
        eventType: 'order.placed',
        eventVersion: 1,
        eventKind: 'domain',
        payload: {},
        sourceService: 'svc-a',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      const id2 = await bus.publish({
        eventType: 'order.placed',
        eventVersion: 1,
        eventKind: 'domain',
        payload: {},
        sourceService: 'svc-a',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      });
      expect(id1).not.toBe(id2);
    });
  });

  describe('claim', () => {
    it('runs an atomic CTE with aggregate-ordering guard and returns CLAIMED rows', async () => {
      pool.enqueue([
        {
          id: 'evt-1',
          event_type: 'order.placed',
          event_version: 1,
          event_kind: 'domain',
          payload: { foo: 'bar' },
          source_service: 'svc-a',
          aggregate_id: 'agg-1',
          correlation_id: null,
          status: 'CLAIMED',
          claimed_by: 'replica-1',
          claimed_at: new Date('2026-01-01T00:00:05Z'),
          retry_count: 0,
          last_error: null,
          created_at: new Date('2026-01-01T00:00:00Z'),
          published_at: new Date('2026-01-01T00:00:01Z'),
        },
      ]);

      const entries = await bus.claim('replica-1', 10);

      const call = pool.calls[0];
      expect(call?.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(call?.sql).toContain("SET status = 'CLAIMED'");
      expect(call?.sql).toContain('NOT EXISTS');
      expect(call?.sql).toContain('pg_try_advisory_xact_lock');
      expect(call?.params[0]).toBe(10); // batchSize
      expect(call?.params[1]).toBe('replica-1'); // instanceId
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'evt-1',
        status: 'CLAIMED',
        aggregateId: 'agg-1',
      });
    });

    it('omits the topic predicate when allowedTopics is not provided', async () => {
      pool.enqueue([]);
      await bus.claim('replica-1', 10);

      const call = pool.calls[0];
      expect(call?.sql).not.toContain('event_type');
      expect(call?.params).toHaveLength(3);
    });

    it('omits the topic predicate when allowedTopics is empty', async () => {
      pool.enqueue([]);
      await bus.claim('replica-1', 10, []);

      const call = pool.calls[0];
      expect(call?.sql).not.toContain('event_type');
      expect(call?.params).toHaveLength(3);
    });

    it('inlines event_type = ANY($4) and passes the topic array', async () => {
      pool.enqueue([]);
      await bus.claim('replica-1', 10, ['order.placed', 'order.cancelled']);

      const call = pool.calls[0];
      expect(call?.sql).toContain('AND e.event_type = ANY($4)');
      expect(call?.params).toHaveLength(4);
      expect(call?.params[3]).toEqual(['order.placed', 'order.cancelled']);
    });
  });

  describe('markDone', () => {
    it('deletes the row', async () => {
      await bus.markDone('evt-1');
      expect(pool.calls[0]?.sql).toContain('DELETE FROM events');
      expect(pool.calls[0]?.params).toEqual(['evt-1']);
    });
  });

  describe('markFailed', () => {
    it('increments retry_count and flips to FAILED when maxRetries reached', async () => {
      const custom = new PgEventBus({ pool: pool.asPool(), maxRetries: 3 });
      await custom.markFailed('evt-1', 'handler exception');

      const call = pool.calls[0];
      expect(call?.sql).toContain('UPDATE events');
      expect(call?.sql).toContain(
        `CASE WHEN retry_count + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END`,
      );
      expect(call?.sql).toContain('claimed_by = NULL');
      expect(call?.params).toEqual(['handler exception', 'evt-1', 3]);
    });
  });

  describe('resetStale', () => {
    it('flips stale CLAIMED rows back to PENDING', async () => {
      pool.enqueue([], 2);
      const cutoff = new Date('2026-01-01T00:00:00Z');
      const reset = await bus.resetStale(cutoff);

      expect(reset).toBe(2);
      expect(pool.calls[0]?.sql).toContain("SET status = 'PENDING'");
      expect(pool.calls[0]?.sql).toContain("WHERE status = 'CLAIMED' AND claimed_at < $1");
    });
  });

  describe('cleanupFailed', () => {
    it('deletes FAILED rows older than cutoff', async () => {
      pool.enqueue([], 7);
      const cutoff = new Date('2026-01-01T00:00:00Z');
      const deleted = await bus.cleanupFailed(cutoff);

      expect(deleted).toBe(7);
      expect(pool.calls[0]?.sql).toContain("status = 'FAILED'");
      expect(pool.calls[0]?.sql).toContain('created_at < $1');
      expect(pool.calls[0]?.params).toEqual([cutoff]);
    });

    it('honors the limit option', async () => {
      pool.enqueue([], 4);
      const deleted = await bus.cleanupFailed(new Date(), { limit: 50 });

      expect(deleted).toBe(4);
      expect(pool.calls[0]?.sql).toContain('LIMIT $2');
      expect(pool.calls[0]?.params[1]).toBe(50);
    });
  });
});
