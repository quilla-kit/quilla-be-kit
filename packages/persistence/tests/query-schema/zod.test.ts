import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createQueryParametersSchema } from '../../src/query-schema/zod.js';

type Filters = {
  name?: string;
  isActive?: boolean;
  createdAt?: Date;
  age?: number;
  status?: 'PENDING' | 'ACTIVE' | 'CLOSED';
};

const filterShape = z.object({
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.coerce.date().optional(),
  age: z.coerce.number().optional(),
  status: z.enum(['PENDING', 'ACTIVE', 'CLOSED']).optional(),
}) as z.ZodObject<{ [K in keyof Filters]: z.ZodType<Filters[K]> }>;

const schema = createQueryParametersSchema<Filters>(filterShape);

describe('createQueryParametersSchema', () => {
  it('returns an empty filters object when no filter params are given', () => {
    const result = schema.parse({});
    expect(result).toEqual({ filters: {} });
  });

  it('parses equality filters', () => {
    const result = schema.parse({ name: 'Ada' });
    expect(result.filters).toEqual({ name: 'Ada' });
  });

  it('parses suffix-DSL filters', () => {
    const result = schema.parse({
      name__contains: 'Ad',
      age__gte: '18',
      createdAt__lt: '2026-01-01',
    });
    expect(result.filters?.name__contains).toBe('Ad');
    expect(result.filters?.age__gte).toBe(18);
    expect(result.filters?.createdAt__lt).toBeInstanceOf(Date);
  });

  it('parses comma-separated _in / _notIn values', () => {
    const result = schema.parse({ name__in: 'ada,lin,grace' });
    expect(result.filters?.name__in).toEqual(['ada', 'lin', 'grace']);
  });

  it('parses isNull / isNotNull as boolean', () => {
    const result = schema.parse({ name__isNull: 'true', age__isNotNull: 'false' });
    expect(result.filters?.name__isNull).toBe(true);
    expect(result.filters?.age__isNotNull).toBe(false);
  });

  it('parses pagination with defaults and bounds', () => {
    const result = schema.parse({ page: '3', pageSize: '50' });
    expect(result.pagination).toEqual({ page: 3, pageSize: 50 });
  });

  it('clamps pageSize to maxPageSize', () => {
    const bounded = createQueryParametersSchema<Filters>(filterShape, { maxPageSize: 100 });
    const result = bounded.parse({ page: '1', pageSize: '999' });
    expect(result.pagination).toEqual({ page: 1, pageSize: 100 });
  });

  it('omits pagination when neither page nor pageSize is given', () => {
    const result = schema.parse({ name: 'Ada' });
    expect(result.pagination).toBeUndefined();
  });

  it('parses sort directives from "field:dir" strings', () => {
    const result = schema.parse({ sort: ['name:asc', 'createdAt:desc'] });
    expect(result.sort).toEqual([{ name: 'asc' }, { createdAt: 'desc' }]);
  });

  it('drops sort entries pointing at unknown fields or bad directions', () => {
    const result = schema.parse({ sort: ['unknown:asc', 'name:sideways', 'name:asc'] });
    expect(result.sort).toEqual([{ name: 'asc' }]);
  });

  it('strips unknown keys', () => {
    const result = schema.parse({ name: 'Ada', random: 'garbage' });
    expect(result.filters).toEqual({ name: 'Ada' });
  });
});

