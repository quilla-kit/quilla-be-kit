import { NoopLogger } from '@quilla-be-kit/observability';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaimLostError } from '../../src/event-bus/claim-lost.error.js';
import type { DeliveryPair, NewDelivery } from '../../src/event-bus/delivery-entry.type.js';
import { EventConsumer } from '../../src/event-bus/event.consumer.js';
import type { PgDeliveryQueue } from '../../src/postgres/pg-delivery.queue.js';
import { PgEventBus } from '../../src/postgres/pg-event-bus.js';
import {
  PG_URL,
  type TestTables,
  createPool,
  createTables,
  dropTables,
  waitFor,
} from '../helpers/pg-test-db.js';

const EPOCH = new Date(0);
const MAIL: DeliveryPair = { key: 'mail', eventType: 'user.disabled' };

describe.skipIf(!PG_URL)('Postgres subscriber isolation (integration)', () => {
  let pool: pg.Pool;
  let tables: TestTables;
  let bus: PgEventBus;
  let queue: PgDeliveryQueue;
  const disposables: { dispose(): Promise<void> }[] = [];

  beforeEach(async () => {
    pool = createPool();
    tables = await createTables(pool);
    bus = new PgEventBus({
      pool,
      eventsTableName: tables.eventsTable,
      deliveries: true,
      deliveriesTableName: tables.deliveriesTable,
    });
    if (!bus.deliveries) throw new Error('no deliveries');
    queue = bus.deliveries;
  });

  afterEach(async () => {
    await Promise.all(disposables.splice(0).map((d) => d.dispose()));
    await dropTables(pool, tables);
    await pool.end();
  });

  // The advisory locks are keyed on aggregate ids, so parallel suites must not share them.
  function agg(name: string): string {
    return `${tables.eventsTable}:${name}`;
  }

  function publish(aggregate: string, k: number, eventType = 'user.disabled') {
    return bus.publish({
      eventType,
      eventVersion: 1,
      eventKind: 'integration',
      payload: { k },
      sourceService: 'svc-a',
      occurredAt: EPOCH,
      createdAt: EPOCH,
      aggregateId: agg(aggregate),
    });
  }

  // Publishes, claims and settles one event into deliveries; returns the created deliveries.
  async function queueFor(aggregate: string, k: number, deliveries: readonly NewDelivery[]) {
    const { id } = await publish(aggregate, k);
    const [claimed] = await bus.claim('setup', 1, ['user.disabled']);
    expect(claimed?.id).toBe(id);
    return queue.settle(id, 'svc', deliveries, 'setup');
  }

  const pending = (handlerKey = 'mail'): NewDelivery => ({
    handlerKey,
    status: 'PENDING',
    retryCount: 1,
  });

  async function count(table: string): Promise<number> {
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM ${table}`);
    return Number(rows[0]?.n);
  }

  it('settles atomically: the event is gone and its copies are queued', async () => {
    const [delivery] = await queueFor('agg-1', 0, [pending()]);
    expect(delivery).toMatchObject({
      consumerName: 'svc',
      handlerKey: 'mail',
      status: 'PENDING',
      payload: { k: 0 },
      aggregateId: agg('agg-1'),
    });
    expect(await count(tables.eventsTable)).toBe(0);
  });

  it('writes nothing when another instance holds the claim', async () => {
    const { id } = await publish('agg-1', 0);
    await bus.claim('a', 1, ['user.disabled']);
    await expect(queue.settle(id, 'svc', [pending()], 'b')).rejects.toBeInstanceOf(ClaimLostError);
    expect(await count(tables.eventsTable)).toBe(1);
    expect(await count(tables.deliveriesTable)).toBe(0);
  });

  it('runs a lane in order, one delivery at a time, while other lanes go on', async () => {
    const [first] = await queueFor('agg-1', 0, [pending()]);
    const [second] = await queueFor('agg-1', 1, [pending()]);
    const [other] = await queueFor('agg-2', 2, [pending()]);

    const forA = await queue.claim('a', 1, 'svc', [MAIL]);
    expect(forA.map((d) => d.id)).toEqual([first?.id]);
    const forB = await queue.claim('b', 10, 'svc', [MAIL]);
    expect(forB.map((d) => d.id)).toEqual([other?.id]);

    await queue.markDone(first?.id ?? '', 'a');
    expect((await queue.claim('b', 10, 'svc', [MAIL])).map((d) => d.id)).toEqual([second?.id]);
  });

  it('reports open lanes for the aggregates asked about', async () => {
    await queueFor('agg-1', 0, [pending('mail'), { ...pending('audit'), status: 'FAILED' }]);
    expect(await queue.openLanes('svc', [agg('agg-1'), agg('agg-2')])).toEqual([
      { handlerKey: 'mail', aggregateId: agg('agg-1') },
    ]);
  });

  it('never runs a delivery while its subscriber may be running an event of the aggregate', async () => {
    const [dead] = await queueFor('agg-1', 0, [{ ...pending(), status: 'FAILED' }]);
    const { id: busy } = await publish('agg-1', 1);
    await bus.claim('a', 1, ['user.disabled']);
    await queue.replay([dead?.id ?? '']);

    expect(await queue.claim('b', 10, 'svc', [MAIL])).toEqual([]);
    await bus.markDone(busy, 'a');
    expect((await queue.claim('b', 10, 'svc', [MAIL])).map((d) => d.id)).toEqual([dead?.id]);
  });

  it('claims only registered (key, type) pairs', async () => {
    await queueFor('agg-1', 0, [pending()]);
    expect(await queue.claim('a', 10, 'svc', [{ key: 'mail', eventType: 'user.created' }])).toEqual(
      [],
    );
    expect(await queue.countOrphans('svc', [{ key: 'mail', eventType: 'user.created' }])).toBe(1);
  });

  it('rekeys a renamed subscriber and keeps its order', async () => {
    const [first] = await queueFor('agg-1', 0, [pending('MailHandler')]);
    const [second] = await queueFor('agg-1', 1, [pending('MailHandler')]);
    expect(await queue.rekey('svc', ['MailHandler'], 'mail')).toBe(2);
    const claimed = await queue.claim('a', 10, 'svc', [MAIL]);
    expect(claimed.map((d) => d.id)).toEqual([first?.id, second?.id]);
  });

  it('fails over a retry to another instance', async () => {
    const [delivery] = await queueFor('agg-1', 0, [pending()]);
    const id = delivery?.id ?? '';
    const window = { failoverWindowMs: 60_000 };
    await queue.claim('a', 1, 'svc', [MAIL], window);
    await queue.markFailed(id, 'down', 'a');

    expect(await queue.claim('a', 10, 'svc', [MAIL], window)).toEqual([]);
    expect((await queue.claim('b', 10, 'svc', [MAIL], window)).map((d) => d.id)).toEqual([id]);
  });

  it("a healthy subscriber isn't held up by a failing one, and the failing one keeps order", async () => {
    const order: string[] = [];
    let mailDown = true;
    const consumer = new EventConsumer({
      bus,
      consumerName: 'svc',
      sourceService: 'svc-b',
      logger: new NoopLogger(),
      isolation: true,
      pollIntervalMs: 20,
      retryDelaysMs: [30],
      maxAttempts: Number.POSITIVE_INFINITY,
      failoverWindowMs: 0,
    });
    consumer
      .on(
        'user.disabled',
        async (e) => {
          if (mailDown) throw new Error('smtp down');
          order.push(`mail:${(e.payload as { k: number }).k}`);
        },
        { key: 'mail' },
      )
      .on(
        'user.disabled',
        async (e) => {
          order.push(`projection:${(e.payload as { k: number }).k}`);
        },
        { key: 'projection' },
      );
    disposables.push(consumer);

    await publish('agg-1', 1);
    await publish('agg-1', 2);
    consumer.start();
    await waitFor(() => order.includes('projection:2'), 3000);
    expect(order).toEqual(['projection:1', 'projection:2']);

    mailDown = false;
    await waitFor(async () => (await count(tables.deliveriesTable)) === 0, 3000);
    expect(order.slice(2)).toEqual(['mail:1', 'mail:2']);
    expect(await count(tables.eventsTable)).toBe(0);
  });

  it('dead-letters one subscriber and replays only it, with a fresh budget', async () => {
    const runs: string[] = [];
    let broken = true;
    const consumer = new EventConsumer({
      bus,
      consumerName: 'svc',
      sourceService: 'svc-b',
      logger: new NoopLogger(),
      isolation: true,
      pollIntervalMs: 20,
      failoverWindowMs: 0,
      isPermanentFailure: () => broken,
    });
    consumer
      .on(
        'user.disabled',
        async () => {
          runs.push('mail');
          if (broken) throw new Error('template missing');
        },
        { key: 'mail' },
      )
      .on(
        'user.disabled',
        async () => {
          runs.push('projection');
        },
        { key: 'projection' },
      );
    disposables.push(consumer);

    await publish('agg-1', 0);
    consumer.start();
    const dead = async () =>
      (
        await pool.query<{ id: string; retry_count: number }>(
          `SELECT id, retry_count FROM ${tables.deliveriesTable} WHERE status = 'FAILED'`,
        )
      ).rows;
    await waitFor(async () => (await dead()).length === 1, 3000);
    expect(runs.sort()).toEqual(['mail', 'projection']);

    broken = false;
    const [row] = await dead();
    expect(await queue.replay([row?.id ?? ''])).toEqual([row?.id]);
    await waitFor(async () => (await count(tables.deliveriesTable)) === 0, 3000);
    expect(runs.filter((r) => r === 'projection')).toHaveLength(1);
    expect(runs.filter((r) => r === 'mail')).toHaveLength(2);
  });
});
