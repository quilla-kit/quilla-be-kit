import { describe, expect, it } from 'vitest';
import { PgHandlerOutcomeStore } from '../../src/postgres/pg-handler-outcome.store.js';
import { FakePgPool } from '../helpers/fake-pg-pool.js';

describe('PgHandlerOutcomeStore', () => {
  function setup(tableName?: string) {
    const pool = new FakePgPool();
    const store = new PgHandlerOutcomeStore({
      pool: pool.asPool(),
      ...(tableName !== undefined ? { tableName } : {}),
    });
    return { pool, store };
  }

  it('loads every outcome of the given events in one query, grouped by event', async () => {
    const { pool, store } = setup();
    pool.enqueue([
      { event_id: 'e1', handler_key: 'a', outcome: 'done', error: null },
      { event_id: 'e1', handler_key: 'b', outcome: 'dead', error: 'gone' },
      { event_id: 'e2', handler_key: 'a', outcome: 'done', error: null },
    ]);

    const outcomes = await store.load(['e1', 'e2', 'e3']);

    expect(pool.calls).toHaveLength(1);
    expect(pool.calls[0]?.sql).toContain('FROM event_handler_outcomes WHERE event_id = ANY($1)');
    expect(pool.calls[0]?.params).toEqual([['e1', 'e2', 'e3']]);
    expect(outcomes.get('e1')).toEqual([
      { key: 'a', outcome: 'done' },
      { key: 'b', outcome: 'dead', error: 'gone' },
    ]);
    expect(outcomes.get('e2')).toEqual([{ key: 'a', outcome: 'done' }]);
    expect(outcomes.has('e3')).toBe(false);
  });

  it('skips the query for no ids', async () => {
    const { pool, store } = setup();
    expect((await store.load([])).size).toBe(0);
    await store.record('e1', []);
    expect(pool.calls).toHaveLength(0);
  });

  it('upserts outcomes in one statement without ever replacing done', async () => {
    const { pool, store } = setup('svc_outcomes');

    await store.record('e1', [
      { key: 'a', outcome: 'done' },
      { key: 'b', outcome: 'dead', error: 'gone' },
    ]);

    const call = pool.calls[0];
    expect(call?.sql).toContain('INSERT INTO svc_outcomes AS t');
    expect(call?.sql).toContain('ON CONFLICT (event_id, handler_key) DO UPDATE');
    expect(call?.sql).toContain("WHERE t.outcome <> 'done'");
    expect(call?.params.slice(0, 4)).toEqual(['e1', ['a', 'b'], ['done', 'dead'], [null, 'gone']]);
    expect(call?.params[4]).toBeInstanceOf(Date);
  });

  it('clears only dead outcomes by default, every outcome with includeDone', async () => {
    const { pool, store } = setup();
    await store.clear(['e1']);
    await store.clear(['e2'], { includeDone: true });
    await store.clear([]);

    expect(pool.calls.map((c) => c.sql)).toEqual([
      "DELETE FROM event_handler_outcomes WHERE event_id = ANY($1) AND outcome = 'dead'",
      'DELETE FROM event_handler_outcomes WHERE event_id = ANY($1)',
    ]);
    expect(pool.calls[0]?.params).toEqual([['e1']]);
  });

  it('ignores a foreign-key violation (the bus row is already gone)', async () => {
    const { pool, store } = setup();
    pool.failNext(Object.assign(new Error('violates foreign key'), { code: '23503' }));
    await expect(store.record('e1', [{ key: 'a', outcome: 'done' }])).resolves.toBeUndefined();
  });

  it('rethrows other errors', async () => {
    const { pool, store } = setup();
    pool.failNext(Object.assign(new Error('connection reset'), { code: '08006' }));
    await expect(store.record('e1', [{ key: 'a', outcome: 'done' }])).rejects.toThrow(
      'connection reset',
    );
  });
});
