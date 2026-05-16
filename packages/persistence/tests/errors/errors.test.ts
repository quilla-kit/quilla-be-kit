import { ConflictError, NotFoundError, QuillaError } from '@quilla-be-kit/errors';
import { describe, expect, it } from 'vitest';
import { CrossScopeAccessError } from '../../src/errors/cross-scope-access.error.js';
import { OptimisticLockError } from '../../src/errors/optimistic-lock.error.js';

describe('CrossScopeAccessError', () => {
  it('extends NotFoundError and QuillaError', () => {
    const err = new CrossScopeAccessError({
      entity: 'User',
      id: '1',
      scopeId: 's1',
    });
    expect(err instanceof NotFoundError).toBe(true);
    expect(err instanceof QuillaError).toBe(true);
  });

  it('has fixed code CROSS_SCOPE_ACCESS', () => {
    const err = new CrossScopeAccessError({
      entity: 'User',
      id: '1',
      scopeId: 's1',
    });
    expect(err.code).toBe('CROSS_SCOPE_ACCESS');
  });

  it('carries entity/id/scopeId in context', () => {
    const err = new CrossScopeAccessError({
      entity: 'User',
      id: '1',
      scopeId: 's1',
    });
    expect(err.context).toEqual({ entity: 'User', id: '1', scopeId: 's1' });
  });
});

describe('OptimisticLockError', () => {
  it('extends ConflictError and QuillaError', () => {
    const err = new OptimisticLockError({ entity: 'User', id: '1' });
    expect(err instanceof ConflictError).toBe(true);
    expect(err instanceof QuillaError).toBe(true);
  });

  it('has fixed code OPTIMISTIC_LOCK', () => {
    const err = new OptimisticLockError({ entity: 'User', id: '1' });
    expect(err.code).toBe('OPTIMISTIC_LOCK');
  });
});
