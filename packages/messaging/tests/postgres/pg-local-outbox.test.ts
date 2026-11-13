import { beforeEach, describe, expect, it } from 'vitest';
import { ClaimLostError } from '../../src/event-bus/claim-lost.error.js';
import { MissingColumnError } from '../../src/postgres/missing-column.error.js';
import { PgLocalOutbox } from '../../src/postgres/pg-local-outbox.js';
import { CapturingTrx } from '../helpers/capturing-trx.js';
import { FakePgPool } from '../helpers/fake-pg-pool.js';

const OCCURRED_AT = new Date('2025-12-31T23:59:00Z');

function outboxRow(overrides: Record<string, unknown> = {}) {
  return {
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
    lease_expires_at: null,
    retry_count: 0,
    last_error: null,
    failed_at: null,
    seq: null,
    published_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    occurred_at: OCCURRED_AT,
    ...overrides,
  };
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
            occurredAt: OCCURRED_AT,
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
      expect(call?.params[14]).toBe(OCCURRED_AT); // occurred_at
      expect(call?.sql).toContain('occurred_at');
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
            occurredAt: OCCURRED_AT,
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

    it('accepts any transaction object with a query method', async () => {
      const calls: string[] = [];
      const trx = {
        query: async (sql: string): Promise<{ rowCount: number }> => {
          calls.push(sql);
          return { rowCount: 1 };
        },
      };
      await outbox.insert(
        [{ eventType: 't', eventKind: 'domain', payload: {}, occurredAt: OCCURRED_AT }],
        trx,
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain('INSERT INTO outbox_events');
    });

    it('honors custom table name', async () => {
      const custom = new PgLocalOutbox({ pool: pool.asPool(), tableName: 'svc_outbox' });
      const trx = new CapturingTrx();
      await custom.insert(
        [{ eventType: 't', eventKind: 'domain', payload: {}, occurredAt: new Date() }],
        trx,
      );
      expect(trx.calls[0]?.sql).toContain('INSERT INTO svc_outbox');
    });

    describe('past the parameter limit', () => {
      const PER_STATEMENT = Math.floor(65535 / 16);
      const entries = (count: number) =>
        Array.from({ length: count }, (_, i) => ({
          id: `e${i}`,
          eventType: 't',
          eventKind: 'domain' as const,
          payload: {},
          occurredAt: OCCURRED_AT,
        }));

      it('keeps a batch at the limit in one statement', async () => {
        const trx = new CapturingTrx();
        await outbox.insert(entries(PER_STATEMENT), trx);
        expect(trx.calls).toHaveLength(1);
        expect(trx.calls[0]?.params).toHaveLength(PER_STATEMENT * 16);
      });

      it('splits a larger batch into statements on the same trx, in order', async () => {
        const trx = new CapturingTrx();
        await outbox.insert(entries(PER_STATEMENT + 1), trx);
        expect(trx.calls).toHaveLength(2);
        for (const call of trx.calls) {
          expect(call.params.length).toBeLessThanOrEqual(65535);
        }
        expect(trx.calls[0]?.params[0]).toBe('e0');
        expect(trx.calls[1]?.params).toHaveLength(16);
        expect(trx.calls[1]?.params[0]).toBe(`e${PER_STATEMENT}`);
        expect(trx.calls[1]?.sql).toContain('($1, $2,');
        expect(trx.calls[1]?.sql).not.toContain('$17');
      });
    });
  });

  describe('claim', () => {
    it('atomically transitions PENDING to CLAIMED and returns mapped entries', async () => {
      pool.enqueue([outboxRow()]);

      const entries = await outbox.claim('replica-1', 10);

      const call = pool.clientCalls[1];
      expect(call?.sql).toContain('FOR UPDATE SKIP LOCKED');
      expect(call?.sql).toContain("SET status = 'CLAIMED'");
      expect(call?.params[0]).toBe(10); // batchSize
      expect(call?.params[1]).toBe('replica-1'); // instanceId
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'e1',
        status: 'CLAIMED',
        claimedBy: 'replica-1',
        occurredAt: OCCURRED_AT,
      });
    });

    it('passes the failover window to the claim', async () => {
      pool.enqueue([]);
      await outbox.claim('replica-1', 10, { failoverWindowMs: 2000 });

      const call = pool.clientCalls[1];
      expect(call?.sql).toContain(
        'CASE WHEN e.last_failed_by = $2 THEN $5::timestamptz ELSE $3::timestamptz END',
      );
      expect((call?.params[4] as Date).getTime()).toBe((call?.params[2] as Date).getTime() - 2000);
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
      expect(call?.params.slice(0, 3)).toEqual(['transient error', 'e1', 3]);
    });

    it('records the failing instance and retries at once by default', async () => {
      pool.enqueue([], 1);
      await outbox.markFailed('e1', 'boom', 'replica-1');

      const call = pool.calls[0];
      expect(call?.sql).toContain('last_failed_by = $5');
      expect(call?.sql).toContain('next_attempt_at = $6');
      expect(call?.params[4]).toBe('replica-1');
      expect(call?.params[5]).toEqual(call?.params[3]);
    });

    it('records no failing instance when unfenced', async () => {
      await outbox.markFailed('e1', 'boom');
      expect(pool.calls[0]?.params[4]).toBeNull();
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
      expect(call?.sql).toContain('lease_expires_at > claimed_at AND lease_expires_at < $2');
      expect(call?.sql).toContain(
        '(lease_expires_at IS NULL OR lease_expires_at <= claimed_at) AND claimed_at < $1',
      );
      expect(call?.params[0]).toBe(cutoff);
      expect(call?.params[1]).toBeInstanceOf(Date);
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

  describe('claim leases', () => {
    it('writes a lease of leaseMs past the claim time', async () => {
      const custom = new PgLocalOutbox({ pool: pool.asPool(), leaseMs: 30_000 });
      pool.enqueue([]);
      await custom.claim('replica-1', 10);

      const call = pool.clientCalls[1];
      expect(call?.sql).toContain('lease_expires_at = $4');
      const claimedAt = call?.params[2] as Date;
      const leaseExpiresAt = call?.params[3] as Date;
      expect(leaseExpiresAt.getTime() - claimedAt.getTime()).toBe(30_000);
    });

    it('renews owned CLAIMED rows and returns held ids', async () => {
      pool.enqueue([{ id: 'e1' }]);
      const held = await outbox.lease.renew('replica-1', ['e1', 'e2']);

      const call = pool.calls[0];
      expect(call?.sql).toContain('UPDATE outbox_events');
      expect(call?.sql).toContain('SET claimed_at = $3, lease_expires_at = $4');
      expect(call?.sql).toContain("WHERE id = ANY($1) AND claimed_by = $2 AND status = 'CLAIMED'");
      expect(held).toEqual(['e1']);
    });

    it('owner-checks markSent and throws ClaimLostError when nothing matched', async () => {
      pool.enqueue([], 0);
      const publishedAt = new Date('2026-01-01T00:00:00Z');
      await expect(outbox.markSent('e1', publishedAt, 'replica-1')).rejects.toSatisfy(
        ClaimLostError.is,
      );

      const call = pool.calls[0];
      expect(call?.sql).toContain('lease_expires_at = NULL');
      expect(call?.sql).toContain('WHERE id = $2 AND (claimed_by = $3 OR claimed_by IS NULL)');
      expect(call?.params).toEqual([publishedAt, 'e1', 'replica-1']);
    });

    it('unfenced markSent keeps the id-only predicate', async () => {
      const publishedAt = new Date('2026-01-01T00:00:00Z');
      await outbox.markSent('e1', publishedAt);
      expect(pool.calls[0]?.sql).not.toContain('claimed_by = $3');
      expect(pool.calls[0]?.params).toEqual([publishedAt, 'e1']);
    });

    it('owner-checks markFailed', async () => {
      pool.enqueue([], 0);
      await expect(outbox.markFailed('e1', 'boom', 'replica-1')).rejects.toSatisfy(
        ClaimLostError.is,
      );
      expect(pool.calls[0]?.params[6]).toBe('replica-1');
    });

    it('writes lease_expires_at = NULL as the last insert column', async () => {
      const trx = new CapturingTrx();
      await outbox.insert(
        [{ eventType: 't', eventKind: 'domain', payload: {}, occurredAt: OCCURRED_AT }],
        trx,
      );
      expect(trx.calls[0]?.sql).toContain('occurred_at, lease_expires_at)');
      expect(trx.calls[0]?.params).toHaveLength(16);
      expect(trx.calls[0]?.params[15]).toBeNull();
    });

    it('turns a missing lease column into MissingLeaseColumnError', async () => {
      pool.failNext(
        Object.assign(new Error('column "lease_expires_at" does not exist'), { code: '42703' }),
      );
      await expect(outbox.claim('replica-1', 10)).rejects.toBeInstanceOf(MissingColumnError);
    });
  });

  describe('kit-owned ordering and retention', () => {
    it('claims with the per-aggregate guard and a table-scoped advisory lock, in seq order', async () => {
      pool.enqueue([]);
      await outbox.claim('replica-1', 10);

      const sql = pool.clientCalls[1]?.sql ?? '';
      expect(sql).toContain('NOT EXISTS');
      expect(sql).toContain(
        "pg_try_advisory_xact_lock(hashtext('outbox_events'), hashtext(e.aggregate_id))",
      );
      expect(sql).toContain('ORDER BY e.seq NULLS FIRST, e.created_at');
    });

    it('markFailed returns the updated row as an entry', async () => {
      pool.enqueue([
        outboxRow({
          status: 'FAILED',
          claimed_by: null,
          claimed_at: null,
          retry_count: 3,
          last_error: 'boom',
          failed_at: new Date('2026-02-01T00:00:00Z'),
        }),
      ]);
      const entry = await outbox.markFailed('e1', 'boom', 'replica-1');

      expect(pool.calls[0]?.sql).toContain('RETURNING *');
      expect(entry).toMatchObject({ id: 'e1', status: 'FAILED', retryCount: 3, lastError: 'boom' });
    });

    it('releases owned CLAIMED rows through the lease', async () => {
      pool.enqueue([{ id: 'e2' }]);
      expect(await outbox.lease.release?.('replica-1', ['e1', 'e2'])).toEqual(['e2']);
      expect(pool.calls[0]?.sql).toContain('UPDATE outbox_events');
      expect(pool.calls[0]?.params).toEqual([['e1', 'e2'], 'replica-1']);
    });

    it('never writes seq on insert', async () => {
      const trx = new CapturingTrx();
      await outbox.insert(
        [{ eventType: 't', eventKind: 'domain', payload: {}, occurredAt: OCCURRED_AT }],
        trx,
      );
      expect(trx.calls[0]?.sql).not.toMatch(/\bseq\b/);
    });

    it('cleanupFailed deletes FAILED rows by failed_at, keeping rows without one', async () => {
      pool.enqueue([], 3);
      const cutoff = new Date('2026-01-01T00:00:00Z');
      const deleted = await outbox.cleanupFailed(cutoff, { limit: 100 });

      expect(deleted).toBe(3);
      const call = pool.calls[0];
      expect(call?.sql).toContain('DELETE FROM outbox_events');
      expect(call?.sql).toContain("WHERE status = 'FAILED' AND failed_at < $1");
      expect(call?.sql).toContain('ORDER BY failed_at ASC');
      expect(call?.params).toEqual([cutoff, 100]);
    });
  });
});
