import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaimLeaseManager,
  type ClaimLeaseManagerOptions,
} from '../../src/event-bus/claim-lease.manager.js';
import { ClaimLostError } from '../../src/event-bus/claim-lost.error.js';
import { FakeLease } from '../helpers/fake-lease.js';

const ENTRY = { id: 'evt-1', eventType: 'test.happened' };

describe('ClaimLeaseManager', () => {
  let lease: FakeLease;
  let logger: NoopLogger;

  beforeEach(() => {
    vi.useFakeTimers();
    lease = new FakeLease(60_000);
    logger = new NoopLogger();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeManager(overrides: Partial<ClaimLeaseManagerOptions> = {}): ClaimLeaseManager {
    return new ClaimLeaseManager({
      lease,
      instanceId: 'replica-1',
      renewIntervalMs: 20_000,
      logger,
      onLeaseLost: undefined,
      ...overrides,
    });
  }

  describe('renew interval', () => {
    it('is 0 without a lease', () => {
      expect(makeManager({ lease: undefined, renewIntervalMs: 5_000 }).renewIntervalMs).toBe(0);
    });

    it('defaults to a third of the lease', () => {
      expect(makeManager({ renewIntervalMs: undefined }).renewIntervalMs).toBe(20_000);
    });

    it('accepts 0 to disable and rejects values at or above the lease', () => {
      expect(makeManager({ renewIntervalMs: 0 }).renewIntervalMs).toBe(0);
      expect(() => makeManager({ renewIntervalMs: 60_000 })).toThrow(/renewIntervalMs/);
      expect(() => makeManager({ renewIntervalMs: -1 })).toThrow(/renewIntervalMs/);
    });
  });

  describe('acquire', () => {
    it('confirms without a query while the claim is fresh', async () => {
      const manager = makeManager();
      manager.begin([ENTRY]);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(await manager.acquire(ENTRY)).toBe(true);
      expect(lease.renewCalls).toHaveLength(0);
      manager.end();
    });

    it('renews a stale claim and refuses it when no longer held', async () => {
      const onLeaseLost = vi.fn();
      const manager = makeManager({ onLeaseLost });
      manager.begin([ENTRY]);
      await vi.advanceTimersByTimeAsync(20_001);
      lease.lost.add('evt-1');

      expect(await manager.acquire(ENTRY)).toBe(false);
      expect(lease.renewCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-1'] }]);
      expect(onLeaseLost).toHaveBeenCalledWith({ ...ENTRY, stage: 'renew' });
      manager.end();
    });

    it('fails open when the renew query errors', async () => {
      const error = vi.spyOn(logger, 'error');
      const manager = makeManager();
      manager.begin([ENTRY]);
      await vi.advanceTimersByTimeAsync(20_001);
      lease.renewError = new Error('db down');

      expect(await manager.acquire(ENTRY)).toBe(true);
      expect(error).toHaveBeenCalledWith(
        'lease renewal failed',
        lease.renewError,
        expect.anything(),
      );
      manager.end();
    });

    it('never queries when no lease is configured', async () => {
      const manager = makeManager({ lease: undefined });
      manager.begin([ENTRY]);
      expect(await manager.acquire(ENTRY)).toBe(true);
      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.renewCalls).toHaveLength(0);
      manager.end();
    });
  });

  describe('renewal timer', () => {
    it('renews only the held entry', async () => {
      const manager = makeManager();
      manager.begin([ENTRY, { id: 'evt-2', eventType: 'test.happened' }]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(lease.renewCalls).toHaveLength(0);

      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(lease.renewCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-1'] }]);
      manager.end();
    });

    it('skips an interval while the previous renew is still in flight', async () => {
      const { promise: pending, resolve: release } = Promise.withResolvers<void>();
      const renew = vi.spyOn(lease, 'renew').mockImplementation(async (_id, ids) => {
        await pending;
        return ids;
      });
      const manager = makeManager();
      manager.begin([ENTRY]);
      manager.hold(ENTRY);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(renew).toHaveBeenCalledTimes(1);

      release();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(renew).toHaveBeenCalledTimes(2);
      manager.end();
    });

    it('keeps renewing after a failed renew query', async () => {
      lease.renewError = new Error('db down');
      const manager = makeManager();
      manager.begin([ENTRY]);
      manager.hold(ENTRY);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(lease.renewCalls).toHaveLength(2);
      manager.end();
    });

    it('stops renewing an entry once it is lost', async () => {
      const onLeaseLost = vi.fn();
      lease.lost.add('evt-1');
      const manager = makeManager({ onLeaseLost });
      manager.begin([ENTRY]);
      manager.hold(ENTRY);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.renewCalls).toHaveLength(1);
      expect(onLeaseLost).toHaveBeenCalledTimes(1);
      manager.end();
    });

    it('does not start a timer for an empty batch', async () => {
      const manager = makeManager();
      manager.begin([]);
      expect(vi.getTimerCount()).toBe(0);
      manager.end();
    });

    it('end() stops the timer', async () => {
      const manager = makeManager();
      manager.begin([ENTRY]);
      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(20_000);
      manager.end();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.renewCalls).toHaveLength(1);
    });
  });

  describe('settle', () => {
    it('stops renewing the entry before the write', async () => {
      const manager = makeManager();
      manager.begin([ENTRY]);
      manager.hold(ENTRY);
      await manager.settle(ENTRY, 'done', async () => {});
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.renewCalls).toHaveLength(0);
      manager.end();
    });

    it('reports ClaimLostError and rethrows other errors', async () => {
      const onLeaseLost = vi.fn();
      const manager = makeManager({ onLeaseLost });
      await manager.settle(ENTRY, 'failed', async () => {
        throw new ClaimLostError('evt-1');
      });
      expect(onLeaseLost).toHaveBeenCalledWith({ ...ENTRY, stage: 'failed' });

      const boom = new Error('db down');
      await expect(
        manager.settle(ENTRY, 'done', async () => {
          throw boom;
        }),
      ).rejects.toBe(boom);
    });
  });

  describe('aggregate blocking', () => {
    const X1 = { id: 'x1', eventType: 't', aggregateId: 'X' };
    const X2 = { id: 'x2', eventType: 't', aggregateId: 'X' };
    const N1 = { id: 'n1', eventType: 't' };

    it('refuses later entries of an aggregate once one fails', async () => {
      const manager = makeManager();
      manager.begin([X1, X2, N1]);
      await manager.acquire(X1);
      await manager.settle(X1, 'failed', async () => {});
      expect(await manager.acquire(X2)).toBe(false);
      expect(await manager.acquire(N1)).toBe(true);
      manager.end();
    });

    it('refuses later entries of an aggregate once its claim is lost on completion', async () => {
      const manager = makeManager();
      manager.begin([X1, X2]);
      await manager.acquire(X1);
      await manager.settle(X1, 'done', async () => {
        throw new ClaimLostError('x1');
      });
      expect(await manager.acquire(X2)).toBe(false);
      manager.end();
    });

    it('keeps an aggregate open after a lost renewal even if completion succeeds', async () => {
      const manager = makeManager();
      manager.begin([X1, X2]);
      await manager.acquire(X1);
      manager.reportLost(X1, 'renew');
      await manager.settle(X1, 'done', async () => {});
      expect(await manager.acquire(X2)).toBe(false);
      manager.end();
    });

    it('lets the next entry of an aggregate through once the previous one is done', async () => {
      const manager = makeManager();
      manager.begin([X1, X2]);
      await manager.acquire(X1);
      await manager.settle(X1, 'done', async () => {});
      expect(await manager.acquire(X2)).toBe(true);
      manager.end();
    });

    it('clears blocked aggregates for the next batch', async () => {
      const manager = makeManager();
      manager.begin([X1]);
      await manager.acquire(X1);
      await manager.settle(X1, 'failed', async () => {});
      manager.begin([X2]);
      expect(await manager.acquire(X2)).toBe(true);
      manager.end();
    });
  });

  describe('reportLost', () => {
    it('reports each entry once per batch', () => {
      const onLeaseLost = vi.fn();
      const manager = makeManager({ onLeaseLost });
      manager.reportLost(ENTRY, 'renew');
      manager.reportLost(ENTRY, 'done');
      expect(onLeaseLost).toHaveBeenCalledTimes(1);

      manager.begin([ENTRY]);
      manager.reportLost(ENTRY, 'done');
      expect(onLeaseLost).toHaveBeenCalledTimes(2);
      manager.end();
    });

    it('contains a throwing hook', () => {
      const error = vi.spyOn(logger, 'error');
      const manager = makeManager({
        onLeaseLost: () => {
          throw new Error('hook bug');
        },
      });
      expect(() => manager.reportLost(ENTRY, 'done')).not.toThrow();
      expect(error).toHaveBeenCalledWith('onLeaseLost hook threw', expect.any(Error));
    });
  });
});
