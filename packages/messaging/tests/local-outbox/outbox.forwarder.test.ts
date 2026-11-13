import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxForwarder } from '../../src/local-outbox/outbox.forwarder.js';
import { FakeEventBusPublisher } from '../helpers/fake-bus.js';
import { FakeLease } from '../helpers/fake-lease.js';
import { FakeLocalOutboxReader, makeOutboxEntry } from '../helpers/fake-outbox.js';

describe('OutboxForwarder', () => {
  let reader: FakeLocalOutboxReader;
  let publisher: FakeEventBusPublisher;

  beforeEach(() => {
    vi.useFakeTimers();
    reader = new FakeLocalOutboxReader();
    publisher = new FakeEventBusPublisher();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('claims a batch, publishes, and marks each entry as sent', async () => {
    reader.enqueueBatch([makeOutboxEntry({ id: 'e1' }), makeOutboxEntry({ id: 'e2' })]);
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      instanceId: 'replica-1',
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(reader.claimed[0]?.instanceId).toBe('replica-1');
    expect(publisher.published).toHaveLength(2);
    expect(publisher.published[0]?.event.sourceService).toBe('svc-a');
    expect(publisher.published[0]?.event.eventType).toBe('test.happened');
    expect(reader.markedSent.map((m) => m.id)).toEqual(['e1', 'e2']);
    expect(reader.markedFailed).toHaveLength(0);
  });

  it('claims with a failover window of twice the poll interval by default', async () => {
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      pollIntervalMs: 500,
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(500);
    await fwd.dispose();

    expect(reader.claimed[0]?.options).toEqual({ failoverWindowMs: 1000 });
  });

  it('hands a failure back with its retry delay, retrying at once by default', async () => {
    publisher.publish = vi.fn(async () => {
      throw new Error('broker down');
    });
    reader.enqueueBatch([makeOutboxEntry({ id: 'e1', retryCount: 0 })]);
    reader.enqueueBatch([makeOutboxEntry({ id: 'e2', retryCount: 3 })]);
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      retryDelaysMs: [100, 500],
    });
    const plain = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();
    plain.start();
    await vi.advanceTimersByTimeAsync(1000);
    await plain.dispose();

    expect(reader.markFailedOptions).toEqual([{ retryAfterMs: 100 }, { retryAfterMs: 0 }]);
  });

  it('passes failoverWindowMs through, including 0', async () => {
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      failoverWindowMs: 0,
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(reader.claimed[0]?.options).toEqual({ failoverWindowMs: 0 });
  });

  it('threads the outbox row occurredAt onto every publish', async () => {
    const occurredAt = new Date('2025-12-31T23:59:00Z');
    reader.enqueueBatch([makeOutboxEntry({ id: 'e1', occurredAt })]);
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(publisher.published[0]?.event.occurredAt).toBe(occurredAt);
  });

  it('threads the outbox row id as originEventId on every publish (publisher dedup key)', async () => {
    reader.enqueueBatch([
      makeOutboxEntry({ id: 'outbox-AAA' }),
      makeOutboxEntry({ id: 'outbox-BBB' }),
    ]);
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(publisher.published.map((p) => p.event.originEventId)).toEqual([
      'outbox-AAA',
      'outbox-BBB',
    ]);
  });

  it('still marks the outbox row as sent when the bus reports a dedup hit (inserted=false)', async () => {
    // Simulate replay: same outbox row id forwarded twice — second publish hits dedup.
    reader.enqueueBatch([makeOutboxEntry({ id: 'outbox-replay' })]);
    reader.enqueueBatch([makeOutboxEntry({ id: 'outbox-replay' })]);
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      pollIntervalMs: 1000,
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(publisher.published).toHaveLength(1); // bus only stored one row
    expect(reader.markedSent.map((m) => m.id)).toEqual(['outbox-replay', 'outbox-replay']);
    expect(reader.markedFailed).toHaveLength(0);
  });

  it('marks entry as failed when publisher throws', async () => {
    reader.enqueueBatch([makeOutboxEntry({ id: 'e1' })]);
    publisher.publishError = new Error('broker down');
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(reader.markedSent).toHaveLength(0);
    expect(reader.markedFailed).toEqual([{ id: 'e1', error: 'broker down' }]);
  });

  it('is a no-op when claim returns no entries', async () => {
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(publisher.published).toHaveLength(0);
    expect(reader.markedSent).toHaveLength(0);
    expect(reader.markedFailed).toHaveLength(0);
  });

  it('calls resetStale on every tick with the configured cutoff', async () => {
    const resetSpy = vi.spyOn(reader, 'resetStale');
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
      staleClaimAfterMs: 60_000,
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(resetSpy).toHaveBeenCalled();
    const [cutoff] = resetSpy.mock.calls[0] as [Date];
    const delta = Date.now() - cutoff.getTime();
    expect(delta).toBeGreaterThanOrEqual(60_000);
  });

  it('dispose() awaits in-flight tick (graceful drain)', async () => {
    let release: () => void = () => {};
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    reader.enqueueBatch([makeOutboxEntry({ id: 'e1' })]);
    publisher.publish = vi.fn(async () => {
      await blocker;
      return { id: 'bus-evt-1', inserted: true };
    });

    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);

    const disposePromise = fwd.dispose();
    let disposed = false;
    disposePromise.then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);

    release();
    await disposePromise;
    expect(reader.markedSent).toEqual([expect.objectContaining({ id: 'e1' })]);
  });

  describe('claim leases', () => {
    let lease: FakeLease;

    beforeEach(() => {
      lease = new FakeLease(60_000);
      reader.lease = lease;
    });

    it('renews the in-flight entry while publish is slow', async () => {
      const { promise: pending, resolve: release } = Promise.withResolvers<void>();
      const publish = publisher.publish.bind(publisher);
      vi.spyOn(publisher, 'publish').mockImplementation(async (event) => {
        await pending;
        return publish(event);
      });
      reader.enqueueBatch([makeOutboxEntry({ id: 'e1' })]);
      const fwd = new OutboxForwarder({
        reader,
        publisher,
        sourceService: 'svc-a',
        logger: new NoopLogger(),
        instanceId: 'replica-1',
      });

      fwd.start();
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(40_000);
      release();
      await fwd.dispose();

      expect(lease.renewCalls).toEqual([
        { instanceId: 'replica-1', ids: ['e1'] },
        { instanceId: 'replica-1', ids: ['e1'] },
      ]);
      expect(reader.markedSent.map((m) => m.id)).toEqual(['e1']);
      expect(reader.markInstanceIds).toEqual(['replica-1']);
    });

    it('reports ClaimLostError from markSent without marking the entry failed', async () => {
      const onLeaseLost = vi.fn();
      reader.claimLost.add('e1');
      reader.enqueueBatch([makeOutboxEntry({ id: 'e1' })]);
      const fwd = new OutboxForwarder({
        reader,
        publisher,
        sourceService: 'svc-a',
        logger: new NoopLogger(),
        onLeaseLost,
      });

      fwd.start();
      await vi.advanceTimersByTimeAsync(1000);
      await fwd.dispose();

      expect(onLeaseLost).toHaveBeenCalledWith({
        id: 'e1',
        eventType: 'test.happened',
        stage: 'done',
      });
      expect(reader.markedFailed).toHaveLength(0);
    });

    it('calls onFailed with the updated entry, and contains a throwing hook', async () => {
      const logger = new NoopLogger();
      const error = vi.spyOn(logger, 'error');
      const failed: unknown[] = [];
      publisher.publishError = new Error('bus down');
      reader.failedStatus = 'FAILED';
      reader.enqueueBatch([makeOutboxEntry({ id: 'e1' }), makeOutboxEntry({ id: 'e2' })]);
      const fwd = new OutboxForwarder({
        reader,
        publisher,
        sourceService: 'svc-a',
        logger,
        onFailed: (entry) => {
          failed.push(entry);
          throw new Error('hook bug');
        },
      });

      fwd.start();
      await vi.advanceTimersByTimeAsync(1000);
      await fwd.dispose();

      expect(failed).toEqual([
        expect.objectContaining({ id: 'e1', status: 'FAILED', lastError: 'bus down' }),
        expect.objectContaining({ id: 'e2', status: 'FAILED', lastError: 'bus down' }),
      ]);
      expect(error).toHaveBeenCalledWith('onFailed hook threw', expect.any(Error), {
        meta: { outboxId: 'e1' },
      });
    });

    it('does not call onFailed when the claim was lost', async () => {
      const onFailed = vi.fn();
      publisher.publishError = new Error('bus down');
      reader.claimLost.add('e1');
      reader.enqueueBatch([makeOutboxEntry({ id: 'e1' })]);
      const fwd = new OutboxForwarder({
        reader,
        publisher,
        sourceService: 'svc-a',
        logger: new NoopLogger(),
        onFailed,
      });

      fwd.start();
      await vi.advanceTimersByTimeAsync(1000);
      await fwd.dispose();

      expect(onFailed).not.toHaveBeenCalled();
    });

    it('renewIntervalMs: 0 disables renewal and warns at start', async () => {
      const logger = new NoopLogger();
      const warn = vi.spyOn(logger, 'warn');
      const fwd = new OutboxForwarder({
        reader,
        publisher,
        sourceService: 'svc-a',
        logger,
        renewIntervalMs: 0,
      });

      fwd.start();
      await fwd.dispose();

      expect(warn).toHaveBeenCalledWith(
        'claim renewal disabled; work longer than the lease will be re-dispatched',
        { meta: { leaseMs: 60_000 } },
      );
    });
  });

  it('skips the rest of an aggregate after one of its entries fails to publish', async () => {
    const publish = publisher.publish.bind(publisher);
    vi.spyOn(publisher, 'publish').mockImplementation(async (event) => {
      if (event.originEventId === 'x1') throw new Error('bus down');
      return publish(event);
    });
    reader.enqueueBatch([
      makeOutboxEntry({ id: 'x1', aggregateId: 'X' }),
      makeOutboxEntry({ id: 'y1', aggregateId: 'Y' }),
      makeOutboxEntry({ id: 'x2', aggregateId: 'X' }),
    ]);
    const fwd = new OutboxForwarder({
      reader,
      publisher,
      sourceService: 'svc-a',
      logger: new NoopLogger(),
    });

    fwd.start();
    await vi.advanceTimersByTimeAsync(1000);
    await fwd.dispose();

    expect(publisher.published.map((p) => p.event.originEventId)).toEqual(['y1']);
    expect(reader.markedFailed.map((m) => m.id)).toEqual(['x1']);
    expect(reader.markedSent.map((m) => m.id)).toEqual(['y1']);
  });
});
