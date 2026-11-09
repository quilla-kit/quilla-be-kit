import { QuillaError } from '@quilla-be-kit/errors';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../src/execution-context.type.js';
import { MissingScopeError } from '../src/missing-scope.error.js';
import { MissingSessionError } from '../src/missing-session.error.js';
import { requireScopeId, requireSession } from '../src/require-scope-id.js';

const base = { actorType: 'job', correlationId: 'corr-1', executionAttemptId: 'a-1' } as const;

describe('requireScopeId', () => {
  it('returns the session scope or the session-less scope', () => {
    expect(requireScopeId({ ...base, scopeId: 's-1' })).toBe('s-1');
    expect(requireScopeId({ ...base, session: { scopeId: 's-2', userId: 'u' } })).toBe('s-2');
  });

  it('throws MissingScopeError (an InternalError with code MISSING_SCOPE) when there is none', () => {
    let caught: unknown;
    try {
      requireScopeId(base);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MissingScopeError);
    expect(QuillaError.is(caught) && caught.code).toBe('MISSING_SCOPE');
    expect((caught as MissingScopeError).context).toEqual({
      actorType: 'job',
      correlationId: 'corr-1',
    });
  });
});

describe('requireSession', () => {
  it('returns the session', () => {
    const session = { scopeId: 's', userId: 'u' };
    expect(requireSession({ ...base, session })).toBe(session);
  });

  it('throws MissingSessionError when there is none', () => {
    const ctx: ExecutionContext = { ...base, scopeId: 's' };
    expect(() => requireSession(ctx)).toThrow(MissingSessionError);
  });
});
