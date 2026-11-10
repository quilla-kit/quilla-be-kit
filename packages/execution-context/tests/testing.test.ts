import { describe, expect, expectTypeOf, it } from 'vitest';
import type {
  ExecutionContextView,
  ScopedExecutionContextView,
  SessionExecutionContextView,
} from '../src/execution-context-view.type.js';
import { testContextView, testExecutionContext } from '../src/testing.js';

describe('testExecutionContext', () => {
  it('defaults to a system actor with fresh ids', () => {
    const a = testExecutionContext();
    const b = testExecutionContext();
    expect(a.actorType).toBe('system');
    expect(a.correlationId).not.toBe(b.correlationId);
    expect(a.executionAttemptId).not.toBe(b.executionAttemptId);
  });

  it('applies overrides', () => {
    expect(testExecutionContext({ correlationId: 'c-1' }).correlationId).toBe('c-1');
  });
});

describe('testContextView', () => {
  it('derives scopeId and userId from a session', () => {
    const view = testContextView({ actorType: 'user', session: { scopeId: 's-1', userId: 'u-1' } });
    expectTypeOf(view).toEqualTypeOf<SessionExecutionContextView>();
    expect(view).toMatchObject({ scopeId: 's-1', userId: 'u-1', actorType: 'user' });
  });

  it('narrows a session-less scope', () => {
    const view = testContextView({ scopeId: 's-1' });
    expectTypeOf(view).toEqualTypeOf<ScopedExecutionContextView>();
    expect(view.scopeId).toBe('s-1');
    expect(view.userId).toBeUndefined();
  });

  it('returns an unscoped view by default', () => {
    expectTypeOf(testContextView()).toEqualTypeOf<ExecutionContextView>();
    expect(testContextView().scopeId).toBeUndefined();
  });

  it('rejects a session beside a session-less scope at the type level', () => {
    const both = { session: { scopeId: 's', userId: 'u' }, scopeId: 's' };
    // @ts-expect-error a context never carries both a session and a session-less scopeId
    expect(() => testContextView(both)).toThrow();
  });
});
