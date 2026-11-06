import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { type Logger, NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../src/background-job.interface.js';
import { InMemoryJobLeaseStore } from '../src/in-memory-job-lease.store.js';
import {
  InProcessJobRunner,
  type InProcessJobRunnerOptions,
} from '../src/in-process.job-runner.js';
import { JobLeaseLostError } from '../src/job-lease-lost.error.js';
import { JobInstances } from '../src/job-run-on.type.js';
import { type JobSchedule, JobScheduleType } from '../src/job-schedule.type.js';
import { deferred } from './helpers/deferred.js';

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    name: 'test.job',
    schedule: { type: JobScheduleType.Interval, everyMs: 1000 },
    execute: async () => {},
    ...overrides,
  };
}

function delayedJob(
  initialDelayMs: number,
  execute: BackgroundJob['execute'] = vi.fn(async () => {}),
) {
  return makeJob({
    execute,
    schedule: { type: JobScheduleType.Interval, everyMs: 1000, initialDelayMs },
  });
}

function deferredExecute() {
  const resolvers: Array<() => void> = [];
  const execute = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        resolvers.push(resolve);
      }),
  );
  return { execute, finishCurrent: () => resolvers.shift()?.() };
}

describe('InProcessJobRunner', () => {
  let provider: AsyncExecutionContextProvider;
  let logger: Logger;
  let runner: InProcessJobRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new AsyncExecutionContextProvider();
    logger = new NoopLogger();
    runner = new InProcessJobRunner(provider, logger);
  });

  afterEach(async () => {
    await runner.dispose();
    vi.useRealTimers();
  });

  it('ticks the job at the configured interval', async () => {
    const execute = vi.fn(async () => {});
    runner.register(makeJob({ execute }));

    await vi.advanceTimersByTimeAsync(3500);

    expect(execute).toHaveBeenCalledTimes(3);
  });

  it('ignores duplicate register for the same job name', async () => {
    const execute = vi.fn(async () => {});
    const job = makeJob({ execute });
    runner.register(job);
    runner.register(job);

    await vi.advanceTimersByTimeAsync(1000);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('stop() halts further ticks', async () => {
    const execute = vi.fn(async () => {});
    runner.register(makeJob({ execute }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(1);

    runner.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('drain() awaits an in-flight execution', async () => {
    let resolveExecute!: () => void;
    const executing = new Promise<void>((resolve) => {
      resolveExecute = resolve;
    });
    const execute = vi.fn(() => executing);
    runner.register(makeJob({ execute }));

    await vi.advanceTimersByTimeAsync(1000);
    expect(execute).toHaveBeenCalledTimes(1);

    runner.stop();
    const drained = runner.drain();
    let drainedResolved = false;
    void drained.then(() => {
      drainedResolved = true;
    });

    await Promise.resolve();
    expect(drainedResolved).toBe(false);

    resolveExecute();
    await drained;
    expect(drainedResolved).toBe(true);
  });

  it('dispose() stops the runner and drains in-flight ticks', async () => {
    let resolveExecute!: () => void;
    const executing = new Promise<void>((resolve) => {
      resolveExecute = resolve;
    });
    const execute = vi.fn(() => executing);
    runner.register(makeJob({ execute }));

    await vi.advanceTimersByTimeAsync(1000);
    const disposed = runner.dispose();

    await vi.advanceTimersByTimeAsync(5000);
    expect(execute).toHaveBeenCalledTimes(1);

    resolveExecute();
    await disposed;
  });

  it('errors in execute() are logged, not thrown out of the tick', async () => {
    const error = vi.spyOn(logger, 'error');
    const execute = vi.fn(async () => {
      throw new Error('boom');
    });
    runner.register(makeJob({ execute }));

    await vi.advanceTimersByTimeAsync(1000);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledWith(expect.stringContaining('test.job'), expect.any(Error));
  });

  it('each tick runs inside a system execution context', async () => {
    const observed: Array<string | undefined> = [];
    const execute = vi.fn(async () => {
      observed.push(provider.getContext().actorType);
    });
    runner.register(makeJob({ execute }));

    await vi.advanceTimersByTimeAsync(2000);

    expect(observed).toEqual(['job', 'job']);
  });

  describe('overlapping runs', () => {
    it('skips ticks while the previous run is still executing', async () => {
      const { execute, finishCurrent } = deferredExecute();
      runner.register(makeJob({ execute }));

      await vi.advanceTimersByTimeAsync(3000);
      expect(execute).toHaveBeenCalledTimes(1);

      finishCurrent();
      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledTimes(2);
      finishCurrent();
    });

    it('logs a skipped tick at debug level', async () => {
      const { execute, finishCurrent } = deferredExecute();
      const scoped = new NoopLogger();
      const debug = vi.spyOn(scoped, 'debug');
      vi.spyOn(logger, 'forMethod').mockReturnValue(scoped);
      runner.register(makeJob({ execute }));

      await vi.advanceTimersByTimeAsync(2000);

      expect(debug).toHaveBeenCalledWith(expect.stringContaining('Skipping test.job'));
      finishCurrent();
    });
  });

  describe('initialDelayMs', () => {
    it('runs right after registration with 0, never synchronously in register', async () => {
      const execute = vi.fn(async () => {});
      runner.register(delayedJob(0, execute));
      expect(execute).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);
      expect(execute).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('anchors the interval on the first run', async () => {
      const execute = vi.fn(async () => {});
      runner.register(delayedJob(300, execute));

      await vi.advanceTimersByTimeAsync(299);
      expect(execute).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(execute).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it('skips the first interval tick while the startup run is still executing', async () => {
      const { execute, finishCurrent } = deferredExecute();
      runner.register(delayedJob(0, execute));

      await vi.advanceTimersByTimeAsync(1000);
      expect(execute).toHaveBeenCalledTimes(1);
      finishCurrent();
    });

    it('stop() before the initial delay elapses prevents any run', async () => {
      const execute = vi.fn(async () => {});
      runner.register(delayedJob(500, execute));

      runner.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
      'throws on initialDelayMs %s',
      (initialDelayMs) => {
        expect(() => runner.register(delayedJob(initialDelayMs))).toThrow(/initialDelayMs/);
      },
    );
  });

  it('throws on unsupported schedule types', () => {
    const badJob = {
      name: 'bad.job',
      schedule: { type: 'cron', expression: '* * * * *' },
      execute: async () => {},
    } as unknown as BackgroundJob;

    expect(() => runner.register(badJob)).toThrow(/cron/);
  });
});

function anyJob(
  execute: BackgroundJob['execute'],
  { leaseMs, ...overrides }: Partial<BackgroundJob> & { leaseMs?: number } = {},
): BackgroundJob {
  return makeJob({ execute, runOn: { instances: JobInstances.Any, leaseMs }, ...overrides });
}

// Executes that wait until finished, recording the signal of each run.
function heldExecute() {
  const signals: AbortSignal[] = [];
  const resolvers: Array<() => void> = [];
  const execute = vi.fn(
    (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        signals.push(signal);
        resolvers.push(resolve);
      }),
  );
  const finishAll = () => {
    for (const resolve of resolvers.splice(0)) resolve();
  };
  return { execute, signals, finishAll };
}

describe('InProcessJobRunner across instances', () => {
  let provider: AsyncExecutionContextProvider;
  let store: InMemoryJobLeaseStore;
  let runners: InProcessJobRunner[];

  const newRunner = (options: InProcessJobRunnerOptions = {}) => {
    const runner = new InProcessJobRunner(provider, new NoopLogger(), {
      leaseStore: store,
      leaseMs: 3000,
      ...options,
    });
    runners.push(runner);
    return runner;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new AsyncExecutionContextProvider();
    store = new InMemoryJobLeaseStore();
    runners = [];
  });

  afterEach(async () => {
    await Promise.all(runners.map((r) => r.dispose()));
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("runOn 'any'", () => {
    it('runs once per interval across out-of-phase instances', async () => {
      const a = vi.fn(async () => {});
      const b = vi.fn(async () => {});
      newRunner().register(anyJob(a));
      await vi.advanceTimersByTimeAsync(400);
      newRunner().register(anyJob(b));

      await vi.advanceTimersByTimeAsync(9600);

      expect(a.mock.calls.length + b.mock.calls.length).toBe(10);
    });

    it("leaves 'all' jobs running on every instance", async () => {
      const a = vi.fn(async () => {});
      const b = vi.fn(async () => {});
      newRunner().register(makeJob({ execute: a }));
      newRunner().register(makeJob({ execute: b }));

      await vi.advanceTimersByTimeAsync(3000);

      expect(a).toHaveBeenCalledTimes(3);
      expect(b).toHaveBeenCalledTimes(3);
    });

    it('lets another instance take over once a dead holder’s lease expires', async () => {
      const deadStore = new InMemoryJobLeaseStore();
      vi.spyOn(deadStore, 'tryAcquire').mockImplementation((req) => store.tryAcquire(req));
      vi.spyOn(deadStore, 'renew').mockImplementation(() => new Promise(() => {}));
      vi.spyOn(deadStore, 'release').mockImplementation((req) => store.release(req));
      const dead = heldExecute();
      const startedAt: number[] = [];
      const b = vi.fn(async () => {
        startedAt.push(Date.now());
      });
      const t0 = Date.now();

      newRunner({ leaseStore: deadStore }).register(anyJob(dead.execute));
      await vi.advanceTimersByTimeAsync(500);
      newRunner().register(anyJob(b));
      await vi.advanceTimersByTimeAsync(4500);

      expect(dead.execute).toHaveBeenCalledTimes(1);
      expect(startedAt.map((t) => t - t0)).toEqual([4500]);
      dead.finishAll();
    });

    it('aborts the run with JobLeaseLostError when the lease is lost', async () => {
      vi.spyOn(store, 'renew').mockResolvedValueOnce(false);
      const held = heldExecute();
      newRunner().register(anyJob(held.execute));

      await vi.advanceTimersByTimeAsync(2000);

      expect(held.signals[0]?.aborted).toBe(true);
      expect(JobLeaseLostError.is(held.signals[0]?.reason)).toBe(true);
      held.finishAll();
    });

    it('stop() during a pending acquire releases the lease without running the job', async () => {
      const gate = deferred();
      const realAcquire = store.tryAcquire.bind(store);
      vi.spyOn(store, 'tryAcquire').mockImplementationOnce(async (req) => {
        await gate.promise;
        return realAcquire(req);
      });
      const release = vi.spyOn(store, 'release');
      const execute = vi.fn(async () => {});
      const runner = newRunner();
      runner.register(anyJob(execute));

      await vi.advanceTimersByTimeAsync(1000);
      runner.stop();
      gate.resolve();
      await runner.drain();

      expect(execute).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ resetCooldown: true }));
    });

    it('dispose() releases the held lease', async () => {
      const release = vi.spyOn(store, 'release');
      const runner = newRunner();
      runner.register(
        anyJob(async (signal) => {
          await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve()));
        }),
      );

      await vi.advanceTimersByTimeAsync(1000);
      await runner.dispose();

      expect(release).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledWith(expect.objectContaining({ resetCooldown: false }));
    });

    it("skips 'any' ticks while the store is unavailable and keeps 'all' jobs running", async () => {
      vi.spyOn(store, 'tryAcquire').mockRejectedValue(new Error('db down'));
      const anyExecute = vi.fn(async () => {});
      const allExecute = vi.fn(async () => {});
      const runner = newRunner();
      runner.register(anyJob(anyExecute));
      runner.register(makeJob({ name: 'other.job', execute: allExecute }));

      await vi.advanceTimersByTimeAsync(2000);

      expect(anyExecute).not.toHaveBeenCalled();
      expect(allExecute).toHaveBeenCalledTimes(2);
    });

    it('uses a per-job leaseMs override', async () => {
      const tryAcquire = vi.spyOn(store, 'tryAcquire');
      newRunner().register(anyJob(async () => {}, { leaseMs: 9000 }));

      await vi.advanceTimersByTimeAsync(1000);

      expect(tryAcquire).toHaveBeenCalledWith(
        expect.objectContaining({ leaseMs: 9000, cooldownMs: 900 }),
      );
    });
  });

  describe('abort signal', () => {
    it.each([
      ['all', (execute: BackgroundJob['execute']) => makeJob({ execute })],
      ['any', (execute: BackgroundJob['execute']) => anyJob(execute)],
    ])("stop() aborts in-flight '%s' runs", async (_mode, build) => {
      const held = heldExecute();
      const runner = newRunner();
      runner.register(build(held.execute));

      await vi.advanceTimersByTimeAsync(1000);
      runner.stop();

      expect(held.signals[0]?.aborted).toBe(true);
      expect(JobLeaseLostError.is(held.signals[0]?.reason)).toBe(false);
      held.finishAll();
    });

    it('register() after stop() schedules again', async () => {
      const execute = vi.fn(async () => {});
      const runner = newRunner();
      runner.register(makeJob({ execute }));
      runner.stop();
      runner.register(makeJob({ execute }));

      await vi.advanceTimersByTimeAsync(1000);

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('jitterMs', () => {
    it('offsets every run after the first by up to jitterMs, on the anchored grid', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const t0 = Date.now();
      const at: number[] = [];
      newRunner().register(
        makeJob({
          execute: async () => {
            at.push(Date.now() - t0);
          },
          schedule: { type: JobScheduleType.Interval, everyMs: 1000, jitterMs: 200 },
        }),
      );

      await vi.advanceTimersByTimeAsync(4200);

      expect(at).toEqual([1000, 2100, 3100, 4100]);
    });

    it('keeps initialDelayMs: 0 exact', async () => {
      vi.spyOn(Math, 'random').mockReturnValue(0.99);
      const execute = vi.fn(async () => {});
      newRunner().register(
        makeJob({
          execute,
          schedule: {
            type: JobScheduleType.Interval,
            everyMs: 1000,
            initialDelayMs: 0,
            jitterMs: 500,
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(0);

      expect(execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('clock changes', () => {
    it('skips slots that passed while the clock jumped forward, without a burst', async () => {
      const t0 = Date.now();
      const at: number[] = [];
      let jumped = false;
      newRunner().register(
        makeJob({
          execute: async () => {
            at.push(Date.now() - t0);
            if (!jumped) {
              jumped = true;
              vi.setSystemTime(Date.now() + 3500);
            }
          },
        }),
      );

      await vi.advanceTimersByTimeAsync(2500);

      expect(at).toEqual([1000, 5500, 6000]);
    });

    it('re-anchors instead of stalling when the clock steps back', async () => {
      const execute = vi.fn(async () => {
        if (execute.mock.calls.length === 1) vi.setSystemTime(Date.now() - 600_000);
      });
      newRunner().register(makeJob({ execute }));

      await vi.advanceTimersByTimeAsync(3000);

      expect(execute).toHaveBeenCalledTimes(3);
    });
  });

  describe('register validation', () => {
    const schedule = (everyMs: number, extra: Partial<JobSchedule> = {}): JobSchedule => ({
      type: JobScheduleType.Interval,
      everyMs,
      ...extra,
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])(
      'throws on everyMs %s',
      (everyMs) => {
        expect(() => newRunner().register(makeJob({ schedule: schedule(everyMs) }))).toThrow(
          /everyMs/,
        );
      },
    );

    it('throws on initialDelayMs above the timer limit', () => {
      expect(() =>
        newRunner().register(makeJob({ schedule: schedule(1000, { initialDelayMs: 2 ** 31 }) })),
      ).toThrow(/initialDelayMs/);
    });

    it.each([-1, 1000, Number.NaN])('throws on jitterMs %s', (jitterMs) => {
      expect(() =>
        newRunner().register(makeJob({ schedule: schedule(1000, { jitterMs }) })),
      ).toThrow(/jitterMs/);
    });

    it("throws on an 'any' job without a lease store", () => {
      const runner = new InProcessJobRunner(provider, new NoopLogger());
      runners.push(runner);
      expect(() => runner.register(anyJob(async () => {}))).toThrow(/leaseStore/);
    });

    it("throws on an 'any' job with leaseMs below 3", () => {
      expect(() => newRunner().register(anyJob(async () => {}, { leaseMs: 2 }))).toThrow(/leaseMs/);
    });

    it("throws on an 'any' job with everyMs below 1000", () => {
      const job = anyJob(async () => {}, { schedule: schedule(999) });
      expect(() => newRunner().register(job)).toThrow(/everyMs/);
    });

    it("throws on an 'any' job with jitterMs", () => {
      const job = anyJob(async () => {}, { schedule: schedule(1000, { jitterMs: 100 }) });
      expect(() => newRunner().register(job)).toThrow(/jitterMs/);
    });

    it('throws on an unknown runOn.instances', () => {
      const job = { ...makeJob(), runOn: { instances: 'some' } } as unknown as BackgroundJob;
      expect(() => newRunner().register(job)).toThrow(/some/);
    });

    it('throws on an invalid runner leaseMs when a store is given', () => {
      expect(() => newRunner({ leaseMs: 1 })).toThrow(/leaseMs/);
    });
  });
});
