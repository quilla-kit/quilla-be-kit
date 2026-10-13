import { AsyncExecutionContextProvider } from '@quilla-be-kit/execution-context';
import { type Logger, NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../src/background-job.interface.js';
import { InProcessJobRunner } from '../src/in-process.job-runner.js';
import { JobScheduleType } from '../src/job-schedule.type.js';

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
