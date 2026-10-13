import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '../src/execution-context.type.js';
import { resolveScopeId } from '../src/resolve-scope-id.js';

const base = {
  actorType: 'job',
  correlationId: 'corr-1',
  executionAttemptId: 'attempt-1',
} as const;

describe('resolveScopeId', () => {
  it('returns the session scope when authenticated', () => {
    expect(resolveScopeId({ ...base, session: { scopeId: 's-1', userId: 'u-1' } })).toBe('s-1');
  });

  it('falls back to the session-less scopeId', () => {
    expect(resolveScopeId({ ...base, scopeId: 's-2' })).toBe('s-2');
  });

  it('returns undefined when the context has no scope', () => {
    expect(resolveScopeId(base)).toBeUndefined();
  });

  it('throws when a session and a session-less scopeId are both set', () => {
    const ctx: ExecutionContext = {
      ...base,
      session: { scopeId: 's-1', userId: 'u-1' },
      scopeId: 's-2',
    };
    expect(() => resolveScopeId(ctx)).toThrow(/both session scope "s-1" and scopeId "s-2"/);
  });
});
