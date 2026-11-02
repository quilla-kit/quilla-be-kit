import type { ClaimLease } from './claim-lease.type.js';
import type { EventBusEntry } from './event-bus-entry.type.js';

export interface EventBusConsumer {
  claim(
    instanceId: string,
    batchSize: number,
    allowedTopics?: readonly string[],
  ): Promise<readonly EventBusEntry[]>;
  // With `instanceId`, throws ClaimLostError when the claim is held by another instance.
  markDone(id: string, instanceId?: string): Promise<void>;
  markFailed(id: string, reason: string, instanceId?: string): Promise<void>;
  // Cutoff applies to claims without a lease; leased claims expire on their own deadline.
  resetStale(olderThan: Date): Promise<number>;
  readonly lease?: ClaimLease;
}
