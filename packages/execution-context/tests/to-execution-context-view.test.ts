import { describe, expect, it } from 'vitest';
import { toExecutionContextView } from '../src/to-execution-context-view.js';

const base = { actorType: 'user', correlationId: 'c', executionAttemptId: 'a' } as const;

describe('toExecutionContextView', () => {
  it('resolves the scope and user from an authenticated session', () => {
    const session = { scopeId: 'tenant-1', userId: 'u-1' };
    expect(toExecutionContextView({ ...base, session, crossedFrom: 'platform' })).toEqual({
      ...base,
      scopeId: 'tenant-1',
      userId: 'u-1',
      session,
      crossedFrom: 'platform',
    });
  });

  it('resolves a session-less scope and leaves the user absent', () => {
    expect(toExecutionContextView({ ...base, scopeId: 's-1' })).toEqual({
      ...base,
      scopeId: 's-1',
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(toExecutionContextView(base))).toBe(true);
  });
});
