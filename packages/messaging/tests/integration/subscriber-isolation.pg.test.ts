import { NoopLogger } from '@quilla-be-kit/observability';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClaimLostError } from '../../src/event-bus/claim-lost.error.js';
import type { DeliveryPair, NewDelivery } from '../../src/event-bus/delivery-entry.type.js';
import { EventConsumer } from '../../src/event-bus/event.consumer.js';
import { getPostgresSchema } from '../../src/postgres/get-postgres-schema.js';
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
const MAIL: DeliveryPair = { key: 'mail', member: 'user.disabled', eventType: 'user.disabled' };

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

  const pending = (handlerKey = 'mail', member = 'user.disabled'): NewDelivery => ({
    handlerKey,
    member,
    status: 'PENDING',
    retryCount: 1,
  });

  const held = (handlerKey = 'mail', member = 'user.disabled'): NewDelivery => ({
    ...pending(handlerKey, member),
    status: 'FAILED',
    holdsLane: true,
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

  it('claims only registered (key, member) pairs, and reports the rest as backlog', async () => {
    await queueFor('agg-1', 0, [pending()]);
    const other = { key: 'mail', member: 'other', eventType: 'user.disabled' };
    expect(await queue.claim('a', 10, 'svc', [other])).toEqual([]);
    expect(await queue.backlog('svc')).toEqual([
      { handlerKey: 'mail', member: 'user.disabled', queued: 1, held: 0, lanes: 1 },
    ]);
  });

  it('rekeys a renamed subscriber and keeps its order', async () => {
    const [first] = await queueFor('agg-1', 0, [pending('MailHandler')]);
    const [second] = await queueFor('agg-1', 1, [pending('MailHandler')]);
    const move = {
      from: { key: 'MailHandler', member: 'user.disabled' },
      to: { key: 'mail', member: 'user.disabled' },
    };
    expect(await queue.rekey('svc', [move])).toEqual({ moved: 2, superseded: 0 });
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

  it('alternates replicas on each retry by default, then holds the lane', async () => {
    const handledBy: string[] = [];
    function start(instanceId: string) {
      const c = new EventConsumer({
        bus,
        consumerName: 'svc',
        sourceService: 'svc-b',
        logger: new NoopLogger(),
        instanceId,
        isolation: true,
        pollIntervalMs: 100, // the default failover window is two polls: 200 ms
        retryDelaysMs: [50],
      });
      c.subscriber('mail', { retry: { maxAttempts: 3 }, deadLetter: 'hold' }).on(
        'user.disabled',
        async () => {
          handledBy.push(instanceId);
          throw new Error('smtp down');
        },
      );
      disposables.push(c);
      return c;
    }

    await publish('agg-1', 0);
    start('b').start();
    await waitFor(() => handledBy.length === 1, 2000);
    start('a').start();
    await waitFor(async () => {
      const { rows } = await pool.query<{ held: boolean }>(
        `SELECT holds_lane AS held FROM ${tables.deliveriesTable} WHERE status = 'FAILED'`,
      );
      return rows[0]?.held === true;
    }, 5000);

    expect(handledBy).toEqual(['b', 'a', 'b']);
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
    expect((await queue.replay([row?.id ?? ''])).map((d) => d.id)).toEqual([row?.id]);
    await waitFor(async () => (await count(tables.deliveriesTable)) === 0, 3000);
    expect(runs.filter((r) => r === 'projection')).toHaveLength(1);
    expect(runs.filter((r) => r === 'mail')).toHaveLength(2);
  });

  describe('members and holds', () => {
    const A = { key: 'group', member: 'a', eventType: 'user.disabled' };
    const B = { key: 'group', member: 'b', eventType: 'user.disabled' };

    it("never makes a member wait for its sibling's retry on the same event", async () => {
      const [a, b] = await queueFor('agg-1', 0, [pending('group', 'a'), pending('group', 'b')]);
      await queue.claim('x', 1, 'svc', [A]);
      await queue.markFailed(a?.id ?? '', 'down', 'x', { retryAfterMs: 3_600_000 });

      expect((await queue.claim('x', 10, 'svc', [A, B])).map((d) => d.id)).toEqual([b?.id]);
    });

    it("holds the group's lane for later events, all members", async () => {
      await queueFor('agg-1', 0, [held('group', 'a')]);
      const [later] = await queueFor('agg-1', 1, [pending('group', 'b')]);
      const [elsewhere] = await queueFor('agg-2', 2, [pending('group', 'b')]);

      expect((await queue.claim('x', 10, 'svc', [A, B])).map((d) => d.id)).toEqual([elsewhere?.id]);
      expect(await queue.openLanes('svc', [agg('agg-1')])).toEqual([
        { handlerKey: 'group', aggregateId: agg('agg-1') },
      ]);
      expect(later).toBeDefined();
    });

    it('replays a held delivery first, then drains the lane in order', async () => {
      const [dead] = await queueFor('agg-1', 0, [held('group', 'a')]);
      const [next] = await queueFor('agg-1', 1, [pending('group', 'a')]);

      const [replayed] = await queue.replay([dead?.id ?? '']);
      expect(replayed).toMatchObject({ handlerKey: 'group', member: 'a', holdsLane: false });
      expect((await queue.claim('x', 1, 'svc', [A])).map((d) => d.id)).toEqual([dead?.id]);
      await queue.markDone(dead?.id ?? '', 'x');
      expect((await queue.claim('x', 1, 'svc', [A])).map((d) => d.id)).toEqual([next?.id]);
    });

    it('stays held while any held member remains', async () => {
      const [a, b] = await queueFor('agg-1', 0, [held('group', 'a'), held('group', 'b')]);
      const [later] = await queueFor('agg-1', 1, [pending('group', 'a')]);

      await queue.replay([a?.id ?? '']);
      await queue.claim('x', 1, 'svc', [A]);
      await queue.markDone(a?.id ?? '', 'x');
      expect(await queue.claim('x', 10, 'svc', [A])).toEqual([]);

      await queue.releaseHold([b?.id ?? '']);
      expect((await queue.claim('x', 10, 'svc', [A])).map((d) => d.id)).toEqual([later?.id]);
    });

    it('lists held deliveries with the work waiting behind them', async () => {
      const [dead] = await queueFor('agg-1', 0, [held('group', 'a')]);
      await queueFor('agg-1', 1, [pending('group', 'b')]);
      await queueFor('agg-1', 2, [pending('group', 'a')]);

      const list = await queue.list('svc', { state: 'held' });
      expect(list.map((h) => [h.delivery.id, h.waiting])).toEqual([[dead?.id, 2]]);
    });

    it('lists a retry that is running as retrying, and work queued behind it as waiting', async () => {
      const [running] = await queueFor('agg-1', 0, [pending('group', 'a')]);
      await queueFor('agg-1', 1, [{ ...pending('group', 'a'), retryCount: 0 }]);
      expect((await queue.claim('x', 1, 'svc', [A])).map((d) => d.id)).toEqual([running?.id]);

      const list = await queue.list('svc', { state: 'retrying' });
      expect(list.map((l) => [l.delivery.id, l.delivery.status, l.waiting])).toEqual([
        [running?.id, 'CLAIMED', 1],
      ]);
    });

    it('lists deliveries by subscriber, member, state and attempts', async () => {
      const [heldA] = await queueFor('agg-1', 0, [held('group', 'a')]);
      const [retryB] = await queueFor('agg-1', 1, [pending('group', 'b')]);
      const [fresh] = await queueFor('agg-2', 2, [{ ...pending('group', 'a'), retryCount: 0 }]);
      const [other] = await queueFor('agg-3', 3, [pending('mail')]);
      const { id } = await bus.publish({
        eventType: 'user.disabled',
        eventVersion: 1,
        eventKind: 'integration',
        payload: {},
        sourceService: 'svc-a',
        occurredAt: EPOCH,
        createdAt: EPOCH,
      });
      await bus.claim('setup', 1, ['user.disabled']);
      const [dead] = await queue.settle(id, 'svc', [held('group', 'a')], 'setup');
      const ids = async (options: Parameters<typeof queue.list>[1]) =>
        (await queue.list('svc', options)).map((l) => l.delivery.id);

      // `waiting` counts the lane's queued work behind each: none without an aggregate.
      expect((await queue.list('svc')).map((l) => [l.delivery.id, l.waiting])).toEqual([
        [heldA?.id, 1],
        [retryB?.id, 0],
        [fresh?.id, 0],
        [other?.id, 0],
        [dead?.id, 0],
      ]);
      expect(await ids({ handlerKey: 'group' })).toEqual([
        heldA?.id,
        retryB?.id,
        fresh?.id,
        dead?.id,
      ]);
      expect(await ids({ handlerKey: 'group', member: 'a' })).toEqual([
        heldA?.id,
        fresh?.id,
        dead?.id,
      ]);
      expect(await ids({ state: 'held' })).toEqual([heldA?.id]);
      expect(await ids({ state: 'dead' })).toEqual([dead?.id]);
      expect(await ids({ state: 'retrying', handlerKey: 'group' })).toEqual([retryB?.id]);
      expect(await ids({ minAttempts: 1, handlerKey: 'group' })).toEqual([
        heldA?.id,
        retryB?.id,
        dead?.id,
      ]);
      expect(await ids({ limit: 2 })).toEqual([heldA?.id, retryB?.id]);
      expect(await ids({ state: 'retrying', minAttempts: 2 })).toEqual([]);
      expect(await ids({ state: 'held', handlerKey: 'mail' })).toEqual([]);
    });

    it('keeps held rows through retention, and cleans dead work without a lane', async () => {
      await queueFor('agg-1', 0, [held('group', 'a')]);
      const { id } = await bus.publish({
        eventType: 'user.disabled',
        eventVersion: 1,
        eventKind: 'integration',
        payload: {},
        sourceService: 'svc-a',
        occurredAt: EPOCH,
        createdAt: EPOCH,
      });
      await bus.claim('setup', 1, ['user.disabled']);
      const [laneless] = await queue.settle(id, 'svc', [held('group', 'a')], 'setup');
      expect(laneless?.holdsLane).toBe(false);

      expect(await queue.cleanupFailed(new Date(Date.now() + 60_000))).toBe(1);
      expect((await queue.list('svc', { state: 'held' })).length).toBe(1);
    });

    it("keeps a lane blocked by an unregistered member's work until it is discarded", async () => {
      const [orphan] = await queueFor('agg-1', 0, [pending('group', 'removed')]);
      const [later] = await queueFor('agg-1', 1, [pending('group', 'a')]);

      expect(await queue.claim('x', 10, 'svc', [A])).toEqual([]);
      expect(await queue.backlog('svc')).toContainEqual({
        handlerKey: 'group',
        member: 'removed',
        queued: 1,
        held: 0,
        lanes: 1,
      });
      await queue.discard([orphan?.id ?? '']);
      expect((await queue.claim('x', 10, 'svc', [A])).map((d) => d.id)).toEqual([later?.id]);
    });

    it('rekeys once when replicas run it together, superseding collisions', async () => {
      await queueFor('agg-1', 0, [pending('old.a', 'user.disabled')]);
      await queueFor('agg-1', 1, [
        pending('old.a', 'user.disabled'),
        pending('old.b', 'user.disabled'),
      ]);
      const moves = ['old.a', 'old.b'].map((key) => ({
        from: { key, member: 'user.disabled' },
        to: { key: 'group', member: 'a' },
      }));

      const results = await Promise.all([queue.rekey('svc', moves), queue.rekey('svc', moves)]);
      const total = results.reduce(
        (sum, r) => ({ moved: sum.moved + r.moved, superseded: sum.superseded + r.superseded }),
        { moved: 0, superseded: 0 },
      );
      expect(total).toEqual({ moved: 2, superseded: 1 });
      expect(await queue.backlog('svc')).toEqual([
        { handlerKey: 'group', member: 'a', queued: 2, held: 0, lanes: 1 },
      ]);
    });

    it("carries the event's sequence through deliveries and replays", async () => {
      const { id } = await publish('agg-1', 0);
      const { rows } = await pool.query<{ seq: string }>(
        `SELECT seq::text FROM ${tables.eventsTable} WHERE id = $1`,
        [id],
      );
      await bus.claim('setup', 1, ['user.disabled']);
      const [dead] = await queue.settle(id, 'svc', [held('group', 'a')], 'setup');
      expect(dead?.sequence).toBe(rows[0]?.seq);
      const [replayed] = await queue.replay([dead?.id ?? '']);
      expect(replayed?.sequence).toBe(rows[0]?.seq);
    });
  });

  it('upgrades a 0.15.0 table in place, and applying the schema twice changes nothing', async () => {
    const t = tables.deliveriesTable;
    const [before] = await queueFor('agg-1', 0, [pending()]);
    await pool.query(`
      DROP INDEX ${t}_event_member_uq;
      DROP INDEX ${t}_lane_v2_idx;
      ALTER TABLE ${t} DROP COLUMN member, DROP COLUMN event_seq, DROP COLUMN holds_lane;
      CREATE UNIQUE INDEX ${t}_event_subscriber_uq ON ${t} (event_id, consumer_name, handler_key);
      CREATE INDEX ${t}_lane_idx ON ${t} (consumer_name, aggregate_id, handler_key, seq)
        WHERE aggregate_id IS NOT NULL AND status IN ('PENDING', 'CLAIMED');`);

    const schema = getPostgresSchema({
      eventsTable: tables.eventsTable,
      outboxTable: tables.outboxTable,
      deliveries: { table: t },
    });
    await pool.query(schema);
    await pool.query(schema);

    const { rows: indexes } = await pool.query<{ indexname: string }>(
      'SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY indexname',
      [t],
    );
    expect(indexes.map((i) => i.indexname)).toEqual(
      expect.arrayContaining([`${t}_event_member_uq`, `${t}_lane_v2_idx`]),
    );
    expect(indexes.map((i) => i.indexname)).not.toContain(`${t}_event_subscriber_uq`);
    expect(indexes.map((i) => i.indexname)).not.toContain(`${t}_lane_idx`);
    const [claimed] = await queue.claim('x', 1, 'svc', [MAIL]);
    expect(claimed).toMatchObject({ id: before?.id, member: 'user.disabled' });
  });

  it('a held bridge group keeps order through a dead letter, then drains after replay', async () => {
    const published: string[] = [];
    let broken = true;
    const consumer = new EventConsumer({
      bus,
      consumerName: 'svc',
      sourceService: 'svc-b',
      logger: new NoopLogger(),
      isolation: true,
      pollIntervalMs: 20,
      failoverWindowMs: 0,
    });
    consumer
      .subscriber('bridges.users', {
        deadLetter: 'hold',
        isPermanentFailure: () => broken,
      })
      .on('user.disabled', async (e) => {
        if (broken) throw new Error('mapping missing');
        published.push(`disabled:${(e.payload as { k: number }).k}`);
      })
      .on('user.enabled', async (e) => {
        published.push(`enabled:${(e.payload as { k: number }).k}`);
      });
    disposables.push(consumer);

    await publish('agg-1', 1, 'user.disabled');
    await publish('agg-1', 2, 'user.enabled');
    consumer.start();
    await waitFor(async () => (await queue.list('svc', { state: 'held' })).length === 1, 3000);
    await waitFor(async () => (await count(tables.eventsTable)) === 0, 3000);
    expect(published).toEqual([]);

    broken = false;
    const [heldDelivery] = await queue.list('svc', { state: 'held' });
    await queue.replay([heldDelivery?.delivery.id ?? '']);
    await waitFor(async () => (await count(tables.deliveriesTable)) === 0, 3000);
    expect(published).toEqual(['disabled:1', 'enabled:2']);
  });
});
