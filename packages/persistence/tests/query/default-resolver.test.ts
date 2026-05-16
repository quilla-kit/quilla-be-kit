import { describe, expect, it } from 'vitest';
import { DefaultColumnResolver } from '../../src/query/default.resolver.js';

describe('DefaultColumnResolver', () => {
  it('converts camelCase to snake_case', () => {
    const r = new DefaultColumnResolver();
    expect(r.resolve('createdAt')).toBe('created_at');
    expect(r.resolve('isActive')).toBe('is_active');
    expect(r.resolve('updatedBy')).toBe('updated_by');
  });

  it('leaves all-lowercase keys untouched', () => {
    const r = new DefaultColumnResolver();
    expect(r.resolve('id')).toBe('id');
    expect(r.resolve('name')).toBe('name');
  });

  it('applies explicit overrides before falling back to camel→snake', () => {
    const r = new DefaultColumnResolver({ overrides: { scopeId: 'tenant_id' } });
    expect(r.resolve('scopeId')).toBe('tenant_id');
    expect(r.resolve('createdAt')).toBe('created_at');
  });

  it('handles single-letter camel boundaries and treats acronyms as single words', () => {
    const r = new DefaultColumnResolver();
    expect(r.resolve('aB')).toBe('a_b');
    expect(r.resolve('isXY')).toBe('is_xy');
    expect(r.resolve('parseHTML')).toBe('parse_html');
  });
});
