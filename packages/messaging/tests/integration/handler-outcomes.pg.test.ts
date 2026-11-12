import { NoopLogger } from '@quilla-be-kit/observability';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventConsumer } from '../../src/event-bus/event.consumer.js';
import { getPostgresSchema } from '../../src/postgres/get-postgres-schema.js';
import { PgEventBus } from '../../src/postgres/pg-event-bus.js';
import { PgHandlerOutcomeStore } from '../../src/postgres/pg-handler-outcome.store.js';
import {
  PG_URL,
  type TestTables,
  createPool,
  createTables,
  dropTables,
  waitFor,
} from '../helpers/pg-test-db.js';

const EPOCH = new Date(0);

class Gone extends Error {}

describe.skipIf(!PG_URL)('Postgres handler outcomes (integration)', () => {
  let pool: pg.Pool;
  let tables: TestTables;
  let outcomesTable: string;
  let bus: PgEventBus;
  let store: PgHandlerOutcomeStore;
  const disposables: { dispose(): Promise<void> }[] = [];

  beforeEach(async () => {
    pool = createPool();
    tables = await createTables(pool);
    outcomesTable = `${tables.eventsTable}_outcomes`;
    await pool.query(getPostgresSchema({ ...tables, handlerOutcomes: { table: outcomesTable } }));
    bus = new PgEventBus({ pool, eventsTableName: tables.eventsTable, maxRetries: 5 });
    store = new PgHandlerOutcomeStore({ pool, tableName: outcomesTable });
  });

  afterEach(async () => {
    await Promise.all(disposables.splice(0).map((d) => d.dispose()));
    await pool.query(`DROP TABLE IF EXISTS ${outcomesTable}`);
    await dropTables(pool, tables);
    await pool.end();
  });

  async function publish(): Promise<string> {
    const { id } = await bus.publish({
      eventType: 'test.happened',
      eventVersion: 1,
      eventKind: 'integration',
      payload: { k: 1 },
      sourceService: 'svc-a',
      occurredAt: EPOCH,
      createdAt: EPOCH,
    });
    return id;
  }

  function consumer() {
    const c = new EventConsumer({
      bus,
      consumerName: 'test',
      sourceService: 'svc-b',
      logger: new NoopLogger(),
      pollIntervalMs: 20,
      retryDelaysMs: [],
      handlerOutcomes: store,
      isPermanentFailure: (err) => err instanceof Gone,
    });
    disposables.push(c);
    return c;
  }

  async function rowCount(table: string): Promise<number> {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0]?.n ?? 0;
  }

  async function statusOf(id: string): Promise<string | undefined> {
    const { rows } = await pool.query<{ status: string }>(
      `SELECT status FROM ${tables.eventsTable} WHERE id = $1`,
      [id],
    );
    return rows[0]?.status;
  }

  const failOnce = (message: string) =>
    vi.fn<() => Promise<void>>().mockRejectedValueOnce(new Error(message)).mockResolvedValue();

  it('re-runs only the failed handler across bus attempts, then cascades the ledger away', async () => {
    await publish();
    const bridge = vi.fn(async () => {});
    const email = failOnce('smtp down');
    consumer()
      .on('test.happened', bridge, { key: 'bridge' })
      .on('test.happened', email, { key: 'email' })
      .start();

    await waitFor(async () => (await rowCount(tables.eventsTable)) === 0, 5000);

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(email).toHaveBeenCalledTimes(2);
    expect(await rowCount(outcomesTable)).toBe(0);
  });

  it('skips a dead handler while a transient one retries, then dead-letters with its error', async () => {
    const id = await publish();
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {
      throw new Gone('aggregate gone');
    });
    const c = failOnce('flaky');
    consumer()
      .on('test.happened', a, { key: 'a' })
      .on('test.happened', b, { key: 'b' })
      .on('test.happened', c, { key: 'c' })
      .start();

    await waitFor(async () => (await statusOf(id)) === 'FAILED', 5000);

    expect([a, b, c].map((h) => h.mock.calls.length)).toEqual([1, 1, 2]);
    const { rows } = await pool.query(
      `SELECT last_error, retry_count FROM ${tables.eventsTable} WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({ last_error: 'aggregate gone', retry_count: 2 });
    const outcomes = await store.load([id]);
    expect(new Map(outcomes.get(id)?.map((o) => [o.key, o.outcome]))).toEqual(
      new Map([
        ['a', 'done'],
        ['b', 'dead'],
        ['c', 'done'],
      ]),
    );

    expect(await bus.cleanupFailed(new Date(Date.now() + 60_000))).toBe(1);
    expect(await rowCount(outcomesTable)).toBe(0);
  });

  it('replays a dead-lettered event: only the dead handler runs again', async () => {
    const id = await publish();
    const a = vi.fn(async () => {});
    let fixed = false;
    const b = vi.fn(async () => {
      if (!fixed) throw new Gone('bug');
    });
    const c = consumer().on('test.happened', a, { key: 'a' }).on('test.happened', b, { key: 'b' });
    c.start();
    await waitFor(async () => (await statusOf(id)) === 'FAILED', 5000);

    fixed = true;
    expect(await bus.replay([id], { handlerOutcomes: store })).toEqual([id]);
    await waitFor(async () => (await statusOf(id)) === undefined, 5000);

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(2);
    expect(await rowCount(outcomesTable)).toBe(0);
  });

  it('keeps done when a replica that lost its claim writes dead late', async () => {
    const id = await publish();
    await store.record(id, [{ key: 'b', outcome: 'done' }]);
    await store.record(id, [{ key: 'b', outcome: 'dead', error: 'stale replica' }]);

    expect((await store.load([id])).get(id)).toEqual([{ key: 'b', outcome: 'done' }]);
  });

  it('lets done replace dead, and ignores outcomes for a deleted bus row', async () => {
    const id = await publish();
    await store.record(id, [{ key: 'b', outcome: 'dead', error: 'bug' }]);
    await store.record(id, [{ key: 'b', outcome: 'done' }]);
    expect((await store.load([id])).get(id)).toEqual([{ key: 'b', outcome: 'done' }]);

    await expect(
      store.record('00000000-0000-0000-0000-000000000000', [{ key: 'a', outcome: 'done' }]),
    ).resolves.toBeUndefined();
  });
});
