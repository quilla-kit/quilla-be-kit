import { describe, expect, it } from 'vitest';
import { InternalError } from '../src/internal.error.js';
import { QuillaError } from '../src/quilla.error.js';
import { UnknownError } from '../src/unknown.error.js';

describe('UnknownError', () => {
  it('extends InternalError', () => {
    expect(new UnknownError() instanceof InternalError).toBe(true);
    expect(new UnknownError() instanceof QuillaError).toBe(true);
  });

  it('has code UNKNOWN', () => {
    expect(new UnknownError().code).toBe('UNKNOWN');
  });

  it('has default message when none provided', () => {
    expect(new UnknownError().message).toBe('An unknown error occurred');
  });

  it('accepts optional cause', () => {
    const cause = new Error('root');
    const err = new UnknownError({ cause });
    expect(err.cause).toBe(cause);
  });

  it('accepts optional context and message override', () => {
    const err = new UnknownError({
      message: 'custom',
      context: { op: 'fetch' },
    });
    expect(err.message).toBe('custom');
    expect(err.context).toEqual({ op: 'fetch' });
  });
});
