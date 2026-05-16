import { beforeEach, describe, expect, it } from 'vitest';
import type { TransactionHandle } from '../../src/index.js';
import { PgLocalOutbox } from '../../src/postgres/pg-local-outbox.js';
import { FakePgPool } from '../helpers/fake-pg-pool.js';

class CapturingTrx implements TransactionHandle {
  calls: { sql: string; params: readonly unknown[] }[] = [];
  async query<TRow = unknown>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<{ rows: readonly TRow[] }> {
    this.calls.push({ sql, params });
    return { rows: [] };
  }
}

describe('PgLocalOutbox', () => {
  let pool: FakePgPool;
  let outbox: PgLocalOutbox;

  beforeEach(() => {
    pool = new FakePgPool();
    outbox = new PgLocalOutbox({ pool: pool.asPool() });
  });

  describe('insert', () => {
    it('inserts with PENDING status and library-managed defaults', async () => {
      const trx = new CapturingTrx();
      await outbox.insert(
        [
          {
            eventType: 'order.placed',
            eventKind: 'domain',
            payload: { orderId: 'o-1' },
            aggregateId: 'agg-1',
          },
        ],
        trx,
      );

      expect(trx.calls).toHaveLength(1);
      const call = trx.calls[0];
      expect(call?.sql).toContain('INSERT INTO outbox_events');
      expect(call?.params[0]).toMatch(/^[0-9a-f-]{36}$/i); // id
      expect(call?.params[1]).toBe('order.placed');
      expect(call?.params[2]).toBe(1);
      expect(call?.params[3]).toBe('domain');
      expect(call?.params[4]).toBe(JSON.stringify({ orderId: 'o-1' }));
      expect(call?.params[5]).toBe('agg-1');
      expect(call?.params[7]).toBe('PENDING'); // status
      expect(call?.params[8]).toBeNull(); // claimed_by
      expect(call?.params[9]).toBeNull(); // claimed_at
      expect(call?.params[10]).toBe(0); // retry_count
      expect(call?.params[11]).toBeNull(); // last_error
      expect(call?.params[12]).toBeNull(); // published_at
      expect(call?.params[13]).toBeInstanceOf(Date); // created_at
    });

    it('honors caller-supplied id, version, createdAt', async () => {
      const trx = new CapturingTrx();
      const createdAt = new Date('2026-04-01T00:00:00Z');
      await outbox.insert(
        [
          {
            id: 'custom-id',
            eventType: 't',
            eventVersion: 7,
            eventKind: 'domain',
            payload: {},
            createdAt,
          },
        ],
        trx,
      );

      expect(trx.calls[0]?.params[0]).toBe('custom-id');
      expect(trx.calls[0]?.params[2]).toBe(7);
      expect(trx.calls[0]?.params[13]).toBe(createdAt);
    });

    it('is a no-op for an empty batch', async () => {
      const trx = new CapturingTrx();
      await outbox.insert([], trx);
      expect(trx.calls).toHaveLength(0);
    });

    it('honors custom table name', async () => {
      const custom = new PgLocalOutbox({ pool: pool.asPool(), tableName: 'svc_outbox' });
      const trx = new CapturingTrx();
      await custom.insert([{ eventType: 't', eventKind: 'domain', payload: {} }], trx);
      expect(trx.calls[0]?.sql).toContain('INSERT INTO svc_outbox');
    });
  });

  describe('claim', () => {
    it('atomically transitions PENDING to CLAIMED and returns mapped entries', async () => {
      pool.enqueue([
        {
          id: 'e1',
          event_type: 'order.placed',
          event_version: 1,
          event_kind: 'domain',
          payload: { foo: 'bar' },
          aggregate_id: 'agg-1',
          correlation_id: null,
          status: 'CLAIMED',
          claimed_by: 'replica-1',
          claimed_at: new Date('2026-01-01T00:00:05Z'),
          retry_count: 0,
          last_error: null,
          published_at: null,
          created_at: new Date('2026-01-01T00:00:00Z'),
        },
      ]);

      const entries = await outbox.claim('replica-1', 10);

      const call = pool.calls[0];
      expect(call?.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(call?.sql).toContain("SET status = 'CLAIMED'");
      expect(call?.params[0]).toBe(10); // batchSize
      expect(call?.params[1]).toBe('replica-1'); // instanceId
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'e1',
        status: 'CLAIMED',
        claimedBy: 'replica-1',
      });
    });
  });

  describe('markSent', () => {
    it('transitions row to SENT and clears claim fields', async () => {
      const publishedAt = new Date('2026-01-01T00:00:10Z');
      await outbox.markSent('e1', publishedAt);

      const call = pool.calls[0];
      expect(call?.sql).toContain("SET status = 'SENT'");
      expect(call?.sql).toContain('claimed_by = NULL');
      expect(call?.params).toEqual([publishedAt, 'e1']);
    });
  });

  describe('markFailed', () => {
    it('increments retry_count and flips to FAILED when maxRetries reached', async () => {
      const custom = new PgLocalOutbox({ pool: pool.asPool(), maxRetries: 3 });
      await custom.markFailed('e1', 'transient error');

      const call = pool.calls[0];
      expect(call?.sql).toContain('UPDATE outbox_events');
      expect(call?.sql).toContain(
        `CASE WHEN retry_count + 1 >= $3 THEN 'FAILED' ELSE 'PENDING' END`,
      );
      expect(call?.sql).toContain('claimed_by = NULL');
      expect(call?.params).toEqual(['transient error', 'e1', 3]);
    });
  });

  describe('resetStale', () => {
    it('flips stale CLAIMED rows back to PENDING', async () => {
      pool.enqueue([], 4);
      const cutoff = new Date('2026-01-01T00:00:00Z');
      const reset = await outbox.resetStale(cutoff);

      expect(reset).toBe(4);
      const call = pool.calls[0];
      expect(call?.sql).toContain("SET status = 'PENDING'");
      expect(call?.sql).toContain("WHERE status = 'CLAIMED' AND claimed_at < $1");
      expect(call?.params).toEqual([cutoff]);
    });
  });

  describe('cleanup', () => {
    it('deletes SENT rows older than cutoff', async () => {
      pool.enqueue([], 5);
      const cutoff = new Date('2026-01-01T00:00:00Z');
      const deleted = await outbox.cleanup(cutoff);

      expect(deleted).toBe(5);
      expect(pool.calls[0]?.sql).toContain("status = 'SENT'");
      expect(pool.calls[0]?.sql).toContain('published_at < $1');
      expect(pool.calls[0]?.params).toEqual([cutoff]);
    });

    it('honors the limit option', async () => {
      pool.enqueue([], 3);
      const deleted = await outbox.cleanup(new Date(), { limit: 100 });

      expect(deleted).toBe(3);
      expect(pool.calls[0]?.sql).toContain('LIMIT $2');
      expect(pool.calls[0]?.params[1]).toBe(100);
    });
  });
});
