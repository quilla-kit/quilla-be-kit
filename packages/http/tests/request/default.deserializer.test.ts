import { describe, expect, it } from 'vitest';
import { DefaultRequestDeserializer } from '../../src/request/default.deserializer.js';

describe('DefaultRequestDeserializer', () => {
  it('remaps custom pagination keys onto canonical page / pageSize', () => {
    const deserializer = new DefaultRequestDeserializer({
      paginationKeys: { page: 'p', pageSize: 'per_page' },
    });
    expect(deserializer.deserializeQuery({ p: '2', per_page: '50', name: 'Ada' })).toEqual({
      page: '2',
      pageSize: '50',
      name: 'Ada',
    });
  });

  it('supports a partial override, leaving the other key at its default', () => {
    const deserializer = new DefaultRequestDeserializer({
      paginationKeys: { pageSize: 'limit' },
    });
    expect(deserializer.deserializeQuery({ page: '2', limit: '50' })).toEqual({
      page: '2',
      pageSize: '50',
    });
  });

  it('preserves array-valued query params through the remap', () => {
    const deserializer = new DefaultRequestDeserializer({
      paginationKeys: { page: 'p' },
    });
    expect(deserializer.deserializeQuery({ p: '1', tag: ['a', 'b'] })).toEqual({
      page: '1',
      tag: ['a', 'b'],
    });
  });

  it('returns the query unchanged when no pagination keys are configured', () => {
    const deserializer = new DefaultRequestDeserializer();
    const query = { page: '2', pageSize: '50', name: 'Ada' };
    // identity — same reference, no allocation, so the default path is free.
    expect(deserializer.deserializeQuery(query)).toBe(query);
  });

  it('is a no-op when a custom key equals its canonical name', () => {
    const deserializer = new DefaultRequestDeserializer({
      paginationKeys: { page: 'page', pageSize: 'pageSize' },
    });
    const query = { page: '2', pageSize: '50' };
    expect(deserializer.deserializeQuery(query)).toBe(query);
  });
});
