import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaimLeaseManager,
  type ClaimLeaseManagerOptions,
} from '../../src/event-bus/claim-lease.manager.js';
import { ClaimLostError } from '../../src/event-bus/claim-lost.error.js';
import { FakeLease } from '../helpers/fake-lease.js';

const ENTRY = { id: 'evt-1', eventType: 'test.happened' };
const EVT2 = { id: 'evt-2', eventType: 'test.happened' };
const EVT3 = { id: 'evt-3', eventType: 'test.happened' };

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
      await vi.advanceTimersByTimeAsync(10_000);

      expect(await manager.acquire(ENTRY)).toBe(true);
      expect(lease.renewCalls).toHaveLength(0);
      await manager.finish();
    });

    // Only reachable when the lease can't release: otherwise the first tick hands the entry back.
    it('renews a stale claim and refuses it silently when no longer held', async () => {
      lease = new FakeLease(60_000, { release: false });
      const onLeaseLost = vi.fn();
      const manager = makeManager({ onLeaseLost });
      manager.begin([ENTRY]);
      lease.lost.add('evt-1');
      await vi.advanceTimersByTimeAsync(20_001);

      expect(await manager.acquire(ENTRY)).toBe(false);
      expect(lease.renewCalls).toEqual([
        { instanceId: 'replica-1', ids: ['evt-1'] },
        { instanceId: 'replica-1', ids: ['evt-1'] },
      ]);
      expect(onLeaseLost).not.toHaveBeenCalled();
      await manager.finish();
    });

    it('fails open when the renew query errors', async () => {
      lease = new FakeLease(60_000, { release: false });
      const error = vi.spyOn(logger, 'error');
      const manager = makeManager();
      manager.begin([ENTRY]);
      lease.renewError = new Error('db down');
      await vi.advanceTimersByTimeAsync(20_001);

      expect(await manager.acquire(ENTRY)).toBe(true);
      expect(error).toHaveBeenCalledWith(
        'lease renewal failed',
        lease.renewError,
        expect.anything(),
      );
      await manager.finish();
    });

    it('never queries when no lease is configured', async () => {
      const manager = makeManager({ lease: undefined });
      manager.begin([ENTRY]);
      expect(await manager.acquire(ENTRY)).toBe(true);
      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.renewCalls).toHaveLength(0);
      await manager.finish();
    });
  });

  describe('renewal timer', () => {
    it('renews only the held entry', async () => {
      const manager = makeManager();
      manager.begin([ENTRY, EVT2]);
      await manager.acquire(ENTRY);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(lease.renewCalls).toHaveLength(0);

      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(lease.renewCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-1'] }]);
      await manager.finish();
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
      await manager.finish();
    });

    it('keeps renewing after a failed renew query', async () => {
      lease.renewError = new Error('db down');
      const manager = makeManager();
      manager.begin([ENTRY]);
      manager.hold(ENTRY);

      await vi.advanceTimersByTimeAsync(40_000);
      expect(lease.renewCalls).toHaveLength(2);
      await manager.finish();
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
      await manager.finish();
    });

    it('does not start a timer for an empty batch', async () => {
      const manager = makeManager();
      manager.begin([]);
      expect(vi.getTimerCount()).toBe(0);
      await manager.finish();
    });

    it('end() stops the timer', async () => {
      const manager = makeManager();
      manager.begin([ENTRY]);
      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(20_000);
      await manager.finish();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.renewCalls).toHaveLength(1);
    });
  });

  describe('hand-back', () => {
    it('hands back unstarted entries once on the first tick and refuses them silently', async () => {
      const onLeaseLost = vi.fn();
      const manager = makeManager({ onLeaseLost });
      manager.begin([ENTRY, EVT2, EVT3]);
      await manager.acquire(ENTRY);
      manager.hold(ENTRY);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-2', 'evt-3'] }]);
      expect(lease.renewCalls).toHaveLength(3);
      expect(lease.renewCalls.every((call) => call.ids.join() === 'evt-1')).toBe(true);

      await manager.settle(ENTRY, 'done', async () => {});
      expect(await manager.acquire(EVT2)).toBe(false);
      await manager.finish();
      expect(lease.releaseCalls).toHaveLength(1);
      expect(onLeaseLost).not.toHaveBeenCalled();
    });

    it('drops entries the lease no longer holds without reporting them', async () => {
      const onLeaseLost = vi.fn();
      lease.lost.add('evt-2');
      const manager = makeManager({ onLeaseLost });
      manager.begin([ENTRY, EVT2]);
      await vi.advanceTimersByTimeAsync(20_000);

      expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-1', 'evt-2'] }]);
      expect(await manager.acquire(EVT2)).toBe(false);
      expect(onLeaseLost).not.toHaveBeenCalled();
      await manager.finish();
    });

    it('hands back on a tick where nothing is held', async () => {
      const manager = makeManager();
      manager.begin([ENTRY, EVT2]);
      await manager.acquire(ENTRY);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-2'] }]);
      await manager.finish();
    });

    it('does not hand back an entry whose acquire is awaiting a renew when the tick fires', async () => {
      lease = new FakeLease(60_000);
      const { promise: pending, resolve: unblock } = Promise.withResolvers<void>();
      vi.spyOn(lease, 'renew').mockImplementation(async (_id, ids) => {
        await pending;
        return ids;
      });
      // Interval 10 s: a 15 s-old confirmation is stale, the tick lands at 20 s.
      const manager = makeManager({ renewIntervalMs: 10_000 });
      manager.begin([ENTRY, EVT2]);
      await vi.advanceTimersByTimeAsync(9_999);
      vi.setSystemTime(Date.now() + 5_000);
      const acquired = manager.acquire(ENTRY);
      await vi.advanceTimersByTimeAsync(1);
      unblock();

      expect(await acquired).toBe(true);
      expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-2'] }]);
      await manager.finish();
    });

    it('logs a failed hand-back and keeps going', async () => {
      const error = vi.spyOn(logger, 'error');
      lease.releaseError = new Error('db down');
      const manager = makeManager();
      manager.begin([ENTRY, EVT2]);
      await manager.acquire(ENTRY);
      manager.hold(ENTRY);
      await vi.advanceTimersByTimeAsync(40_000);

      expect(error).toHaveBeenCalledWith(
        'handing back unstarted claims failed',
        lease.releaseError,
        { meta: { count: 1 } },
      );
      expect(lease.renewCalls).toHaveLength(2);
      await manager.finish();
    });

    it('finish() hands back entries never started, not a started unsettled one', async () => {
      const X1 = { id: 'x1', eventType: 't', aggregateId: 'X' };
      const X2 = { id: 'x2', eventType: 't', aggregateId: 'X' };
      const P1 = { id: 'p1', eventType: 't' };
      const manager = makeManager();
      manager.begin([X1, X2, P1, EVT3]);
      await manager.acquire(X1);
      await manager.settle(X1, 'failed', async () => {});
      expect(await manager.acquire(X2)).toBe(false);
      expect(await manager.acquire(P1)).toBe(true);

      await manager.finish();
      expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['x2', 'evt-3'] }]);
    });

    it('finish() hands back with renewal disabled', async () => {
      const manager = makeManager({ renewIntervalMs: 0 });
      manager.begin([ENTRY, EVT2]);
      await manager.acquire(ENTRY);
      await manager.finish();
      expect(lease.releaseCalls).toEqual([{ instanceId: 'replica-1', ids: ['evt-2'] }]);
      expect(lease.renewCalls).toHaveLength(0);
    });

    it('finish() does nothing when the lease cannot release', async () => {
      lease = new FakeLease(60_000, { release: false });
      const manager = makeManager();
      manager.begin([ENTRY, EVT2]);
      await manager.finish();
      expect(lease.renewCalls).toHaveLength(0);
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
      await manager.finish();
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
      await manager.finish();
    });

    it('refuses later entries of an aggregate once its claim is lost on completion', async () => {
      const manager = makeManager();
      manager.begin([X1, X2]);
      await manager.acquire(X1);
      await manager.settle(X1, 'done', async () => {
        throw new ClaimLostError('x1');
      });
      expect(await manager.acquire(X2)).toBe(false);
      await manager.finish();
    });

    it('keeps an aggregate open after a lost renewal even if completion succeeds', async () => {
      const manager = makeManager();
      manager.begin([X1, X2]);
      await manager.acquire(X1);
      manager.reportLost(X1, 'renew');
      await manager.settle(X1, 'done', async () => {});
      expect(await manager.acquire(X2)).toBe(false);
      await manager.finish();
    });

    it('lets the next entry of an aggregate through once the previous one is done', async () => {
      const manager = makeManager();
      manager.begin([X1, X2]);
      await manager.acquire(X1);
      await manager.settle(X1, 'done', async () => {});
      expect(await manager.acquire(X2)).toBe(true);
      await manager.finish();
    });

    it('clears blocked aggregates for the next batch', async () => {
      const manager = makeManager();
      manager.begin([X1]);
      await manager.acquire(X1);
      await manager.settle(X1, 'failed', async () => {});
      manager.begin([X2]);
      expect(await manager.acquire(X2)).toBe(true);
      await manager.finish();
    });
  });

  describe('reportLost', () => {
    it('reports each entry once per batch', async () => {
      const onLeaseLost = vi.fn();
      const manager = makeManager({ onLeaseLost });
      manager.reportLost(ENTRY, 'renew');
      manager.reportLost(ENTRY, 'done');
      expect(onLeaseLost).toHaveBeenCalledTimes(1);

      manager.begin([ENTRY]);
      manager.reportLost(ENTRY, 'done');
      expect(onLeaseLost).toHaveBeenCalledTimes(2);
      await manager.finish();
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

    it('logs the entry under the identity logIds gives, and the hook still gets its own id', () => {
      const warn = vi.spyOn(logger, 'warn');
      const onLeaseLost = vi.fn();
      const manager = makeManager({
        onLeaseLost,
        logIds: (entry) => ({ eventId: 'evt-9', deliveryId: entry.id }),
      });
      manager.reportLost(ENTRY, 'renew');
      expect(warn).toHaveBeenCalledWith('claim lease lost; event may run more than once', {
        meta: { eventId: 'evt-9', deliveryId: 'evt-1', eventType: 'test.happened', stage: 'renew' },
      });
      expect(onLeaseLost).toHaveBeenCalledWith({
        id: 'evt-1',
        eventType: 'test.happened',
        stage: 'renew',
      });
    });
  });

  describe('orderKey', () => {
    it('blocks entries that share an order key, whatever their aggregate', async () => {
      type Laned = { id: string; eventType: string; lane: string };
      const manager = new ClaimLeaseManager<Laned>({
        lease,
        instanceId: 'replica-1',
        renewIntervalMs: 20_000,
        logger,
        onLeaseLost: undefined,
        orderKey: (entry) => entry.lane,
      });
      const first = { id: 'd-1', eventType: 't', lane: 'mail\0agg-1' };
      const second = { id: 'd-2', eventType: 't', lane: 'mail\0agg-1' };
      const other = { id: 'd-3', eventType: 't', lane: 'audit\0agg-1' };
      manager.begin([first, second, other]);

      expect(await manager.acquire(first)).toBe(true);
      expect(await manager.acquire(second)).toBe(false);
      expect(await manager.acquire(other)).toBe(true);
      await manager.finish();
    });
  });
});
