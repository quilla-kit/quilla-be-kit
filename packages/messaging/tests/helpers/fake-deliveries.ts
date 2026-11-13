import { randomUUID } from 'node:crypto';
import {
  ClaimLostError,
  type ClaimOptions,
  type DeliveryBacklog,
  type DeliveryEntry,
  type DeliveryLane,
  type DeliveryMove,
  type DeliveryPair,
  type DeliveryQueue,
  type MarkFailedOptions,
  type NewDelivery,
  type RekeyResult,
} from '../../src/index.js';
import { type FakeLease, failedCopy } from './fake-lease.js';

export class FakeDeliveryQueue implements DeliveryQueue {
  readonly settled: { eventId: string; consumerName: string; deliveries: NewDelivery[] }[] = [];
  readonly claims: { batchSize: number; consumerName: string; pairs: DeliveryPair[] }[] = [];
  readonly marksDone: string[] = [];
  readonly marksFailed: { id: string; reason: string; options: MarkFailedOptions | undefined }[] =
    [];
  readonly marksFailedPermanently: { id: string; reason: string; holdLane: boolean }[] = [];
  readonly rekeys: { consumerName: string; moves: DeliveryMove[] }[] = [];
  readonly claimLost = new Set<string>();
  lanes: DeliveryLane[] = [];
  lanesError: Error | null = null;
  backlogRows: DeliveryBacklog[] = [];
  rekeyErrors = 0;
  failedStatus: 'PENDING' | 'FAILED' = 'PENDING';
  lease?: FakeLease;
  private batches: DeliveryEntry[][] = [];
  private readonly entries = new Map<string, DeliveryEntry>();

  enqueueBatch(deliveries: readonly DeliveryEntry[]): void {
    for (const d of deliveries) this.entries.set(d.id, d);
    this.batches.push([...deliveries]);
  }

  async settle(
    eventId: string,
    consumerName: string,
    deliveries: readonly NewDelivery[],
    _instanceId: string,
  ): Promise<readonly DeliveryEntry[]> {
    if (this.claimLost.has(eventId)) throw new ClaimLostError(eventId);
    this.settled.push({ eventId, consumerName, deliveries: [...deliveries] });
    return deliveries.map(({ holdsLane, ...d }) =>
      makeDelivery({ ...d, eventId, consumerName, holdsLane: holdsLane === true }),
    );
  }

  async openLanes(): Promise<readonly DeliveryLane[]> {
    if (this.lanesError) throw this.lanesError;
    return this.lanes;
  }

  async claim(
    _instanceId: string,
    batchSize: number,
    consumerName: string,
    pairs: readonly DeliveryPair[],
    _options?: ClaimOptions,
  ): Promise<readonly DeliveryEntry[]> {
    this.claims.push({ batchSize, consumerName, pairs: [...pairs] });
    return this.batches.shift() ?? [];
  }

  async markDone(id: string): Promise<void> {
    if (this.claimLost.has(id)) throw new ClaimLostError(id);
    this.marksDone.push(id);
  }

  async markFailed(
    id: string,
    reason: string,
    _instanceId?: string,
    options?: MarkFailedOptions,
  ): Promise<DeliveryEntry | undefined> {
    if (this.claimLost.has(id)) throw new ClaimLostError(id);
    this.marksFailed.push({ id, reason, options });
    const entry = this.entries.get(id);
    return entry && failedCopy(entry, reason, this.failedStatus);
  }

  async markFailedPermanently(
    id: string,
    reason: string,
    _instanceId?: string,
    options?: { readonly holdLane?: boolean },
  ): Promise<DeliveryEntry | undefined> {
    const holdLane = options?.holdLane ?? false;
    this.marksFailedPermanently.push({ id, reason, holdLane });
    const entry = this.entries.get(id);
    return entry && { ...failedCopy(entry, reason, 'FAILED'), holdsLane: holdLane };
  }

  async rekey(consumerName: string, moves: readonly DeliveryMove[]): Promise<RekeyResult> {
    this.rekeys.push({ consumerName, moves: [...moves] });
    if (this.rekeyErrors > 0) {
      this.rekeyErrors--;
      throw new Error('db down');
    }
    return { moved: 0, superseded: 0 };
  }

  async backlog(): Promise<readonly DeliveryBacklog[]> {
    return this.backlogRows;
  }

  async resetStale(): Promise<number> {
    return 0;
  }
}

export function makeDelivery(
  overrides: Partial<DeliveryEntry> & { readonly handlerKey: string },
): DeliveryEntry {
  return {
    member: overrides.eventType ?? 'test.happened',
    holdsLane: false,
    id: randomUUID(),
    eventId: 'evt-1',
    consumerName: 'test',
    eventType: 'test.happened',
    eventVersion: 1,
    eventKind: 'domain',
    payload: { foo: 'bar' },
    sourceService: 'svc-a',
    occurredAt: new Date('2025-12-31T23:59:00Z'),
    status: 'CLAIMED',
    retryCount: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    publishedAt: new Date('2026-01-01T00:00:01Z'),
    queuedAt: new Date('2026-01-01T00:00:02Z'),
    ...overrides,
  };
}
