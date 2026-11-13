import { retryDelayFor } from './defaults.js';

/**
 * How a subscriber's failed work is retried under isolation. Whichever budget runs out first
 * dead-letters the delivery.
 */
export type RetryPolicy = {
  /** Wait before each retry: the n-th retry waits `delaysMs[n - 1]`, the last value repeating. */
  readonly delaysMs?: readonly number[];
  /** Attempts before dead-lettering, the first one included. `Infinity` for no cap. */
  readonly maxAttempts?: number;
  /**
   * How long a delivery may keep retrying, from when it was queued. The last retry is moved up
   * to the deadline, so one attempt always runs at it.
   */
  readonly maxAgeMs?: number;
};

export type RetrySchedule = {
  readonly delaysMs: readonly number[];
  readonly maxAttempts: number;
  readonly maxAgeMs: number | undefined;
};

// When the retry after a failed attempt is due, or undefined once a budget is spent.
// `retryCount` counts the failures before this one.
export function nextAttemptAt(
  schedule: RetrySchedule,
  retryCount: number,
  queuedAt: Date,
  now: Date,
): Date | undefined {
  const deadline =
    schedule.maxAgeMs === undefined
      ? Number.POSITIVE_INFINITY
      : queuedAt.getTime() + schedule.maxAgeMs;
  if (retryCount + 1 >= schedule.maxAttempts || now.getTime() >= deadline) return undefined;
  const delay = Math.max(0, retryDelayFor(schedule.delaysMs, retryCount));
  return new Date(Math.min(now.getTime() + delay, deadline));
}
