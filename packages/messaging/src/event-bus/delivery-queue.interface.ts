import type { ClaimLease } from './claim-lease.type.js';
import type { ClaimOptions } from './claim-options.type.js';
import type {
  DeliveryBacklog,
  DeliveryEntry,
  DeliveryLane,
  DeliveryMove,
  DeliveryPair,
  NewDelivery,
  RekeyResult,
} from './delivery-entry.type.js';
import type { MarkFailedOptions } from './mark-failed-options.type.js';

/**
 * Per-subscriber deliveries, for consumers with `isolation`. A lane is one subscriber's work on
 * one aggregate (`consumerName`, `aggregateId`, `handlerKey`). A lane is blocked while it holds
 * a PENDING or CLAIMED delivery, or a FAILED one that holds it; its deliveries run one at a time
 * in queue order, and never while an event of that aggregate the subscriber handles is claimed
 * on the bus. Deliveries of one event never wait for each other. Deliveries without an aggregate
 * have no lane.
 */
export interface DeliveryQueue {
  /**
   * Removes the claimed event and queues `deliveries` (copies of the event, with its sequence)
   * in one step. With `instanceId` held by another instance, throws ClaimLostError and writes
   * nothing.
   */
  settle(
    eventId: string,
    consumerName: string,
    deliveries: readonly NewDelivery[],
    instanceId: string,
  ): Promise<readonly DeliveryEntry[]>;
  /** Blocked lanes of these aggregates. */
  openLanes(
    consumerName: string,
    aggregateIds: readonly string[],
  ): Promise<readonly DeliveryLane[]>;
  /** Claims due deliveries whose `(handlerKey, member)` is one of `pairs`. */
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
  /** Dead-letters at once; `holdLane` keeps the lane blocked (ignored without an aggregate). */
  markFailedPermanently(
    id: string,
    reason: string,
    instanceId?: string,
    options?: { readonly holdLane?: boolean },
  ): Promise<DeliveryEntry | undefined>;
  /**
   * Moves work in every status from each move's `from` to its `to`, atomically and safely when
   * several instances run it at once. Per event and target one row wins; the rest are
   * dead-lettered.
   */
  rekey(consumerName: string, moves: readonly DeliveryMove[]): Promise<RekeyResult>;
  /** Undrained work of `consumerName`, per subscriber member. */
  backlog(consumerName: string): Promise<readonly DeliveryBacklog[]>;
  resetStale(olderThan: Date): Promise<number>;
  readonly lease?: ClaimLease;
}
