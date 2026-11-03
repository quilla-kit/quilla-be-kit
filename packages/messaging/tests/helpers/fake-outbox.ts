import { ClaimLostError, type LocalOutboxEntry, type LocalOutboxReader } from '../../src/index.js';
import { type FakeLease, failedCopy } from './fake-lease.js';

export class FakeLocalOutboxReader implements LocalOutboxReader {
  readonly claimed: { instanceId: string; batchSize: number }[] = [];
  readonly markedSent: { id: string; publishedAt: Date }[] = [];
  readonly markedFailed: { id: string; error: string }[] = [];
  readonly markInstanceIds: (string | undefined)[] = [];
  readonly claimLost = new Set<string>();
  lease?: FakeLease;
  failedStatus: 'PENDING' | 'FAILED' = 'PENDING';
  private batches: LocalOutboxEntry[][] = [];
  private readonly entries = new Map<string, LocalOutboxEntry>();

  enqueueBatch(entries: readonly LocalOutboxEntry[]): void {
    for (const entry of entries) this.entries.set(entry.id, entry);
    this.batches.push([...entries]);
  }

  async claim(instanceId: string, batchSize: number): Promise<readonly LocalOutboxEntry[]> {
    this.claimed.push({ instanceId, batchSize });
    return this.batches.shift() ?? [];
  }

  async markSent(id: string, publishedAt: Date, instanceId?: string): Promise<void> {
    this.markInstanceIds.push(instanceId);
    if (this.claimLost.has(id)) throw new ClaimLostError(id);
    this.markedSent.push({ id, publishedAt });
  }

  async markFailed(
    id: string,
    error: string,
    instanceId?: string,
  ): Promise<LocalOutboxEntry | undefined> {
    this.markInstanceIds.push(instanceId);
    if (this.claimLost.has(id)) throw new ClaimLostError(id);
    this.markedFailed.push({ id, error });
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    return failedCopy(entry, error, this.failedStatus);
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
    occurredAt: new Date('2025-12-31T23:59:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}
