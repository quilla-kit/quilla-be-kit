import { describe, expect, it } from 'vitest';
import { nextAttemptAt } from '../../src/event-bus/retry.policy.js';

const QUEUED = new Date('2026-01-01T00:00:00Z');
const at = (ms: number) => new Date(QUEUED.getTime() + ms);

describe('nextAttemptAt', () => {
  const schedule = { delaysMs: [1000, 5000], maxAttempts: 4, maxAgeMs: undefined };

  it('waits the n-th delay, the last one repeating', () => {
    expect(nextAttemptAt(schedule, 0, QUEUED, at(0))).toEqual(at(1000));
    expect(nextAttemptAt(schedule, 1, QUEUED, at(0))).toEqual(at(5000));
    expect(nextAttemptAt(schedule, 2, QUEUED, at(0))).toEqual(at(5000));
  });

  it('stops once the attempts are spent', () => {
    expect(nextAttemptAt(schedule, 3, QUEUED, at(0))).toBeUndefined();
    expect(nextAttemptAt({ ...schedule, maxAttempts: 1 }, 0, QUEUED, at(0))).toBeUndefined();
  });

  it('never stops on attempts with an unbounded budget', () => {
    const unbounded = { ...schedule, maxAttempts: Number.POSITIVE_INFINITY };
    expect(nextAttemptAt(unbounded, 10_000, QUEUED, at(0))).toEqual(at(5000));
  });

  it('moves the last retry up to the deadline and stops at it', () => {
    const aged = {
      delaysMs: [3_600_000],
      maxAttempts: Number.POSITIVE_INFINITY,
      maxAgeMs: 86_400_000,
    };
    expect(nextAttemptAt(aged, 5, QUEUED, at(86_000_000))).toEqual(at(86_400_000));
    expect(nextAttemptAt(aged, 6, QUEUED, at(86_400_000))).toBeUndefined();
  });

  it('dead-letters at once with a zero age', () => {
    expect(nextAttemptAt({ ...schedule, maxAgeMs: 0 }, 0, QUEUED, at(0))).toBeUndefined();
  });

  it('counts a negative delay as none', () => {
    expect(nextAttemptAt({ ...schedule, delaysMs: [-5] }, 0, QUEUED, at(0))).toEqual(at(0));
  });
});
