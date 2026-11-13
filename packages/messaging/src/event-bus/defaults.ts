export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [1000, 5000, 15000];
export const DEFAULT_POLL_INTERVAL_MS = 1000;
export const DEFAULT_BATCH_SIZE = 100;
export const DEFAULT_STALE_CLAIM_MS = 5 * 60 * 1000;
export const DEFAULT_LEASE_MS = 60 * 1000;
// The failover window, in poll intervals: other replicas get at least one full poll.
export const DEFAULT_FAILOVER_WINDOW_POLLS = 2;

// The wait before the retry that follows `retryCount` failures; the last delay repeats.
export function retryDelayFor(delaysMs: readonly number[], retryCount: number): number {
  return delaysMs[Math.min(retryCount, delaysMs.length - 1)] ?? 0;
}
