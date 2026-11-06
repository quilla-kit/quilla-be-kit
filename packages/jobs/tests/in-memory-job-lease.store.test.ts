import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InMemoryJobLeaseStore } from '../src/in-memory-job-lease.store.js';
import type { JobLease } from '../src/job-lease-store.interface.js';

const acquire = (store: InMemoryJobLeaseStore, instanceId: string, cooldownMs = 0) =>
  store.tryAcquire({ jobName: 'job', instanceId, leaseMs: 1000, cooldownMs });

const tokenOf = (lease: JobLease | null): string => lease?.token ?? '';

describe('InMemoryJobLeaseStore', () => {
  let store: InMemoryJobLeaseStore;

  beforeEach(() => {
    vi.useFakeTimers();
    store = new InMemoryJobLeaseStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('grants one lease at a time', async () => {
    const lease = await acquire(store, 'a');
    expect(lease?.token).toEqual(expect.any(String));
    expect(await acquire(store, 'b')).toBeNull();
  });

  it('frees the job once the lease expires', async () => {
    await acquire(store, 'a');
    vi.advanceTimersByTime(999);
    expect(await acquire(store, 'b')).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await acquire(store, 'b')).not.toBeNull();
  });

  it('renew extends the lease while the token matches', async () => {
    const lease = await acquire(store, 'a');
    vi.advanceTimersByTime(900);
    expect(await store.renew({ jobName: 'job', token: tokenOf(lease), leaseMs: 1000 })).toBe(true);
    vi.advanceTimersByTime(900);
    expect(await acquire(store, 'b')).toBeNull();
  });

  it('a stale token can neither renew nor release', async () => {
    const stale = await acquire(store, 'a');
    vi.advanceTimersByTime(1000);
    const current = await acquire(store, 'b');
    const token = tokenOf(stale);

    expect(await store.renew({ jobName: 'job', token, leaseMs: 1000 })).toBe(false);
    await store.release({ jobName: 'job', token });
    expect(await acquire(store, 'c')).toBeNull();
    expect(current).not.toBeNull();
  });

  it('keeps the cooldown across release', async () => {
    const lease = await acquire(store, 'a', 5000);
    await store.release({ jobName: 'job', token: tokenOf(lease) });
    expect(await acquire(store, 'b')).toBeNull();
    vi.advanceTimersByTime(5000);
    expect(await acquire(store, 'b')).not.toBeNull();
  });

  it('resetCooldown makes the job acquirable right away', async () => {
    const lease = await acquire(store, 'a', 5000);
    await store.release({ jobName: 'job', token: tokenOf(lease), resetCooldown: true });
    expect(await acquire(store, 'b')).not.toBeNull();
  });

  it('with cooldownMs 0 it is a plain running-lease', async () => {
    const lease = await acquire(store, 'a');
    await store.release({ jobName: 'job', token: tokenOf(lease) });
    expect(await acquire(store, 'b')).not.toBeNull();
  });

  it('keeps jobs independent', async () => {
    await acquire(store, 'a');
    const other = await store.tryAcquire({
      jobName: 'other',
      instanceId: 'b',
      leaseMs: 1000,
      cooldownMs: 0,
    });
    expect(other).not.toBeNull();
  });
});
