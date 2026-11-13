import type { EventBusEntry } from './event-bus-entry.type.js';
import type { RetryPolicy } from './retry.policy.js';

/** A subscriber member's durable identity: its subscriber key and member name. */
export type SubscriberIdentity = { readonly key: string; readonly member: string };

export type PermanentFailurePredicate = (
  error: unknown,
  info: { readonly entry: EventBusEntry },
) => boolean;

/**
 * Everything a subscriber decides for itself, given once per subscriber key. Two explicit,
 * different values for one key are a registration error.
 */
export type SubscriberPolicy = {
  /** Under isolation: how a member's failed work is retried. */
  readonly retry?: RetryPolicy | undefined;
  /**
   * Under isolation: what a dead letter does to its lane. `release` (default) lets later work
   * go on; `hold` keeps the lane blocked until the delivery is replayed or its hold released.
   */
  readonly deadLetter?: 'release' | 'hold' | undefined;
  /** Classifies this subscriber's errors; falls back to the consumer's. */
  readonly isPermanentFailure?: PermanentFailurePredicate | undefined;
  /** `onFailed` reports `stuck` from this many attempts on; falls back to the consumer's. */
  readonly stuckAfterAttempts?: number | undefined;
  /** Earlier keys of this subscriber: their queued work moves here, member by member. */
  readonly previousKeys?: readonly string[] | undefined;
};
