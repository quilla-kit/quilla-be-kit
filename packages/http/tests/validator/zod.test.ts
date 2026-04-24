import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createZodRequestValidator } from '../../src/validator/zod.js';

describe('createZodRequestValidator', () => {
  const validator = createZodRequestValidator();

  describe('validate', () => {
    it('returns success with parsed data for valid input', () => {
      const schema = z.object({ name: z.string() });
      const result = validator.validate(schema, { name: 'Ada' });
      expect(result).toEqual({ success: true, data: { name: 'Ada' } });
    });

    it('returns failure with the raw issues array on validation error', () => {
      const schema = z.object({ age: z.number() });
      const result = validator.validate(schema, { age: 'not-a-number' });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(Array.isArray(result.error)).toBe(true);
        expect(result.error.length).toBeGreaterThan(0);
      }
    });

    it('runs the extractIssues hook when provided', () => {
      const shaped = createZodRequestValidator({
        extractIssues: (err) => err.issues.map((i) => i.message),
      });
      const schema = z.object({ age: z.number() });
      const result = shaped.validate(schema, { age: 'x' });
      if (!result.success) {
        expect(result.error.every((e) => typeof e === 'string')).toBe(true);
      }
    });
  });

  describe('describeSchema', () => {
    it('enumerates keys on a bare ZodObject', () => {
      const schema = z.object({ name: z.string(), age: z.number() });
      expect(validator.describeSchema?.(schema)).toEqual({ keys: ['name', 'age'] });
    });

    it('unwraps a single transform over a ZodObject', () => {
      const schema = z.object({ name: z.string() }).transform((v) => ({ ...v, extra: true }));
      expect(validator.describeSchema?.(schema)).toEqual({ keys: ['name'] });
    });

    it('unwraps a chain of transforms', () => {
      const schema = z
        .object({ a: z.string(), b: z.string() })
        .transform((v) => v)
        .transform((v) => v);
      expect(validator.describeSchema?.(schema)).toEqual({ keys: ['a', 'b'] });
    });

    it('returns null for non-object root schemas', () => {
      expect(validator.describeSchema?.(z.string())).toBeNull();
      expect(validator.describeSchema?.(z.union([z.string(), z.number()]))).toBeNull();
      expect(validator.describeSchema?.(z.array(z.string()))).toBeNull();
    });
  });
});
