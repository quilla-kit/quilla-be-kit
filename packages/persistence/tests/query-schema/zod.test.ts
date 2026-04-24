import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createQueryParametersSchema } from '../../src/query-schema/zod.js';

type Filters = {
  name?: string;
  isActive?: boolean;
  createdAt?: Date;
  age?: number;
};

const filterShape = z.object({
  name: z.string().optional(),
  isActive: z.boolean().optional(),
  createdAt: z.coerce.date().optional(),
  age: z.coerce.number().optional(),
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
