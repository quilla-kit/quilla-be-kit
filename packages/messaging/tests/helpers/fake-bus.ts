import type { EventBusConsumer, EventBusEntry, EventBusPublisher } from '../../src/index.js';

export class FakeEventBusPublisher implements EventBusPublisher {
  readonly published: Parameters<EventBusPublisher['publish']>[0][] = [];
  publishError: Error | null = null;

  async publish(event: Parameters<EventBusPublisher['publish']>[0]): Promise<void> {
    if (this.publishError) throw this.publishError;
    this.published.push(event);
  }
}

export class FakeEventBusConsumer implements EventBusConsumer {
  readonly claimed: {
    instanceId: string;
    batchSize: number;
    allowedTopics?: readonly string[] | undefined;
  }[] = [];
  readonly marksDone: string[] = [];
  readonly marksFailed: { id: string; reason: string }[] = [];
  private batches: EventBusEntry[][] = [];

  enqueueBatch(events: readonly EventBusEntry[]): void {
    this.batches.push([...events]);
  }

  async claim(
    instanceId: string,
    batchSize: number,
    allowedTopics?: readonly string[],
  ): Promise<readonly EventBusEntry[]> {
    this.claimed.push({ instanceId, batchSize, allowedTopics });
    const next = this.batches.shift() ?? [];
    if (!allowedTopics || allowedTopics.length === 0) return next;
    const allowed = new Set(allowedTopics);
    return next.filter((e) => allowed.has(e.eventType));
  }

  async markDone(id: string): Promise<void> {
    this.marksDone.push(id);
  }

  async markFailed(id: string, reason: string): Promise<void> {
    this.marksFailed.push({ id, reason });
  }

  async resetStale(_olderThan: Date): Promise<number> {
    return 0;
  }
}
