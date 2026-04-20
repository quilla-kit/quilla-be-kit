import { describe, expect, it } from 'vitest';
import { ConflictError } from '../src/conflict.error.js';
import { NotFoundError } from '../src/not-found.error.js';
import { QuillaError } from '../src/quilla.error.js';

class CrossScopeAccessError extends NotFoundError {
  override readonly code = 'CROSS_SCOPE_ACCESS';
  constructor(opts: { entity: string; id: string; scopeId: string }) {
    super({
      message: `${opts.entity} with id ${opts.id} not found in scope`,
      context: opts,
    });
  }
}

describe('QuillaError', () => {
  it('is abstract — must be subclassed to instantiate', () => {
    expect(QuillaError).toBeDefined();
  });

  it('subclass sets name to constructor name', () => {
    const err = new NotFoundError({ message: 'x' });
    expect(err.name).toBe('NotFoundError');
  });

  it('subclass provides a default code', () => {
    expect(new NotFoundError({ message: 'x' }).code).toBe('NOT_FOUND');
    expect(new ConflictError({ message: 'x' }).code).toBe('CONFLICT');
  });

  it('leaf subclass overrides code', () => {
    const err = new CrossScopeAccessError({ entity: 'User', id: '1', scopeId: 's1' });
    expect(err.code).toBe('CROSS_SCOPE_ACCESS');
  });

  it('preserves message, context, and cause', () => {
    const cause = new Error('root');
    const err = new NotFoundError({
      message: 'not found',
      context: { id: 'abc' },
      cause,
    });
    expect(err.message).toBe('not found');
    expect(err.context).toEqual({ id: 'abc' });
    expect(err.cause).toBe(cause);
  });

  it('does not set context when absent (exactOptionalPropertyTypes)', () => {
    const err = new NotFoundError({ message: 'x' });
    expect('context' in err && err.context !== undefined).toBe(false);
  });

  describe('QuillaError.is', () => {
    it('returns true for instances of QuillaError subclasses', () => {
      expect(QuillaError.is(new NotFoundError({ message: 'x' }))).toBe(true);
      expect(QuillaError.is(new ConflictError({ message: 'x' }))).toBe(true);
    });

    it('returns false for native Error', () => {
      expect(QuillaError.is(new Error('x'))).toBe(false);
    });

    it('returns false for non-error values', () => {
      expect(QuillaError.is(null)).toBe(false);
      expect(QuillaError.is(undefined)).toBe(false);
      expect(QuillaError.is('string')).toBe(false);
      expect(QuillaError.is(42)).toBe(false);
      expect(QuillaError.is({})).toBe(false);
    });

    it('uses Symbol.for — cross-realm safe', () => {
      const brand = Symbol.for('quilla-kit.error');
      const impostor = { [brand]: true };
      expect(QuillaError.is(impostor)).toBe(true);
    });
  });

  describe('toJSON', () => {
    it('serializes required fields', () => {
      const err = new NotFoundError({ message: 'not found' });
      expect(err.toJSON()).toEqual({
        name: 'NotFoundError',
        code: 'NOT_FOUND',
        message: 'not found',
      });
    });

    it('includes context and cause when present', () => {
      const cause = new Error('root');
      const err = new NotFoundError({ message: 'x', context: { a: 1 }, cause });
      expect(err.toJSON()).toEqual({
        name: 'NotFoundError',
        code: 'NOT_FOUND',
        message: 'x',
        context: { a: 1 },
        cause,
      });
    });
  });

  describe('inheritance-based classification', () => {
    it('instanceof matches category', () => {
      const err = new CrossScopeAccessError({ entity: 'User', id: '1', scopeId: 's1' });
      expect(err instanceof NotFoundError).toBe(true);
      expect(err instanceof QuillaError).toBe(true);
      expect(err instanceof ConflictError).toBe(false);
    });
  });
});
