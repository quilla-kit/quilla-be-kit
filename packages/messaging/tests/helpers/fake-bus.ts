import { randomUUID } from 'node:crypto';
import {
  ClaimLostError,
  type ClaimOptions,
  type EventBusConsumer,
  type EventBusEntry,
  type EventBusPublisher,
  type MarkFailedOptions,
} from '../../src/index.js';
import type { FakeDeliveryQueue } from './fake-deliveries.js';
import { type FakeLease, failedCopy } from './fake-lease.js';

export class FakeEventBusPublisher implements EventBusPublisher {
  readonly published: { id: string; event: Parameters<EventBusPublisher['publish']>[0] }[] = [];
  publishError: Error | null = null;
  private readonly byOriginEventId = new Map<string, string>();

  async publish(
    event: Parameters<EventBusPublisher['publish']>[0],
  ): Promise<{ id: string; inserted: boolean }> {
    if (this.publishError) throw this.publishError;
    if (event.originEventId !== undefined) {
      const existing = this.byOriginEventId.get(event.originEventId);
      if (existing !== undefined) {
        return { id: existing, inserted: false };
      }
      const id = randomUUID();
      this.byOriginEventId.set(event.originEventId, id);
      this.published.push({ id, event });
      return { id, inserted: true };
    }
    const id = randomUUID();
    this.published.push({ id, event });
    return { id, inserted: true };
  }
}

export class FakeEventBusConsumer implements EventBusConsumer {
  readonly claimed: {
    instanceId: string;
    batchSize: number;
    allowedTopics?: readonly string[] | undefined;
    options?: ClaimOptions | undefined;
  }[] = [];
  readonly marksDone: string[] = [];
  readonly marksFailed: { id: string; reason: string }[] = [];
  readonly marksFailedPermanently: { id: string; reason: string }[] = [];
  readonly markFailedOptions: (MarkFailedOptions | undefined)[] = [];
  readonly markInstanceIds: (string | undefined)[] = [];
  readonly claimLost = new Set<string>();
  lease?: FakeLease;
  deliveries?: FakeDeliveryQueue;
  failedStatus: 'PENDING' | 'FAILED' = 'PENDING';
  private batches: EventBusEntry[][] = [];
  private readonly entries = new Map<string, EventBusEntry>();

  enqueueBatch(events: readonly EventBusEntry[]): void {
    for (const event of events) this.entries.set(event.id, event);
    this.batches.push([...events]);
  }

  async claim(
    instanceId: string,
    batchSize: number,
    allowedTopics?: readonly string[],
    options?: ClaimOptions,
  ): Promise<readonly EventBusEntry[]> {
    this.claimed.push({ instanceId, batchSize, allowedTopics, options });
    const next = this.batches.shift() ?? [];
    if (!allowedTopics || allowedTopics.length === 0) return next;
    const allowed = new Set(allowedTopics);
    return next.filter((e) => allowed.has(e.eventType));
  }

  async markDone(id: string, instanceId?: string): Promise<void> {
    this.markInstanceIds.push(instanceId);
    if (this.claimLost.has(id)) throw new ClaimLostError(id);
    this.marksDone.push(id);
  }

  async markFailed(
    id: string,
    reason: string,
    instanceId?: string,
    options?: MarkFailedOptions,
  ): Promise<EventBusEntry | undefined> {
    this.markFailedOptions.push(options);
    return this.recordFailure(this.marksFailed, this.failedStatus, id, reason, instanceId);
  }

  async markFailedPermanently(
    id: string,
    reason: string,
    instanceId?: string,
  ): Promise<EventBusEntry | undefined> {
    return this.recordFailure(this.marksFailedPermanently, 'FAILED', id, reason, instanceId);
  }

  private recordFailure(
    list: { id: string; reason: string }[],
    status: 'PENDING' | 'FAILED',
    id: string,
    reason: string,
    instanceId: string | undefined,
  ): EventBusEntry | undefined {
    this.markInstanceIds.push(instanceId);
    if (this.claimLost.has(id)) throw new ClaimLostError(id);
    list.push({ id, reason });
    const entry = this.entries.get(id);
    return entry && failedCopy(entry, reason, status);
  }

  async resetStale(_olderThan: Date): Promise<number> {
    return 0;
  }
}
