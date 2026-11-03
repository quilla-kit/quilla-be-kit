import { NoopLogger } from '@quilla-be-kit/observability';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeaseLostInfo } from '../../src/event-bus/claim-lease.type.js';
import type { EventBusPublisher } from '../../src/event-bus/event-bus-publisher.interface.js';
import { EventConsumer } from '../../src/event-bus/event.consumer.js';
import type { HandlerEntry } from '../../src/event-bus/handler-entry.type.js';
import { OutboxForwarder } from '../../src/local-outbox/outbox.forwarder.js';
import { getPostgresSchema } from '../../src/postgres/get-postgres-schema.js';
import { PgEventBus } from '../../src/postgres/pg-event-bus.js';
import { PgLocalOutbox } from '../../src/postgres/pg-local-outbox.js';
import {
  PG_URL,
  type TestTables,
  createPool,
  createTables,
  dropTables,
  hookAfterClaimStatement,
  sleep,
  waitFor,
} from '../helpers/pg-test-db.js';

const EPOCH = new Date(0);
const DAY_MS = 24 * 60 * 60 * 1000;
const kOf = (entry: { readonly payload: unknown }) => (entry.payload as { k: number }).k;

describe.skipIf(!PG_URL)('Postgres ordering and retention (integration)', () => {
  let pool: pg.Pool;
  let tables: TestTables;
  const disposables: { dispose(): Promise<void> }[] = [];

  beforeEach(async () => {
    pool = createPool();
    tables = await createTables(pool);
  });

  afterEach(async () => {
    await Promise.all(disposables.splice(0).map((d) => d.dispose()));
    await dropTables(pool, tables);
    await pool.end();
  });

  function bus(options: { leaseMs?: number; maxRetries?: number; pool?: pg.Pool } = {}) {
    return new PgEventBus({
      pool: options.pool ?? pool,
      eventsTableName: tables.eventsTable,
      leaseMs: options.leaseMs ?? 60_000,
      maxRetries: options.maxRetries ?? 100,
    });
  }

  function outbox(leaseMs = 60_000) {
    return new PgLocalOutbox({ pool, tableName: tables.outboxTable, maxRetries: 100, leaseMs });
  }

  function publish(
    target: PgEventBus,
    aggregateId: string,
    k: number,
    eventType = 'test.happened',
  ) {
    return target.publish({
      eventType,
      eventVersion: 1,
      eventKind: 'integration',
      payload: { k },
      sourceService: 'svc-a',
      occurredAt: EPOCH,
      createdAt: EPOCH,
      aggregateId,
    });
  }

  async function seedOutbox(aggregateOf: (k: number) => string, count: number) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outbox().insert(
        Array.from({ length: count }, (_, k) => ({
          eventType: 'test.happened',
          eventKind: 'integration',
          payload: { k },
          occurredAt: EPOCH,
          createdAt: EPOCH,
          aggregateId: aggregateOf(k),
        })),
        client,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  }

  function consumer(
    target: PgEventBus,
    handle: (entry: HandlerEntry<unknown>) => Promise<void>,
    options: { renewIntervalMs?: number; onLeaseLost?: (info: LeaseLostInfo) => void } = {},
  ): EventConsumer {
    const c = new EventConsumer({
      bus: target,
      consumerName: 'it',
      sourceService: 'svc-b',
      logger: new NoopLogger(),
      pollIntervalMs: 10,
      batchSize: 5,
      retryDelaysMs: [],
      ...options,
    });
    c.on('test.happened', handle);
    disposables.push(c);
    return c;
  }

  function forwarder(publisher: EventBusPublisher, batchSize: number, instanceId?: string) {
    const f = new OutboxForwarder({
      reader: outbox(300),
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      pollIntervalMs: 10,
      batchSize,
      renewIntervalMs: 100,
      ...(instanceId !== undefined ? { instanceId } : {}),
    });
    disposables.push(f);
    f.start();
  }

  async function idsBySeq(): Promise<string[]> {
    const { rows } = await pool.query<{ id: string }>(
      `SELECT id FROM ${tables.eventsTable} ORDER BY seq`,
    );
    return rows.map((r) => r.id);
  }

  async function busRows(): Promise<{ aggregate_id: string; k: number }[]> {
    const { rows } = await pool.query<{ aggregate_id: string; k: number }>(
      `SELECT aggregate_id, (payload->>'k')::int AS k FROM ${tables.eventsTable} ORDER BY seq`,
    );
    return rows;
  }

  // Row-locks one row on its own connection, so concurrent claims skip it.
  async function rowLock(id: string | undefined): Promise<pg.PoolClient> {
    const client = await pool.connect();
    await client.query('BEGIN');
    await client.query(`SELECT 1 FROM ${tables.eventsTable} WHERE id = $1 FOR UPDATE`, [id]);
    return client;
  }

  describe('claim ownership', () => {
    it('releases rows whose aggregate another claim committed during this claim (snapshot race)', async () => {
      const owner = bus();
      await publish(owner, 'X', 0);
      await publish(owner, 'X', 1);
      const [first] = await idsBySeq();

      // A row-locks e0, so B's claim skips it but still sees no CLAIMED row for X.
      const a = await rowLock(first);
      // After B's claim statement, A commits its claim of e0 — before B's verify step runs.
      const racing = hookAfterClaimStatement(pool, async () => {
        await a.query(
          `UPDATE ${tables.eventsTable}
           SET status = 'CLAIMED', claimed_by = 'A', claimed_at = now(),
               lease_expires_at = now() + interval '1 minute'
           WHERE id = $1`,
          [first],
        );
        await a.query('COMMIT');
      });
      const claimed = await bus({ pool: racing }).claim('B', 10);
      a.release();

      expect(claimed).toEqual([]);
      const { rows } = await pool.query<{ claimed_by: string | null; status: string }>(
        `SELECT claimed_by, status FROM ${tables.eventsTable} ORDER BY seq`,
      );
      expect(rows).toEqual([
        { claimed_by: 'A', status: 'CLAIMED' },
        { claimed_by: null, status: 'PENDING' },
      ]);
    });

    it('gives back a later row when an earlier row of its aggregate is still PENDING', async () => {
      const owner = bus();
      await publish(owner, 'X', 0);
      await publish(owner, 'X', 1);
      const [first] = await idsBySeq();
      // The claim skips the locked e0 (as when another scan filtered it out) and takes e1.
      const a = await rowLock(first);
      try {
        expect(await owner.claim('B', 10, ['test.happened'])).toEqual([]);
      } finally {
        await a.query('ROLLBACK');
        a.release();
      }
      expect((await owner.claim('B', 10, ['test.happened'])).map(kOf)).toEqual([0, 1]);
    });

    it('ignores earlier PENDING rows of event types the claimer does not take', async () => {
      const owner = bus();
      await publish(owner, 'X', 0, 'other.type');
      await publish(owner, 'X', 1);
      expect((await owner.claim('B', 10, ['test.happened'])).map(kOf)).toEqual([1]);
    });

    it('never runs two events of one aggregate at once, and runs them in publish order', async () => {
      const aggregates = Array.from({ length: 8 }, (_, i) => `agg-${i}`);
      const perAggregate = 15;
      const publisher = bus();
      for (let k = 0; k < perAggregate; k++) {
        for (const agg of aggregates) await publish(publisher, agg, k);
      }

      const flaky = new Set(aggregates.map((agg) => `${agg}:${(agg.length + 3) % perAggregate}`));
      const active = new Map<string, number>();
      const completed = new Map<string, number[]>();
      let overlaps = 0;
      let total = 0;

      const handle = async (entry: HandlerEntry<unknown>) => {
        const agg = entry.aggregateId ?? '';
        const k = kOf(entry);
        if ((active.get(agg) ?? 0) > 0) overlaps++;
        active.set(agg, (active.get(agg) ?? 0) + 1);
        try {
          await sleep((k * 7 + agg.length) % 4);
          if (flaky.delete(`${agg}:${k}`)) throw new Error('flaky once');
          completed.set(agg, [...(completed.get(agg) ?? []), k]);
          total++;
        } finally {
          active.set(agg, (active.get(agg) ?? 1) - 1);
        }
      };

      for (let i = 0; i < 4; i++) {
        consumer(bus({ leaseMs: 400 }), handle, { renewIntervalMs: 100 }).start();
      }
      await waitFor(() => total === aggregates.length * perAggregate, 60_000);

      expect(overlaps).toBe(0);
      const expected = Array.from({ length: perAggregate }, (_, k) => k);
      for (const agg of aggregates) expect(completed.get(agg)).toEqual(expected);
    }, 70_000);

    it('reports a lost lease and keeps order when another replica takes over', async () => {
      const publisher = bus();
      await publish(publisher, 'X', 0);
      await publish(publisher, 'X', 1);

      const runs: { by: string; k: number; start: number; end: number }[] = [];
      const record = (by: string, ms: number) => async (entry: HandlerEntry<unknown>) => {
        const start = Date.now();
        await sleep(ms);
        runs.push({ by, k: kOf(entry), start, end: Date.now() });
      };
      const lost: LeaseLostInfo[] = [];
      // A doesn't renew, so its 300 ms lease lapses during the 800 ms handler.
      consumer(bus({ leaseMs: 300 }), record('A', 800), {
        renewIntervalMs: 0,
        onLeaseLost: (info) => lost.push(info),
      }).start();
      await sleep(100);
      consumer(bus({ leaseMs: 300 }), record('B', 5)).start();

      // A's fenced markDone runs after its handler, so wait for the report too.
      await waitFor(() => runs.length === 3 && lost.length > 0, 10_000);

      const bRuns = runs.filter((r) => r.by === 'B');
      expect(bRuns.map((r) => r.k)).toEqual([0, 1]);
      expect(bRuns[1]?.start).toBeGreaterThanOrEqual(bRuns[0]?.end ?? Number.POSITIVE_INFINITY);
      expect(runs.filter((r) => r.by === 'A').map((r) => r.k)).toEqual([0]);
      expect(lost).toContainEqual(expect.objectContaining({ stage: 'done' }));
    }, 15_000);

    it('does not claim a later row while an earlier one waits behind a claimed row (staggered expiry)', async () => {
      const publisher = bus();
      for (let k = 0; k < 3; k++) await publish(publisher, 'X', k);
      const ids = await idsBySeq();
      // e0 is back to PENDING (a retry); e1 and e2 are held by a crashed replica, with
      // different leases: e1 already expired, e2 not yet.
      await pool.query(
        `UPDATE ${tables.eventsTable} SET status = 'CLAIMED', claimed_by = 'ghost',
           claimed_at = now() - interval '2 minutes',
           lease_expires_at = CASE WHEN id = $1 THEN now() - interval '1 second'
                                   ELSE now() + interval '1 hour' END
         WHERE id = ANY($2)`,
        [ids[1], [ids[1], ids[2]]],
      );

      const reader = bus();
      const legacyCutoff = () => new Date(Date.now() - 5 * 60_000);
      expect(await reader.resetStale(legacyCutoff())).toBe(1);
      expect(await reader.claim('B', 10)).toEqual([]);

      await pool.query(
        `UPDATE ${tables.eventsTable} SET lease_expires_at = now() - interval '1 second' WHERE id = $1`,
        [ids[2]],
      );
      expect(await reader.resetStale(legacyCutoff())).toBe(1);
      expect((await reader.claim('B', 10)).map(kOf)).toEqual([0, 1, 2]);
    });
  });

  describe('forwarder', () => {
    it('forwards one commit of two aggregates to the bus in outbox order across replicas', async () => {
      await seedOutbox((k) => (k % 2 === 0 ? 'X' : 'Y'), 60);
      const target = bus();
      let failedOnce = false;
      const flaky: EventBusPublisher = {
        publish: async (event) => {
          const k = kOf(event);
          await sleep((k * 5) % 4);
          if (!failedOnce && k === 4) {
            failedOnce = true;
            throw new Error('bus hiccup');
          }
          return target.publish(event);
        },
      };
      for (const id of ['F1', 'F2', 'F3']) forwarder(flaky, 2, id);

      await waitFor(async () => (await busRows()).length === 60, 20_000);
      const rows = await busRows();
      const order = (agg: string) => rows.filter((r) => r.aggregate_id === agg).map((r) => r.k);
      const evens = Array.from({ length: 30 }, (_, i) => i * 2);
      expect(order('X')).toEqual(evens);
      expect(order('Y')).toEqual(evens.map((k) => k + 1));
    }, 30_000);

    it('holds the rest of an aggregate until a failed entry is forwarded', async () => {
      await seedOutbox(() => 'X', 4);
      const target = bus();
      let failedOnce = false;
      forwarder(
        {
          publish: async (event) => {
            if (!failedOnce) {
              failedOnce = true;
              throw new Error('bus hiccup');
            }
            return target.publish(event);
          },
        },
        10,
      );

      await waitFor(async () => (await busRows()).length === 4, 10_000);
      expect((await busRows()).map((r) => r.k)).toEqual([0, 1, 2, 3]);
    }, 15_000);
  });

  describe('legacy rows and retention', () => {
    it('drains legacy rows (no seq) first, and old writers still get a seq', async () => {
      await publish(bus(), 'X', 1);
      const insert = (k: number, withSeq: boolean) =>
        pool.query(
          `INSERT INTO ${tables.eventsTable}
             (id, event_type, event_version, event_kind, payload, source_service, aggregate_id,
              status, retry_count, created_at, published_at, occurred_at${withSeq ? ', seq' : ''})
           VALUES (gen_random_uuid(), 'test.happened', 1, 'integration', $1, 'svc-a', 'X',
                   'PENDING', 0, now(), now(), now()${withSeq ? ', NULL' : ''})`,
          [JSON.stringify({ k })],
        );
      await insert(0, true);
      // An INSERT that doesn't list seq (what pre-0.9.0 writers send) gets one from the default.
      await insert(2, false);

      expect((await bus().claim('B', 10)).map(kOf)).toEqual([0, 1, 2]);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM ${tables.eventsTable} WHERE seq IS NULL`,
      );
      expect(rows[0]?.n).toBe(1);
    });

    it('measures retention from failure, not from the caller-supplied createdAt', async () => {
      const target = bus({ maxRetries: 1 });
      const { id } = await publish(target, 'X', 0);
      await target.claim('B', 10);
      await target.markFailed(id, 'boom', 'B');

      expect(await target.cleanupFailed(new Date(Date.now() - 30 * DAY_MS))).toBe(0);
      const { rows } = await pool.query<{ status: string; failed_at: Date | null }>(
        `SELECT status, failed_at FROM ${tables.eventsTable} WHERE id = $1`,
        [id],
      );
      expect(rows[0]?.status).toBe('FAILED');
      expect(rows[0]?.failed_at).toBeInstanceOf(Date);
      expect(await target.cleanupFailed(new Date(Date.now() + 1000))).toBe(1);
    });

    it('keeps dead letters with no failed_at until the backfill starts their window', async () => {
      const target = bus();
      const { id } = await publish(target, 'X', 0);
      await pool.query(
        `UPDATE ${tables.eventsTable} SET status = 'FAILED', failed_at = NULL WHERE id = $1`,
        [id],
      );
      const later = () => new Date(Date.now() + 60_000);
      expect(await target.cleanupFailed(later())).toBe(0);

      await pool.query(
        `UPDATE ${tables.eventsTable} SET failed_at = now() WHERE status = 'FAILED' AND failed_at IS NULL`,
      );
      expect(await target.cleanupFailed(new Date(Date.now() - 30 * DAY_MS))).toBe(0);
      expect(await target.cleanupFailed(later())).toBe(1);
    });
  });

  describe('schema', () => {
    it('is idempotent and upgrades a 0.8.0-shaped table in place', async () => {
      const legacy = `legacy_${tables.eventsTable}`;
      await pool.query(`CREATE TABLE ${legacy} (
        id UUID PRIMARY KEY, event_type TEXT NOT NULL, event_version INTEGER NOT NULL,
        event_kind TEXT NOT NULL, payload JSONB NOT NULL, source_service TEXT NOT NULL,
        aggregate_id TEXT, correlation_id TEXT, origin_event_id TEXT, status TEXT NOT NULL,
        claimed_by TEXT, claimed_at TIMESTAMPTZ, lease_expires_at TIMESTAMPTZ,
        retry_count INTEGER NOT NULL, last_error TEXT, created_at TIMESTAMPTZ NOT NULL,
        published_at TIMESTAMPTZ NOT NULL, occurred_at TIMESTAMPTZ NOT NULL)`);
      try {
        const sql = getPostgresSchema({ eventsTable: legacy, outboxTable: tables.outboxTable });
        await pool.query(sql);
        await pool.query(sql);

        const { rows } = await pool.query<{ column_name: string; column_default: string | null }>(
          `SELECT column_name, column_default FROM information_schema.columns
           WHERE table_name = $1 AND column_name IN ('seq', 'failed_at') ORDER BY column_name`,
          [legacy],
        );
        expect(rows).toEqual([
          { column_name: 'failed_at', column_default: null },
          { column_name: 'seq', column_default: `nextval('${legacy}_seq'::regclass)` },
        ]);
      } finally {
        await pool.query(`DROP TABLE ${legacy} CASCADE`);
      }
    });
  });
});
