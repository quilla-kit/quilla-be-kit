import type { LocalOutboxEntry } from './local-outbox-entry.type.js';

export interface LocalOutboxReader {
  claim(instanceId: string, batchSize: number): Promise<readonly LocalOutboxEntry[]>;
  markSent(id: string, publishedAt: Date): Promise<void>;
  markFailed(id: string, reason: string): Promise<void>;
  resetStale(olderThan: Date): Promise<number>;
}
