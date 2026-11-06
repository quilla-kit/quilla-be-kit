import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { NoopLogger } from '@quilla-be-kit/observability';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../../src/background-job.interface.js';
import { InProcessJobRunner } from '../../src/in-process.job-runner.js';
import { JobInstances } from '../../src/job-run-on.type.js';
import { JobScheduleType } from '../../src/job-schedule.type.js';
import { getJobLeaseSchema } from '../../src/postgres/get-job-lease-schema.js';
import { PgJobLeaseStore } from '../../src/postgres/pg-job-lease.store.js';
import { deferred } from '../helpers/deferred.js';
import { PG_URL, createPool, createTable, dropTable, sleep } from '../helpers/pg-test-db.js';

const anyJob = (execute: BackgroundJob['execute']): BackgroundJob => ({
  name: 'it.job',
  schedule: { type: JobScheduleType.Interval, everyMs: 1000 },
  runOn: { instances: JobInstances.Any, leaseMs: 1500 },
  execute,
});

describe.skipIf(!PG_URL)('PgJobLeaseStore (integration)', () => {
  let pool: pg.Pool;
  let table: string;
  let store: PgJobLeaseStore;
  const runners: InProcessJobRunner[] = [];

  const newRunner = (leaseStore = store) => {
    const runner = new InProcessJobRunner(new AsyncExecutionContextProvider(), new NoopLogger(), {
      leaseStore,
    });
    runners.push(runner);
    return runner;
  };

  const acquire = (instanceId: string, leaseMs: number, cooldownMs = 0) =>
    store.tryAcquire({ jobName: 'it.job', instanceId, leaseMs, cooldownMs });

  const row = async () =>
    (await pool.query(`SELECT * FROM ${table} WHERE job_name = 'it.job'`)).rows[0] as
      | { lease_token: string | null; claimed_by: string | null }
      | undefined;

  beforeEach(async () => {
    pool = createPool();
    table = await createTable(pool);
    store = new PgJobLeaseStore({ pool, table });
  });

  afterEach(async () => {
    await Promise.all(runners.splice(0).map((r) => r.dispose()));
    await dropTable(pool, table);
    await pool.end();
  });

  it('grants exactly one of many concurrent acquires', async () => {
    const leases = await Promise.all(Array.from({ length: 10 }, (_, i) => acquire(`i${i}`, 5000)));
    expect(leases.filter((l) => l !== null)).toHaveLength(1);
  });

  it('ignores renew and release with a stale token', async () => {
    const stale = await acquire('a', 50);
    await sleep(80);
    const current = await acquire('b', 5000);
    const token = stale?.token ?? '';

    expect(await store.renew({ jobName: 'it.job', token, leaseMs: 5000 })).toBe(false);
    await store.release({ jobName: 'it.job', token });
    expect((await row())?.lease_token).toBe(current?.token);
  });

  it('keeps the cooldown across release unless reset', async () => {
    const first = await acquire('a', 5000, 5000);
    await store.release({ jobName: 'it.job', token: first?.token ?? '' });
    expect(await acquire('a', 5000, 5000)).toBeNull();

    await pool.query(`UPDATE ${table} SET cooldown_until = now()`);
    const second = await acquire('a', 5000, 5000);
    await store.release({ jobName: 'it.job', token: second?.token ?? '', resetCooldown: true });
    expect(await acquire('a', 5000, 5000)).not.toBeNull();
  });

  it('runs once per interval across two runners', async () => {
    const a = vi.fn(async () => {});
    const b = vi.fn(async () => {});
    newRunner().register(anyJob(a));
    await sleep(300);
    newRunner().register(anyJob(b));

    await sleep(3300);

    expect(a.mock.calls.length + b.mock.calls.length).toBe(3);
  });

  it('lets another runner take over after a dead holder’s lease expires', async () => {
    const deadStore = new PgJobLeaseStore({ pool, table });
    vi.spyOn(deadStore, 'renew').mockImplementation(() => new Promise(() => {}));
    const finishDead = deferred();
    const dead = vi.fn(() => finishDead.promise);
    const b = vi.fn(async () => {});

    newRunner(deadStore).register(anyJob(dead));
    await sleep(300);
    newRunner().register(anyJob(b));

    await sleep(2000);
    expect(dead).toHaveBeenCalledTimes(1);
    expect(b).not.toHaveBeenCalled();
    await sleep(1200);
    expect(b).toHaveBeenCalledTimes(1);
    finishDead.resolve();
  });

  it('dispose() releases the held lease', async () => {
    const runner = newRunner();
    runner.register(
      anyJob(
        (signal) =>
          new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve())),
      ),
    );
    await sleep(1200);
    expect((await row())?.lease_token).not.toBeNull();

    await runner.dispose();

    expect((await row())?.lease_token).toBeNull();
    expect((await row())?.claimed_by).toBeNull();
  });

  it('applies the schema idempotently', async () => {
    await pool.query(getJobLeaseSchema({ table }));
    await pool.query(getJobLeaseSchema({ table }));
  });
});
