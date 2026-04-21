import type { LocalOutboxEntry, LocalOutboxReader } from '../../src/index.js';

export class FakeLocalOutboxReader implements LocalOutboxReader {
  readonly claimed: { instanceId: string; batchSize: number }[] = [];
  readonly markedSent: { id: string; publishedAt: Date }[] = [];
  readonly markedFailed: { id: string; error: string }[] = [];
  private batches: LocalOutboxEntry[][] = [];

  enqueueBatch(entries: readonly LocalOutboxEntry[]): void {
    this.batches.push([...entries]);
  }

  async claim(instanceId: string, batchSize: number): Promise<readonly LocalOutboxEntry[]> {
    this.claimed.push({ instanceId, batchSize });
    return this.batches.shift() ?? [];
  }

  async markSent(id: string, publishedAt: Date): Promise<void> {
    this.markedSent.push({ id, publishedAt });
  }

  async markFailed(id: string, error: string): Promise<void> {
    this.markedFailed.push({ id, error });
  }

  async resetStale(_olderThan: Date): Promise<number> {
    return 0;
  }
}

export function makeOutboxEntry(overrides: Partial<LocalOutboxEntry> = {}): LocalOutboxEntry {
  return {
    id: 'evt-1',
    eventType: 'test.happened',
    eventVersion: 1,
    eventKind: 'domain',
    payload: { foo: 'bar' },
    status: 'CLAIMED',
    retryCount: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}
