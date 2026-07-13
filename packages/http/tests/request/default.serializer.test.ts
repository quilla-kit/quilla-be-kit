import { describe, expect, it } from 'vitest';
import { DefaultResponseSerializer } from '../../src/request/default.serializer.js';

describe('DefaultResponseSerializer', () => {
  const serializer = new DefaultResponseSerializer();

  it('strips httpCode and headers, keeping payload/error/metadata', () => {
    expect(
      serializer.serialize({
        httpCode: 200,
        headers: { 'x-foo': 'bar' },
        payload: { id: '42' },
      }),
    ).toEqual({ payload: { id: '42' } });
  });

  it('passes through error and metadata bodies unchanged', () => {
    expect(
      serializer.serialize({
        httpCode: 404,
        error: { name: 'NotFoundError', message: 'nope' },
        metadata: { pagination: { total: 3, page: 1, limit: 20 } },
      }),
    ).toEqual({
      error: { name: 'NotFoundError', message: 'nope' },
      metadata: { pagination: { total: 3, page: 1, limit: 20 } },
    });
  });

  it('returns undefined for an empty body (no payload/error/metadata)', () => {
    expect(serializer.serialize({ httpCode: 204 })).toBeUndefined();
    expect(serializer.serialize({ httpCode: 204, headers: { 'x-a': 'b' } })).toBeUndefined();
  });
});
