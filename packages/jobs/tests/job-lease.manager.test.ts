import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobLeaseStore } from '../src/in-memory-job-lease.store.js';
import { JobLeaseLostError } from '../src/job-lease-lost.error.js';
import { JobLeaseManager } from '../src/job-lease.manager.js';
import { deferred } from './helpers/deferred.js';

describe('JobLeaseManager', () => {
  let store: InMemoryJobLeaseStore;
  let logger: NoopLogger;
  let manager: JobLeaseManager;

  const newManager = (instanceId: string, leaseMs = 3000) =>
    new JobLeaseManager({ store, instanceId, logger, leaseMs });

  // Starts a run whose fn waits until released, exposing the signal it received.
  function hold(
    target: JobLeaseManager,
    options: { cooldownMs?: number; signal?: AbortSignal } = {},
  ) {
    const gate = deferred();
    let signal: AbortSignal | undefined;
    const ran = target.run(
      'job',
      { cooldownMs: options.cooldownMs ?? 0, signal: options.signal },
      async (s) => {
        signal = s;
        await gate.promise;
      },
    );
    return { ran, finish: gate.resolve, signal: () => signal };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryJobLeaseStore();
    logger = new NoopLogger();
    manager = newManager('a');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs fn under the lease and releases it afterwards', async () => {
    const fn = vi.fn(async (signal: AbortSignal) => {
      expect(signal.aborted).toBe(false);
    });
    expect(await manager.run('job', { cooldownMs: 0 }, fn)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(await newManager('b').run('job', { cooldownMs: 0 }, async () => {})).toBe(true);
  });

  it('returns false without running fn while another instance holds the lease', async () => {
    const held = hold(manager);
    await vi.advanceTimersByTimeAsync(0);
    const fn = vi.fn(async () => {});

    expect(await newManager('b').run('job', { cooldownMs: 0 }, fn)).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    held.finish();
    await held.ran;
  });

  it('releases the lease when fn throws, and rethrows', async () => {
    await expect(
      manager.run('job', { cooldownMs: 0 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await newManager('b').run('job', { cooldownMs: 0 }, async () => {})).toBe(true);
  });

  it('keeps the cooldown after a completed run', async () => {
    await manager.run('job', { cooldownMs: 5000 }, async () => {});
    expect(await newManager('b').run('job', { cooldownMs: 5000 }, async () => {})).toBe(false);
  });

  it('does not touch the store when the caller signal is already aborted', async () => {
    const tryAcquire = vi.spyOn(store, 'tryAcquire');
    const controller = new AbortController();
    controller.abort();

    expect(
      await manager.run('job', { cooldownMs: 0, signal: controller.signal }, async () => {}),
    ).toBe(false);
    expect(tryAcquire).not.toHaveBeenCalled();
  });

  it('releases with resetCooldown when the caller aborts during the acquire', async () => {
    const gate = deferred();
    const realAcquire = store.tryAcquire.bind(store);
    vi.spyOn(store, 'tryAcquire').mockImplementationOnce(async (req) => {
      await gate.promise;
      return realAcquire(req);
    });
    const release = vi.spyOn(store, 'release');
    const controller = new AbortController();
    const fn = vi.fn(async () => {});

    const ran = manager.run('job', { cooldownMs: 5000, signal: controller.signal }, fn);
    controller.abort();
    gate.resolve();

    expect(await ran).toBe(false);
    expect(fn).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ resetCooldown: true }));
    expect(await newManager('b').run('job', { cooldownMs: 0 }, async () => {})).toBe(true);
  });

  it('aborts the run signal when the caller signal aborts', async () => {
    const controller = new AbortController();
    const held = hold(manager, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    controller.abort();
    expect(held.signal()?.aborted).toBe(true);
    expect(JobLeaseLostError.is(held.signal()?.reason)).toBe(false);
    held.finish();
    expect(await held.ran).toBe(true);
  });

  it('renews every third of the lease', async () => {
    const renew = vi.spyOn(store, 'renew');
    const held = hold(manager);

    await vi.advanceTimersByTimeAsync(999);
    expect(renew).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(renew).toHaveBeenCalledTimes(2);
    expect(held.signal()?.aborted).toBe(false);
    held.finish();
    await held.ran;
  });

  it('aborts with JobLeaseLostError when renew reports the lease gone', async () => {
    vi.spyOn(store, 'renew').mockResolvedValueOnce(false);
    const warn = vi.spyOn(logger, 'warn');
    const held = hold(manager);

    await vi.advanceTimersByTimeAsync(1000);

    expect(held.signal()?.aborted).toBe(true);
    expect(JobLeaseLostError.is(held.signal()?.reason)).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('lease lost'), expect.anything());
    held.finish();
    await held.ran;
  });

  it('survives one failed renew and aborts one interval before expiry', async () => {
    vi.spyOn(store, 'renew').mockRejectedValue(new Error('db down'));
    const held = hold(manager);

    await vi.advanceTimersByTimeAsync(1000);
    expect(held.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(held.signal()?.aborted).toBe(true);
    expect(JobLeaseLostError.is(held.signal()?.reason)).toBe(true);
    held.finish();
    await held.ran;
  });

  it('aborts at the deadline even while a renew hangs', async () => {
    vi.spyOn(store, 'renew').mockImplementation(() => new Promise(() => {}));
    const held = hold(manager);

    await vi.advanceTimersByTimeAsync(1999);
    expect(held.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.signal()?.aborted).toBe(true);
    held.finish();
    await held.ran;
  });

  it('confirms a renew from its send time, not its reply time', async () => {
    const renew = vi.spyOn(store, 'renew');
    renew.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(true), 500)),
    );
    renew.mockRejectedValue(new Error('db down'));
    const held = hold(manager);

    // Sent at 1000 and answered at 1500: the lease runs to 4000, so give up at 3000.
    await vi.advanceTimersByTimeAsync(2999);
    expect(held.signal()?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(held.signal()?.aborted).toBe(true);
    held.finish();
    await held.ran;
  });

  it('ignores a renew answered after the run finished', async () => {
    const answer = deferred<boolean>();
    vi.spyOn(store, 'renew').mockImplementationOnce(() => answer.promise);
    const warn = vi.spyOn(logger, 'warn');
    const held = hold(manager);

    await vi.advanceTimersByTimeAsync(1000);
    held.finish();
    expect(await held.ran).toBe(true);
    answer.resolve(false);
    await vi.advanceTimersByTimeAsync(0);

    expect(warn).not.toHaveBeenCalled();
    expect(held.signal()?.aborted).toBe(false);
  });

  it('logs one error per outage and one info on recovery', async () => {
    const error = vi.spyOn(logger, 'error');
    const debug = vi.spyOn(logger, 'debug');
    const info = vi.spyOn(logger, 'info');
    vi.spyOn(store, 'tryAcquire')
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'))
      .mockRejectedValueOnce(new Error('db down'));
    const run = () => manager.run('job', { cooldownMs: 0 }, async () => {});

    for (let i = 0; i < 3; i++) await expect(run()).rejects.toThrow('db down');
    expect(error).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalledTimes(2);
    expect(info).not.toHaveBeenCalled();

    expect(await run()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(await run()).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
  });

  it('defaults leaseMs to 60 s and instanceId to a UUID', async () => {
    const defaulted = new JobLeaseManager({ store, logger });
    const tryAcquire = vi.spyOn(store, 'tryAcquire');
    await defaulted.run('job', { cooldownMs: 0 }, async () => {});
    expect(tryAcquire).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseMs: 60_000,
        instanceId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
  });

  it('a per-run leaseMs overrides the default', async () => {
    const renew = vi.spyOn(store, 'renew');
    const gate = deferred();
    const ran = manager.run('job', { cooldownMs: 0, leaseMs: 300 }, () => gate.promise);

    await vi.advanceTimersByTimeAsync(100);
    expect(renew).toHaveBeenCalledWith(expect.objectContaining({ leaseMs: 300 }));
    gate.resolve();
    await ran;
  });

  it.each([2, Number.NaN, Number.POSITIVE_INFINITY])('rejects leaseMs %s', async (leaseMs) => {
    expect(() => new JobLeaseManager({ store, instanceId: 'a', logger, leaseMs })).toThrow(
      /leaseMs/,
    );
    await expect(manager.run('job', { cooldownMs: 0, leaseMs }, async () => {})).rejects.toThrow(
      /leaseMs/,
    );
  });

  it('rejects a negative cooldownMs', async () => {
    await expect(manager.run('job', { cooldownMs: -1 }, async () => {})).rejects.toThrow(
      /cooldownMs/,
    );
  });
});
