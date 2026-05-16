import { NoopLogger } from '@quilla-be-kit/observability';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxForwarder } from '../../src/local-outbox/outbox.forwarder.js';
import { FakeEventBusPublisher } from '../helpers/fake-bus.js';
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
    expect(publisher.published[0]?.id).toBe('e1');
    expect(publisher.published[0]?.sourceService).toBe('svc-a');
    expect(reader.markedSent.map((m) => m.id)).toEqual(['e1', 'e2']);
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
});
