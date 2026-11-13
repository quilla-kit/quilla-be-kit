import type { ClaimLease } from './claim-lease.type.js';
import type { ClaimOptions } from './claim-options.type.js';
import type {
  DeliveryEntry,
  DeliveryLane,
  DeliveryPair,
  NewDelivery,
} from './delivery-entry.type.js';
import type { MarkFailedOptions } from './mark-failed-options.type.js';

/**
 * Per-subscriber deliveries, for consumers with `isolation`. A lane is one subscriber's work on
 * one aggregate (`consumerName`, `aggregateId`, `handlerKey`): its deliveries run one at a time in
 * queue order, and never while an event of that aggregate the subscriber handles is claimed on
 * the bus. Deliveries without an aggregate have no lane.
 */
export interface DeliveryQueue {
  /**
   * Removes the claimed event and queues `deliveries` (copies of the event) in one step.
   * With `instanceId` held by another instance, throws ClaimLostError and writes nothing.
   */
  settle(
    eventId: string,
    consumerName: string,
    deliveries: readonly NewDelivery[],
    instanceId: string,
  ): Promise<readonly DeliveryEntry[]>;
  /** Lanes of these aggregates holding a PENDING or CLAIMED delivery. */
  openLanes(
    consumerName: string,
    aggregateIds: readonly string[],
  ): Promise<readonly DeliveryLane[]>;
  /** Claims due deliveries whose `(handlerKey, eventType)` is one of `pairs`. */
  claim(
    instanceId: string,
    batchSize: number,
    consumerName: string,
    pairs: readonly DeliveryPair[],
    options?: ClaimOptions,
  ): Promise<readonly DeliveryEntry[]>;
  markDone(id: string, instanceId?: string): Promise<void>;
  /**
   * Schedules a retry `retryAfterMs` from now. The consumer applies the subscriber's budget and
   * dead-letters with `markFailedPermanently`.
   */
  markFailed(
    id: string,
    reason: string,
    instanceId?: string,
    options?: MarkFailedOptions,
  ): Promise<DeliveryEntry | undefined>;
  markFailedPermanently(
    id: string,
    reason: string,
    instanceId?: string,
  ): Promise<DeliveryEntry | undefined>;
  /** Moves deliveries queued under `from` keys to `to`; resolves to the count moved. */
  rekey(consumerName: string, from: readonly string[], to: string): Promise<number>;
  /** Counts PENDING or CLAIMED deliveries of `consumerName` that none of `pairs` covers. */
  countOrphans(consumerName: string, pairs: readonly DeliveryPair[]): Promise<number>;
  resetStale(olderThan: Date): Promise<number>;
  readonly lease?: ClaimLease;
}
