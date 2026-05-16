import type { EventBusEntry } from './event-bus-entry.type.js';

export interface EventBusConsumer {
  claim(instanceId: string, batchSize: number): Promise<readonly EventBusEntry[]>;
  markDone(id: string): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
  resetStale(olderThan: Date): Promise<number>;
}
