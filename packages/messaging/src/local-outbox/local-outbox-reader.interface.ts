import type { ClaimLease } from '../event-bus/claim-lease.type.js';
import type { LocalOutboxEntry } from './local-outbox-entry.type.js';

export interface LocalOutboxReader {
  claim(instanceId: string, batchSize: number): Promise<readonly LocalOutboxEntry[]>;
  // With `instanceId`, throws ClaimLostError when the claim is held by another instance.
  markSent(id: string, publishedAt: Date, instanceId?: string): Promise<void>;
  markFailed(id: string, reason: string, instanceId?: string): Promise<void>;
  // Cutoff applies to claims without a lease; leased claims expire on their own deadline.
  resetStale(olderThan: Date): Promise<number>;
  readonly lease?: ClaimLease;
}
