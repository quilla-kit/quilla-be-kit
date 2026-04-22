import { AsyncExecutionContextProvider } from '@quilla-kit/execution-context';
import type { Logger } from '@quilla-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundJob } from '../src/background-job.interface.js';
import { InProcessJobRunner } from '../src/in-process.job-runner.js';
import { JobScheduleType } from '../src/job-schedule.type.js';
import { createFakeLogger } from './helpers/fake-logger.js';

function makeJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    name: 'test.job',
    schedule: { type: JobScheduleType.Interval, everyMs: 1000 },
    execute: async () => {},
    ...overrides,
  };
}

describe('InProcessJobRunner', () => {
  let provider: AsyncExecutionContextProvider;
  let logger: Logger;
  let runner: InProcessJobRunner;

  beforeEach(() => {
    vi.useFakeTimers();
    provider = new AsyncExecutionContextProvider();
    logger = createFakeLogger();
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

  it('throws on unsupported schedule types', () => {
    const badJob = {
      name: 'bad.job',
      schedule: { type: 'cron', expression: '* * * * *' },
      execute: async () => {},
    } as unknown as BackgroundJob;

    expect(() => runner.register(badJob)).toThrow(/cron/);
  });
});
