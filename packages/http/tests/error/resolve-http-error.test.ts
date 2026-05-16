import {
  ConflictError,
  ExternalError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '@quilla-be-kit/errors';
import { describe, expect, it } from 'vitest';
import { resolveHttpError } from '../../src/error/resolve-http-error.js';

describe('resolveHttpError', () => {
  it.each([
    [new ValidationError({ message: 'invalid' }), 400],
    [new UnauthorizedError({ message: 'unauth' }), 401],
    [new ForbiddenError({ message: 'forbidden' }), 403],
    [new NotFoundError({ message: 'not found' }), 404],
    [new ConflictError({ message: 'conflict' }), 409],
    [new ExternalError({ message: 'bad gateway' }), 502],
    [new InternalError({ message: 'internal' }), 500],
  ])('%o → %i', (err, expectedCode) => {
    const result = resolveHttpError(err);
    expect(result.httpCode).toBe(expectedCode);
    expect(result.body.error?.name).toBe(err.name);
    expect(result.body.error?.message).toBe(err.message);
  });

  it('includes context as details when present', () => {
    const err = new ValidationError({
      message: 'fail',
      context: { issues: [{ path: 'email', message: 'required' }] },
    });
    const result = resolveHttpError(err);
    expect(result.body.error?.details).toEqual({
      issues: [{ path: 'email', message: 'required' }],
    });
  });

  it('falls back to 500 with generic body for non-QuillaError values', () => {
    const result = resolveHttpError(new Error('boom'));
    expect(result.httpCode).toBe(500);
    expect(result.body.error?.name).toBe('InternalError');
    expect(result.body.error?.message).toBe('Internal server error');
  });

  it('handles thrown primitives without crashing', () => {
    const result = resolveHttpError('string thrown');
    expect(result.httpCode).toBe(500);
    expect(result.body.error?.name).toBe('InternalError');
  });
});