describe('createQueryParametersSchema — strict mode', () => {
  const strictSchema = createQueryParametersSchema<Filters>(filterShape, { strict: true });

  it('rejects unknown query keys', () => {
    expect(() => strictSchema.parse({ name: 'Ada', random: 'garbage' })).toThrow();
  });

  it('rejects unknown sort fields', () => {
    expect(() => strictSchema.parse({ sort: 'unknown:asc' })).toThrow(/Unknown sort field/);
  });

  it('rejects bad sort directions', () => {
    expect(() => strictSchema.parse({ sort: 'name:sideways' })).toThrow(/Invalid sort direction/);
  });

  it('rejects non-positive / non-numeric page', () => {
    expect(() => strictSchema.parse({ page: '-1' })).toThrow(/Invalid page/);
    expect(() => strictSchema.parse({ page: 'abc' })).toThrow(/Invalid page/);
  });

  it('rejects non-positive / non-numeric pageSize', () => {
    expect(() => strictSchema.parse({ pageSize: '0' })).toThrow(/Invalid pageSize/);
    expect(() => strictSchema.parse({ pageSize: 'xyz' })).toThrow(/Invalid pageSize/);
  });

  it('still clamps pageSize to maxPageSize without throwing (bounds, not validation)', () => {
    const bounded = createQueryParametersSchema<Filters>(filterShape, {
      strict: true,
      maxPageSize: 100,
    });
    const result = bounded.parse({ page: '1', pageSize: '999' });
    expect(result.pagination).toEqual({ page: 1, pageSize: 100 });
  });

  it('passes valid input through unchanged', () => {
    const result = strictSchema.parse({
      name: 'Ada',
      sort: 'createdAt:desc',
      page: '2',
      pageSize: '50',
    });
    expect(result.filters).toEqual({ name: 'Ada' });
    expect(result.sort).toEqual([{ createdAt: 'desc' }]);
    expect(result.pagination).toEqual({ page: 2, pageSize: 50 });
  });
});

describe('createQueryParametersSchema — extraFields', () => {
  const withAuth = createQueryParametersSchema<Filters, { scopeId: string; userId: string }>(
    filterShape,
    {
      strict: true,
      extraFields: z.object({
        scopeId: z.string().optional(),
        userId: z.string().optional(),
      }),
    },
  );

  it('accepts the declared extra fields at the top level (not nested in filters)', () => {
    const result = withAuth.parse({ scopeId: 't1', userId: 'u1', name: 'Ada' });
    expect((result as { scopeId?: string }).scopeId).toBe('t1');
    expect((result as { userId?: string }).userId).toBe('u1');
    expect(result.filters).toEqual({ name: 'Ada' });
  });

  it('does not expand extra fields into the suffix DSL', () => {
    // scopeId__in is NOT a valid key even though scopeId is declared — extras
    // are not run through the operator expansion.
    expect(() => withAuth.parse({ scopeId__in: 't1,t2' })).toThrow();
  });

  it('passes validation when the extra fields are omitted', () => {
    const result = withAuth.parse({ name: 'Ada' });
    expect(result.filters).toEqual({ name: 'Ada' });
    expect((result as { scopeId?: string }).scopeId).toBeUndefined();
  });

  it('throws at schema-build time if an extraField collides with a reserved name', () => {
    expect(() =>
      createQueryParametersSchema<Filters, { page: string }>(filterShape, {
        extraFields: z.object({ page: z.string() }),
      }),
    ).toThrow(/collides with a reserved name/);
  });
});

describe('createQueryParametersSchema — enum fields', () => {
  it('accepts a bare enum equality filter', () => {
    const result = schema.parse({ status: 'ACTIVE' });
    expect(result.filters).toEqual({ status: 'ACTIVE' });
  });

  it('parses status__in as a string array', () => {
    const result = schema.parse({ status__in: 'ACTIVE,PENDING' });
    expect(result.filters?.status__in).toEqual(['ACTIVE', 'PENDING']);
  });

  it('parses status__notIn as a string array', () => {
    const result = schema.parse({ status__notIn: 'CLOSED' });
    expect(result.filters?.status__notIn).toEqual(['CLOSED']);
  });

  it('parses status__isNull / status__isNotNull as booleans', () => {
    const result = schema.parse({ status__isNull: 'true', status__isNotNull: 'false' });
    expect(result.filters?.status__isNull).toBe(true);
    expect(result.filters?.status__isNotNull).toBe(false);
  });

  it('accepts a bare enum equality filter in strict mode', () => {
    const strictSchema = createQueryParametersSchema<Filters>(filterShape, { strict: true });
    const result = strictSchema.parse({ status: 'ACTIVE' });
    expect(result.filters).toEqual({ status: 'ACTIVE' });
  });
});
