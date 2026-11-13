import { NoopLogger } from '@quilla-be-kit/observability';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EventConsumer } from '../../src/event-bus/event.consumer.js';
import { PgEventBus } from '../../src/postgres/pg-event-bus.js';
import { PgLocalOutbox } from '../../src/postgres/pg-local-outbox.js';
import {
  PG_URL,
  type TestTables,
  createPool,
  createTables,
  dropTables,
  waitFor,
} from '../helpers/pg-test-db.js';

const EPOCH = new Date(0);
const WINDOW = { failoverWindowMs: 60_000 };

describe.skipIf(!PG_URL)('Postgres retry failover (integration)', () => {
  let pool: pg.Pool;
  let tables: TestTables;
  let bus: PgEventBus;
  const disposables: { dispose(): Promise<void> }[] = [];

  beforeEach(async () => {
    pool = createPool();
    tables = await createTables(pool);
    bus = new PgEventBus({ pool, eventsTableName: tables.eventsTable, maxRetries: 100 });
  });

  afterEach(async () => {
    await Promise.all(disposables.splice(0).map((d) => d.dispose()));
    await dropTables(pool, tables);
    await pool.end();
  });

  // The bus's advisory lock is keyed on aggregate_id alone, so suites running in parallel on
  // one database must not share aggregate ids.
  function publish(aggregate: string | undefined, k: number) {
    const aggregateId = aggregate && `${tables.eventsTable}:${aggregate}`;
    return bus.publish({
      eventType: 'test.happened',
      eventVersion: 1,
      eventKind: 'integration',
      payload: { k },
      sourceService: 'svc-a',
      occurredAt: EPOCH,
      createdAt: EPOCH,
      ...(aggregateId !== undefined ? { aggregateId } : {}),
    });
  }

  async function failAs(instanceId: string, id: string) {
    const [claimed] = await bus.claim(instanceId, 1, undefined, WINDOW);
    expect(claimed?.id).toBe(id);
    return bus.markFailed(id, 'boom', instanceId);
  }

  // Moves the failure out of the window instead of waiting for it.
  async function ageFailure(table: string, id: string) {
    await pool.query(
      `UPDATE ${table} SET next_attempt_at = next_attempt_at - interval '1 hour' WHERE id = $1`,
      [id],
    );
  }

  async function xmin(id: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ xmin: string }>(
      `SELECT xmin::text FROM ${tables.eventsTable} WHERE id = $1`,
      [id],
    );
    return rows[0]?.xmin;
  }

  it('records the failing instance and the next attempt on the returned entry', async () => {
    const { id } = await publish('agg-1', 0);
    const failed = await failAs('a', id);
    expect(failed).toMatchObject({ status: 'PENDING', lastFailedBy: 'a' });
    expect(failed?.nextAttemptAt).toBeInstanceOf(Date);
  });

  it('holds a retry from every instance until it is due', async () => {
    const { id } = await publish('agg-1', 0);
    await bus.claim('a', 1, undefined, WINDOW);
    await bus.markFailed(id, 'boom', 'a', { retryAfterMs: 60_000 });

    expect(await bus.claim('b', 10, undefined, WINDOW)).toEqual([]);
    await ageFailure(tables.eventsTable, id);
    expect((await bus.claim('b', 10, undefined, WINDOW)).map((e) => e.id)).toEqual([id]);
  });

  it('skips the rest of a waiting aggregate without claiming and giving it back', async () => {
    const first = await publish('agg-1', 0);
    const second = await publish('agg-1', 1);
    await failAs('a', first.id);
    const before = await xmin(second.id);

    expect(await bus.claim('a', 10, undefined, WINDOW)).toEqual([]);
    expect(await xmin(second.id)).toBe(before);
  });

  it('hands a row that instance A failed to instance B', async () => {
    const { id } = await publish('agg-1', 0);
    await failAs('a', id);

    expect(await bus.claim('a', 10, undefined, WINDOW)).toEqual([]);
    const claimed = await bus.claim('b', 10, undefined, WINDOW);
    expect(claimed.map((e) => e.id)).toEqual([id]);
  });

  it('lets the failing instance claim the row again once the window passes', async () => {
    const { id } = await publish('agg-1', 0);
    await failAs('a', id);
    await ageFailure(tables.eventsTable, id);

    const claimed = await bus.claim('a', 10, undefined, WINDOW);
    expect(claimed.map((e) => e.id)).toEqual([id]);
  });

  it('lets the failing instance retry at once when the claim passes no window', async () => {
    const { id } = await publish('agg-1', 0);
    await failAs('a', id);

    expect((await bus.claim('a', 10)).map((e) => e.id)).toEqual([id]);
  });

  it("keeps the rest of the row's aggregate from the excluded instance", async () => {
    const first = await publish('agg-1', 0);
    const second = await publish('agg-1', 1);
    const other = await publish('agg-2', 2);
    await failAs('a', first.id);

    const forA = await bus.claim('a', 10, undefined, WINDOW);
    expect(forA.map((e) => e.id)).toEqual([other.id]);
    await bus.markDone(other.id, 'a');

    const forB = await bus.claim('b', 10, undefined, WINDOW);
    expect(forB.map((e) => e.id)).toEqual([first.id, second.id]);
  });

  it('always offers rows that never failed', async () => {
    const plain = await publish(undefined, 0);
    const claimed = await bus.claim('a', 10, undefined, WINDOW);
    expect(claimed.map((e) => e.id)).toEqual([plain.id]);
  });

  it('clears the failing instance on replay', async () => {
    const dead = new PgEventBus({ pool, eventsTableName: tables.eventsTable, maxRetries: 1 });
    const { id } = await publish('agg-1', 0);
    await dead.claim('a', 1, undefined, WINDOW);
    const failed = await dead.markFailed(id, 'boom', 'a');
    expect(failed).toMatchObject({ status: 'FAILED', lastFailedBy: 'a' });

    await dead.replay([id]);
    expect((await dead.claim('a', 10, undefined, WINDOW)).map((e) => e.id)).toEqual([id]);
  });

  it('fails over the outbox claim the same way', async () => {
    const outbox = new PgLocalOutbox({ pool, tableName: tables.outboxTable, maxRetries: 100 });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await outbox.insert(
        [{ eventType: 'test.happened', eventKind: 'integration', payload: {}, occurredAt: EPOCH }],
        client,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const [entry] = await outbox.claim('a', 1, WINDOW);
    if (!entry) throw new Error('nothing claimed');
    await outbox.markFailed(entry.id, 'boom', 'a');

    expect(await outbox.claim('a', 10, WINDOW)).toEqual([]);
    await ageFailure(tables.outboxTable, entry.id);
    expect((await outbox.claim('a', 10, WINDOW)).map((e) => e.id)).toEqual([entry.id]);
  });

  it('a healthy consumer takes the retry after one attempt on the failing one', async () => {
    const handledBy: string[] = [];
    function start(instanceId: string, fails: boolean) {
      const c = new EventConsumer({
        bus,
        consumerName: 'it',
        sourceService: 'svc-b',
        logger: new NoopLogger(),
        instanceId,
        pollIntervalMs: 20,
        retryDelaysMs: [50],
        failoverWindowMs: 60_000,
      });
      c.on('test.happened', async () => {
        handledBy.push(instanceId);
        if (fails) throw new Error('provider down');
      });
      disposables.push(c);
      return c;
    }

    const { id } = await publish('agg-1', 0);
    const failing = start('a', true);
    failing.start();
    await waitFor(() => handledBy.length === 1, 2000);
    start('b', false).start();
    await waitFor(async () => {
      const { rowCount } = await pool.query(`SELECT 1 FROM ${tables.eventsTable} WHERE id = $1`, [
        id,
      ]);
      return rowCount === 0;
    }, 2000);

    expect(handledBy).toEqual(['a', 'b']);
  });
});
